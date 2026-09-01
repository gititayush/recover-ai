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

async function executePaymentLink(repository, {
  recoveryCase,
  diagnosis = null,
  events = [],
  razorpayClient = createRazorpayClient(),
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

  // 2. Re-evaluate policy server-side to guarantee authority
  const isTestMode = razorpayClient.isTestMode !== undefined ? razorpayClient.isTestMode : false;
  const policyDecision = evaluatePolicy({
    recoveryCase,
    diagnosis,
    candidateAction: 'CREATE_PAYMENT_LINK',
    events,
    existingActions,
    isTestMode,
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

  // 3. Generate deterministic idempotency key for this attempt
  const attemptNumber = existingActions.length + 1;
  const idempotencyKey = `razorpay_case_${recoveryCase.id}_plink_v${attemptNumber}`;

  // 4. Create initial EXECUTING action record
  const actionRecord = await repository.createAction({
    recoveryCaseId: recoveryCase.id,
    actionType: 'CREATE_PAYMENT_LINK',
    status: 'EXECUTING',
    policyDecision: 'ALLOW',
    policyVersion: policyDecision.policyVersion,
    idempotencyKey,
    provider: 'razorpay',
    amount: recoveryCase.amount,
    currency: recoveryCase.currency,
    createdAt: now().toISOString(),
    requestMetadata: {
      caseId: recoveryCase.id,
      paymentId: recoveryCase.paymentId,
      amount: recoveryCase.amount,
      currency: recoveryCase.currency,
      attemptNumber
    }
  });

  await repository.addAudit(recoveryCase.id, 'ACTION_EXECUTION_STARTED', `Started Payment Link recovery action execution (Attempt #${attemptNumber})`, {
    actionId: actionRecord.id,
    idempotencyKey
  });

  // 5. Invoke isolated Razorpay client to create Payment Link
  try {
    const result = await razorpayClient.createPaymentLink({
      amount: recoveryCase.amount,
      currency: recoveryCase.currency,
      description: `Revflow Payment Recovery for Case #${recoveryCase.id} (${recoveryCase.paymentId})`,
      referenceId: idempotencyKey
    });

    // 6. Update action record on success
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
  } catch (error) {
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
}

module.exports = { executePaymentLink, RecoveryExecutorError };
