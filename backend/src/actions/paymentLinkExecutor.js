const { evaluatePolicy, POLICY_VERSION } = require('../policy/policyEngine');
const { createRazorpayClient, isTestModeKey } = require('../services/razorpayClient');

class RecoveryExecutorError extends Error {
  constructor(message, statusCode = 400, details = null) {
    super(message);
    this.name = 'RecoveryExecutorError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function buildStableReferenceId(recoveryCase, attemptNumber = 1) {
  const rawPaymentId = String(recoveryCase?.paymentId || `case_${recoveryCase?.id || 'unknown'}`);
  const sanitized = rawPaymentId.replace(/[^a-zA-Z0-9_-]/g, '');
  const prefix = `rc_${recoveryCase?.id || 0}_`;
  const suffix = `_v${attemptNumber}`;
  const maxTokenLen = 40 - prefix.length - suffix.length;
  const paymentToken = sanitized.length > maxTokenLen ? sanitized.slice(-maxTokenLen) : sanitized;
  return `${prefix}${paymentToken}${suffix}`;
}

async function executePaymentLink(repository, {
  recoveryCase,
  diagnosis = null,
  events = [],
  razorpayClient = createRazorpayClient(),
  referenceId = null,
  now = () => new Date()
}) {
  if (!recoveryCase) {
    throw new RecoveryExecutorError('Recovery case is required for execution.', 404);
  }

  // 1. Fetch existing actions for idempotency check and policy evaluation
  const existingActions = await repository.findActionsByCaseId(recoveryCase.id);

  // Check if an EXECUTED action already exists (idempotent shortcut)
  const existingExecuted = existingActions.find(
    (a) => a.actionType === 'CREATE_PAYMENT_LINK' && a.status === 'EXECUTED'
  );
  if (existingExecuted) {
    return {
      action: existingExecuted,
      duplicate: true,
      executed: true,
      message: 'Active Payment Link recovery action already exists for this case.'
    };
  }

  // 2. Compute stable logical execution reference
  const attemptNumber = existingActions.length + 1;
  const stableReferenceId = referenceId || buildStableReferenceId(recoveryCase, attemptNumber);

  // 3. Re-evaluate policy server-side to guarantee authority
  const isTestMode = razorpayClient.isTestMode !== undefined ? razorpayClient.isTestMode : false;
  const policyDecision = evaluatePolicy({
    recoveryCase,
    diagnosis,
    candidateAction: diagnosis?.recommendation?.action || diagnosis?.proposedAction || 'CREATE_PAYMENT_LINK',
    events,
    existingActions,
    isTestMode,
    candidateReference: stableReferenceId,
    now
  });

  // Record audit for policy evaluation prior to execution
  await repository.addAudit(recoveryCase.id, 'POLICY_EVALUATED', `Policy decision for execution: ${policyDecision.decision}`, {
    decision: policyDecision.decision,
    action: policyDecision.action,
    reasons: policyDecision.reasons,
    policyVersion: policyDecision.policyVersion
  });

  if (policyDecision.decision !== 'ALLOW') {
    const status = policyDecision.decision === 'REVIEW' ? 'REVIEW_REQUIRED' : 'BLOCKED';
    const auditType = policyDecision.decision === 'REVIEW' ? 'ACTION_REVIEW_REQUIRED' : 'ACTION_BLOCKED';
    const idempotencyKey = `razorpay_case_${recoveryCase.id}_plink_attempt_${existingActions.length + 1}`;

    const blockedAction = await repository.createAction({
      recoveryCaseId: recoveryCase.id,
      actionType: 'CREATE_PAYMENT_LINK',
      status,
      policyDecision: policyDecision.decision,
      policyVersion: policyDecision.policyVersion,
      idempotencyKey,
      provider: 'razorpay',
      amount: recoveryCase.amount,
      currency: recoveryCase.currency,
      requestMetadata: { reasons: policyDecision.reasons },
      failureReason: policyDecision.reasons.join('; ')
    });

    await repository.addAudit(recoveryCase.id, auditType, `Action execution stopped by policy: ${policyDecision.decision}`, {
      actionId: blockedAction.id,
      reasons: policyDecision.reasons
    });

    throw new RecoveryExecutorError(`Policy decision is ${policyDecision.decision}: ${policyDecision.reasons.join('; ')}`, 422, {
      policyDecision,
      action: blockedAction
    });
  }

  // 4. Ambiguous-Success Provider Lookup: Check if link already exists at Razorpay
  if (typeof razorpayClient.getPaymentLinksByReferenceId === 'function') {
    try {
      const existingLinks = await razorpayClient.getPaymentLinksByReferenceId(stableReferenceId);
      const providerLink = existingLinks?.find((link) => link.reference_id === stableReferenceId);
      if (providerLink) {
        const amountMatches = Number(providerLink.amount) === Number(recoveryCase.amount);
        const currencyMatches = String(providerLink.currency).toUpperCase() === String(recoveryCase.currency).toUpperCase();

        if (!amountMatches || !currencyMatches) {
          const discrepancyReason = `Provider Payment Link discrepancy (Amount: ${providerLink.amount} vs ${recoveryCase.amount}, Currency: ${providerLink.currency} vs ${recoveryCase.currency})`;
          await repository.addAudit(recoveryCase.id, 'ACTION_REVIEW_REQUIRED', discrepancyReason, {
            providerLinkAmount: providerLink.amount,
            expectedAmount: recoveryCase.amount,
            providerLinkCurrency: providerLink.currency,
            expectedCurrency: recoveryCase.currency
          });
          throw new RecoveryExecutorError(discrepancyReason, 422, {
            policyDecision: { decision: 'REVIEW', reasons: [discrepancyReason] }
          });
        }

        let actionRecord = existingActions.find((a) => a.idempotencyKey === stableReferenceId);
        if (!actionRecord) {
          actionRecord = await repository.createAction({
            recoveryCaseId: recoveryCase.id,
            actionType: 'CREATE_PAYMENT_LINK',
            status: 'EXECUTED',
            policyDecision: 'ALLOW',
            policyVersion: policyDecision.policyVersion,
            idempotencyKey: stableReferenceId,
            provider: 'razorpay',
            providerActionId: providerLink.id,
            paymentLinkUrl: providerLink.short_url,
            amount: recoveryCase.amount,
            currency: recoveryCase.currency,
            completedAt: new Date().toISOString(),
            responseMetadata: providerLink.rawResponse || {}
          });
        } else {
          actionRecord = await repository.updateAction(actionRecord.id, {
            status: 'EXECUTED',
            providerActionId: providerLink.id,
            paymentLinkUrl: providerLink.short_url,
            completedAt: new Date().toISOString()
          });
        }

        await repository.addAudit(recoveryCase.id, 'ACTION_EXECUTED', `Adopted existing verified Razorpay Payment Link: ${providerLink.id}`, {
          actionId: actionRecord.id,
          providerActionId: providerLink.id,
          paymentLinkUrl: providerLink.short_url,
          adoptedFromProvider: true
        });

        await repository.updateCase(recoveryCase.id, {
          actionStatus: 'ACTION_EXECUTED',
          lastEventAt: new Date().toISOString()
        });

        return {
          action: actionRecord,
          duplicate: false,
          adopted: true,
          executed: true,
          message: 'Adopted existing verified Payment Link from provider.'
        };
      }
    } catch (err) {
      if (err instanceof RecoveryExecutorError) throw err;
      // Network error during pre-check will proceed or fail in createPaymentLink
    }
  }

  // 5. Create initial EXECUTING action record
  const actionRecord = await repository.createAction({
    recoveryCaseId: recoveryCase.id,
    actionType: 'CREATE_PAYMENT_LINK',
    status: 'EXECUTING',
    policyDecision: 'ALLOW',
    policyVersion: policyDecision.policyVersion,
    idempotencyKey: stableReferenceId,
    provider: 'razorpay',
    amount: recoveryCase.amount,
    currency: recoveryCase.currency,
    createdAt: now().toISOString(),
    requestMetadata: {
      caseId: recoveryCase.id,
      paymentId: recoveryCase.paymentId,
      amount: recoveryCase.amount,
      currency: recoveryCase.currency,
      referenceId: stableReferenceId
    }
  });

  await repository.addAudit(recoveryCase.id, 'ACTION_EXECUTION_STARTED', `Started Payment Link recovery action execution (${stableReferenceId})`, {
    actionId: actionRecord.id,
    idempotencyKey: stableReferenceId
  });

  // 6. Invoke isolated Razorpay client to create Payment Link
  let result;
  try {
    result = await razorpayClient.createPaymentLink({
      amount: recoveryCase.amount,
      currency: recoveryCase.currency,
      description: `Revflow Payment Recovery for Case #${recoveryCase.id} (${recoveryCase.paymentId})`,
      referenceId: stableReferenceId
    });
  } catch (error) {
    // Check for duplicate-reference error (Branch 2: concurrent POST race)
    const isDuplicateRef = (error.statusCode === 400 || error.statusCode === 422) &&
      (error.message?.toLowerCase().includes('reference_id already exists') || error.details?.error?.description?.toLowerCase().includes('reference_id already exists'));

    if (isDuplicateRef && typeof razorpayClient.getPaymentLinksByReferenceId === 'function') {
      try {
        const recoveredLinks = await razorpayClient.getPaymentLinksByReferenceId(stableReferenceId);
        const providerLink = recoveredLinks?.find((link) => link.reference_id === stableReferenceId);
        if (providerLink) {
          const amountMatches = Number(providerLink.amount) === Number(recoveryCase.amount);
          const currencyMatches = String(providerLink.currency).toUpperCase() === String(recoveryCase.currency).toUpperCase();

          if (amountMatches && currencyMatches) {
            const adoptedAction = await repository.updateAction(actionRecord.id, {
              status: 'EXECUTED',
              providerActionId: providerLink.id,
              paymentLinkUrl: providerLink.short_url,
              completedAt: new Date().toISOString(),
              responseMetadata: providerLink.rawResponse || {}
            });

            await repository.addAudit(recoveryCase.id, 'ACTION_EXECUTED', `Adopted existing Razorpay Payment Link after concurrent duplicate response: ${providerLink.id}`, {
              actionId: adoptedAction.id,
              providerActionId: providerLink.id,
              paymentLinkUrl: providerLink.short_url,
              adoptedFromProvider: true
            });

            await repository.updateCase(recoveryCase.id, {
              actionStatus: 'ACTION_EXECUTED',
              lastEventAt: new Date().toISOString()
            });

            return {
              action: adoptedAction,
              duplicate: false,
              adopted: true,
              executed: true,
              message: 'Adopted existing Payment Link after duplicate reference response.'
            };
          }
        }
      } catch (recoverErr) {
        // Fall through to failure handling
      }
    }

    const failedAction = await repository.updateAction(actionRecord.id, {
      status: 'FAILED',
      failureReason: error.message,
      responseMetadata: error.details || {}
    });

    await repository.addAudit(recoveryCase.id, 'ACTION_EXECUTION_FAILED', `Payment Link execution failed: ${error.message}`, {
      actionId: failedAction.id,
      error: error.message
    });

    throw new RecoveryExecutorError(`Payment Link creation failed: ${error.message}`, error.statusCode || 502, {
      action: failedAction
    });
  }

  // 7. TOCTOU Post-Provider State Check
  const freshDetail = await repository.getCaseDetail(recoveryCase.id);
  const becameTerminal = ['RESOLVED', 'SUPPRESSED'].includes(freshDetail?.recoveryCase?.riskStatus) ||
    freshDetail?.events?.some((e) => ['payment.captured', 'order.paid'].includes(e.eventType));

  if (becameTerminal) {
    const supersededAction = await repository.updateAction(actionRecord.id, {
      status: 'SUPERSEDED',
      providerActionId: result.id,
      paymentLinkUrl: result.short_url,
      failureReason: 'Terminal payment arrived concurrently during provider execution. Action superseded.',
      responseMetadata: {
        id: result.id,
        short_url: result.short_url,
        status: result.status,
        reference_id: result.reference_id
      }
    });

    await repository.addAudit(recoveryCase.id, 'ACTION_BLOCKED', 'Terminal payment event arrived concurrently during provider execution. Action superseded.', {
      actionId: supersededAction.id,
      providerActionId: result.id,
      reason: 'SUPERSEDED_BY_CONCURRENT_TERMINAL_PAYMENT'
    });

    return {
      action: supersededAction,
      duplicate: false,
      executed: false,
      superseded: true,
      message: 'Action superseded by concurrent terminal payment event.'
    };
  }

  // 8. Normal Success Update
  const executedAction = await repository.updateAction(actionRecord.id, {
    status: 'EXECUTED',
    providerActionId: result.id,
    paymentLinkUrl: result.short_url,
    completedAt: new Date().toISOString(),
    responseMetadata: {
      id: result.id,
      short_url: result.short_url,
      status: result.status,
      reference_id: result.reference_id
    }
  });

  await repository.addAudit(recoveryCase.id, 'ACTION_EXECUTED', `Payment Link recovery action executed successfully: ${result.id}`, {
    actionId: executedAction.id,
    providerActionId: result.id,
    paymentLinkUrl: result.short_url,
    amount: recoveryCase.amount
  });

  await repository.updateCase(recoveryCase.id, {
    actionStatus: 'ACTION_EXECUTED',
    lastEventAt: new Date().toISOString()
  });

  return {
    action: executedAction,
    duplicate: false,
    executed: true,
    message: 'Recovery action executed successfully. Payment link generated.'
  };
}

module.exports = { executePaymentLink, RecoveryExecutorError, buildStableReferenceId };
