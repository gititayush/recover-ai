const crypto = require('crypto');
const { environment } = require('../config/env');
const logger = require('../config/logger');
const { createDiagnosisService } = require('../ai/diagnosisService');
const { createRazorpayClient } = require('../services/razorpayClient');
const { evaluatePolicy } = require('../policy/policyEngine');
const { executePaymentLink, RecoveryExecutorError } = require('../actions/paymentLinkExecutor');

function createRecoveryWorker({
  repository,
  diagnosisService = createDiagnosisService(),
  razorpayClient = createRazorpayClient(),
  pollIntervalMs = environment.AUTONOMY_WORKER_POLL_INTERVAL_MS,
  leaseSeconds = environment.AUTONOMY_WORKER_LEASE_SECONDS,
  maxRetries = environment.AUTONOMY_WORKER_MAX_RETRIES,
  baseBackoffSeconds = environment.AUTONOMY_WORKER_BASE_BACKOFF_SECONDS,
  workerId = `revflow-worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  now = () => new Date()
} = {}) {
  let isRunning = false;
  let timer = null;
  let isPolling = false;

  async function pollOnce() {
    if (!environment.AUTONOMOUS_RECOVERY_ENABLED) {
      return { processed: false, reason: 'DISABLED' };
    }

    let claimedCase = null;
    try {
      claimedCase = await repository.claimNextJob({
        workerId,
        leaseDurationSeconds: leaseSeconds,
        now: now()
      });
    } catch (err) {
      logger.error('Error claiming next autonomous recovery job', { error: err.message, workerId });
      return { processed: false, error: err.message };
    }

    if (!claimedCase) {
      return { processed: false, reason: 'NO_JOBS' };
    }

    const leaseToken = claimedCase.autonomyLeaseToken;

    await repository.addAudit(claimedCase.id, 'AUTONOMY_CLAIMED', `Worker ${workerId} claimed case for autonomous recovery`, {
      workerId,
      leaseToken,
      attempts: claimedCase.autonomyAttempts
    });

    let heartbeatTimer = null;
    const startHeartbeat = () => {
      const intervalMs = Math.max(1000, Math.floor((leaseSeconds * 1000) / 3));
      heartbeatTimer = setInterval(async () => {
        try {
          await repository.extendLease(claimedCase.id, leaseToken, {
            leaseDurationSeconds: leaseSeconds,
            now: now()
          });
        } catch (e) {
          // Ignored if lease lost or DB error
        }
      }, intervalMs);
    };

    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    startHeartbeat();

    try {
      const caseDetail = await repository.getCaseDetail(claimedCase.id);
      if (!caseDetail) {
        await repository.releaseJob(claimedCase.id, leaseToken, {
          autonomyStatus: 'FAILED',
          lastAutonomyError: 'Case detail not found'
        });
        return { processed: true, status: 'FAILED' };
      }

      const freshCase = caseDetail.recoveryCase;
      const events = caseDetail.events || [];
      const existingActions = caseDetail.actions || [];

      // 1. Authoritative Pre-Check: If case is already terminal / settled externally
      const hasTerminalEvent = events.some((e) => ['payment.captured', 'order.paid'].includes(e.eventType));
      if (['RESOLVED', 'SUPPRESSED'].includes(freshCase.riskStatus) || hasTerminalEvent) {
        await repository.releaseJob(claimedCase.id, leaseToken, {
          autonomyStatus: 'COMPLETED'
        });
        await repository.addAudit(claimedCase.id, 'AUTONOMY_COMPLETED', 'Autonomy job completed: payment settled externally; no recovery action needed', {
          riskStatus: freshCase.riskStatus,
          outcome: freshCase.outcome
        });
        return { processed: true, status: 'COMPLETED', settled: true };
      }

      // 2. AI Diagnosis Step (Fail-Closed)
      let diagnosis = await repository.findDiagnosisByCaseId(claimedCase.id);
      if (!diagnosis) {
        try {
          const decision = await diagnosisService.diagnose(caseDetail);
          diagnosis = await repository.createDiagnosis({
            recoveryCaseId: claimedCase.id,
            ...decision
          });
          await repository.addAudit(claimedCase.id, 'AI_DIAGNOSIS', `AI diagnosis accepted: ${diagnosis.recommendation.action}`, {
            cause: diagnosis.diagnosis.cause,
            confidence: diagnosis.diagnosis.confidence,
            proposedAction: diagnosis.proposedAction,
            recommendedAction: diagnosis.recommendation.action,
            promptVersion: diagnosis.promptVersion,
            provider: diagnosis.provider,
            model: diagnosis.model,
            source: diagnosis.source
          });
        } catch (aiError) {
          logger.warn('AI diagnosis failed during autonomous execution; failing closed to REVIEW_REQUIRED', {
            caseId: claimedCase.id,
            error: aiError.message
          });
          await repository.releaseJob(claimedCase.id, leaseToken, {
            autonomyStatus: 'REVIEW_REQUIRED',
            lastAutonomyError: `AI diagnosis error: ${aiError.message}`
          });
          await repository.addAudit(claimedCase.id, 'AUTONOMY_REVIEW_REQUIRED', `AI diagnosis failed (${aiError.message}). Escalated to human review.`, {
            error: aiError.message
          });
          return { processed: true, status: 'REVIEW_REQUIRED', error: aiError.message };
        }
      }

      // Explicit lease extension checkpoint between AI and provider call
      await repository.extendLease(claimedCase.id, leaseToken, {
        leaseDurationSeconds: leaseSeconds,
        now: now()
      });

      // 3. AI Confidence and Recommendation Checks
      const confidence = diagnosis?.diagnosis?.confidence;
      if (typeof confidence === 'number' && confidence < environment.AI_CONFIDENCE_THRESHOLD) {
        await repository.releaseJob(claimedCase.id, leaseToken, {
          autonomyStatus: 'REVIEW_REQUIRED',
          lastAutonomyError: `AI confidence (${confidence}) below threshold (${environment.AI_CONFIDENCE_THRESHOLD})`
        });
        await repository.addAudit(claimedCase.id, 'AUTONOMY_REVIEW_REQUIRED', `AI confidence (${confidence}) below threshold. Escalated to human review.`, {
          confidence,
          threshold: environment.AI_CONFIDENCE_THRESHOLD
        });
        return { processed: true, status: 'REVIEW_REQUIRED', lowConfidence: true };
      }

      const targetAction = diagnosis?.recommendation?.action || diagnosis?.proposedAction;
      if (targetAction === 'REQUEST_MANUAL_REVIEW') {
        await repository.releaseJob(claimedCase.id, leaseToken, {
          autonomyStatus: 'REVIEW_REQUIRED',
          lastAutonomyError: 'AI proposed manual review'
        });
        await repository.addAudit(claimedCase.id, 'AUTONOMY_REVIEW_REQUIRED', 'AI recommendation requested manual review.', {
          recommendation: diagnosis.recommendation
        });
        return { processed: true, status: 'REVIEW_REQUIRED' };
      }

      if (targetAction === 'NO_ACTION') {
        await repository.releaseJob(claimedCase.id, leaseToken, {
          autonomyStatus: 'BLOCKED',
          lastAutonomyError: 'AI proposed NO_ACTION'
        });
        await repository.addAudit(claimedCase.id, 'AUTONOMY_BLOCKED', 'AI recommendation proposed NO_ACTION. Autonomy blocked.', {
          recommendation: diagnosis.recommendation
        });
        return { processed: true, status: 'BLOCKED' };
      }

      // 4. Server-Authoritative Policy Evaluation
      const isTestMode = razorpayClient.isTestMode !== undefined ? razorpayClient.isTestMode : false;
      const policyDecision = evaluatePolicy({
        recoveryCase: freshCase,
        diagnosis,
        candidateAction: targetAction || 'CREATE_PAYMENT_LINK',
        events,
        existingActions,
        isTestMode,
        candidateReference: `REV-C${freshCase.id}-PLINK`,
        now
      });

      if (policyDecision.decision !== 'ALLOW') {
        const isWait = policyDecision.stopping?.actionDisposition === 'WAIT';
        const nextStatus = isWait
          ? 'RETRY_SCHEDULED'
          : (policyDecision.decision === 'REVIEW' ? 'REVIEW_REQUIRED' : 'BLOCKED');
        const auditEvent = policyDecision.decision === 'REVIEW' ? 'AUTONOMY_REVIEW_REQUIRED' : 'AUTONOMY_BLOCKED';
        const reasonText = policyDecision.reasons.join('; ');
        const nextRetryAt = isWait && policyDecision.stopping?.supportingFacts?.cooldownExpiresAt
          ? policyDecision.stopping.supportingFacts.cooldownExpiresAt
          : null;

        await repository.releaseJob(claimedCase.id, leaseToken, {
          autonomyStatus: nextStatus,
          nextRetryAt,
          lastAutonomyError: reasonText
        });

        // Deduplicate audit: avoid recording identical error if case was already stopped with the same reason
        const isDuplicateAudit = claimedCase.lastAutonomyError === reasonText;

        if (!isDuplicateAudit) {
          await repository.addAudit(claimedCase.id, auditEvent, `Policy decision: ${policyDecision.decision}. ${reasonText}`, {
            decision: policyDecision.decision,
            reasons: policyDecision.reasons,
            stopping: policyDecision.stopping || null
          });
        }

        return {
          processed: true,
          status: nextStatus,
          reasons: policyDecision.reasons,
          stopping: policyDecision.stopping || null
        };
      }

      // 5. Bounded Execution via Payment Link Executor (with ambiguous-success & TOCTOU protection)
      const executionResult = await executePaymentLink(repository, {
        recoveryCase: freshCase,
        diagnosis,
        events,
        razorpayClient,
        referenceId: `REV-C${freshCase.id}-PLINK`,
        now
      });

      if (executionResult.superseded) {
        // Customer paid externally during provider call
        await repository.releaseJob(claimedCase.id, leaseToken, {
          autonomyStatus: 'COMPLETED'
        });
        return { processed: true, status: 'COMPLETED', superseded: true };
      }

      if (executionResult.executed) {
        await repository.releaseJob(claimedCase.id, leaseToken, {
          autonomyStatus: 'COMPLETED'
        });
        await repository.addAudit(claimedCase.id, 'AUTONOMY_COMPLETED', 'Recovery action completed successfully.', {
          actionId: executionResult.action?.id,
          providerActionId: executionResult.action?.providerActionId,
          paymentLinkUrl: executionResult.action?.paymentLinkUrl,
          adopted: executionResult.adopted || false
        });
        return { processed: true, status: 'COMPLETED', action: executionResult.action };
      }

      await repository.releaseJob(claimedCase.id, leaseToken, {
        autonomyStatus: 'COMPLETED'
      });
      return { processed: true, status: 'COMPLETED' };

    } catch (error) {
      if (error instanceof RecoveryExecutorError && error.details?.policyDecision) {
        const decision = error.details.policyDecision.decision;
        const finalStatus = decision === 'BLOCK' ? 'BLOCKED' : 'REVIEW_REQUIRED';
        const auditType = finalStatus === 'BLOCKED' ? 'AUTONOMY_BLOCKED' : 'AUTONOMY_REVIEW_REQUIRED';

        await repository.releaseJob(claimedCase.id, leaseToken, {
          autonomyStatus: finalStatus,
          lastAutonomyError: error.message
        });

        await repository.addAudit(claimedCase.id, auditType, `Execution stopped: ${error.message}`, {
          error: error.message
        });

        return { processed: true, status: finalStatus, error: error.message };
      }

      // Explicit error classification:
      const statusCode = Number(error.statusCode || error.details?.statusCode || error.details?.originalError?.statusCode);

      // Non-retryable client, auth, or semantic errors (4xx except 429)
      const isClientError = statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 422;

      // Retryable errors:
      // - 5xx (500, 502, 503, 504)
      // - 429 (Rate limited)
      // - Network/socket errors
      const is5xx = typeof statusCode === 'number' && statusCode >= 500 && statusCode <= 599;
      const is429 = statusCode === 429;
      const networkCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
      const isNetworkError = networkCodes.has(error.code) ||
        networkCodes.has(error.details?.originalError?.code) ||
        error.name === 'FetchError' ||
        error.name === 'TimeoutError' ||
        error.message?.toLowerCase().includes('timeout') ||
        error.message?.toLowerCase().includes('network failure') ||
        error.message?.toLowerCase().includes('fetch failed');

      const isRetryable = !isClientError && (is5xx || is429 || isNetworkError);
      const canRetry = isRetryable && claimedCase.autonomyAttempts < maxRetries;

      if (canRetry) {
        const backoffSeconds = baseBackoffSeconds * Math.pow(2, claimedCase.autonomyAttempts - 1);
        await repository.scheduleRetry(claimedCase.id, leaseToken, {
          backoffSeconds,
          error: error.message,
          now: now()
        });

        await repository.addAudit(claimedCase.id, 'AUTONOMY_RETRY', `Transient error: ${error.message}. Retry scheduled.`, {
          error: error.message,
          attempt: claimedCase.autonomyAttempts,
          backoffSeconds
        });

        return { processed: true, status: 'RETRY_SCHEDULED', attempt: claimedCase.autonomyAttempts };
      }

      const finalFailStatus = claimedCase.autonomyAttempts >= maxRetries ? 'FAILED' : 'REVIEW_REQUIRED';
      const failAudit = finalFailStatus === 'FAILED' ? 'AUTONOMY_FAILED' : 'AUTONOMY_REVIEW_REQUIRED';

      await repository.releaseJob(claimedCase.id, leaseToken, {
        autonomyStatus: finalFailStatus,
        lastAutonomyError: error.message
      });

      await repository.addAudit(claimedCase.id, failAudit, `Recovery attempt failed: ${error.message}`, {
        error: error.message,
        attempts: claimedCase.autonomyAttempts
      });

      return { processed: true, status: finalFailStatus, error: error.message };
    } finally {
      stopHeartbeat();
    }
  }

  function tick() {
    if (!isRunning) return;
    if (isPolling) return;
    isPolling = true;

    pollOnce()
      .catch((err) => {
        logger.error('Unhandled error in autonomous recovery worker poll cycle', { error: err.message });
      })
      .finally(() => {
        isPolling = false;
        if (isRunning) {
          timer = setTimeout(tick, pollIntervalMs);
        }
      });
  }

  return {
    start() {
      if (isRunning) return;
      isRunning = true;
      logger.info('Starting Revflow autonomous recovery worker', { workerId, pollIntervalMs, leaseSeconds });
      timer = setTimeout(tick, 100);
    },

    stop() {
      isRunning = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      logger.info('Stopped Revflow autonomous recovery worker', { workerId });
    },

    pollOnce,
    get isRunning() { return isRunning; },
    get workerId() { return workerId; }
  };
}

module.exports = { createRecoveryWorker };
