/**
 * Revflow V2 — Simulated Action Executor
 *
 * Executes bounded simulated and advisory recovery interventions without
 * triggering external financial transactions or live payment provider side-effects.
 *
 * SAFETY INVARIANTS:
 * - NEVER calls Razorpay API or external network gateways
 * - NEVER mutates case recovered_amount
 * - NEVER creates confirmed provider recovery outcomes
 * - Fully governed by Revflow's Stopping and Policy engines
 * - Produces idempotent execution records and audit trail
 */

const { evaluatePolicy } = require('../policy/policyEngine');
const { getStrategy, EXECUTION_MODES } = require('../strategies/strategyRegistry');

class SimulatedActionExecutorError extends Error {
  constructor(message, statusCode = 422, details = null) {
    super(message);
    this.name = 'SimulatedActionExecutorError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

async function executeSimulatedAction(repository, {
  recoveryCase,
  diagnosis = null,
  actionType,
  events = [],
  now = () => new Date()
}) {
  if (!recoveryCase) {
    throw new SimulatedActionExecutorError('Recovery case is required for execution.', 404);
  }

  const targetAction = actionType || diagnosis?.recommendation?.action || diagnosis?.proposedAction || 'CHECKOUT_RECOVERY';
  const strategy = getStrategy(targetAction);

  if (!strategy || strategy.executionMode !== EXECUTION_MODES.SIMULATED) {
    throw new SimulatedActionExecutorError(`Action '${targetAction}' is not a valid simulated strategy.`, 422);
  }

  // 1. Fetch existing actions for idempotency check and policy evaluation
  const existingActions = await repository.findActionsByCaseId(recoveryCase.id);

  // Check if an EXECUTED action of this type already exists for idempotency
  const existingExecuted = existingActions.find(
    (a) => a.actionType === targetAction && a.status === 'EXECUTED'
  );
  if (existingExecuted) {
    return {
      action: existingExecuted,
      duplicate: true,
      executed: true,
      isSimulated: true,
      message: `Active simulated action '${targetAction}' already exists for this case.`
    };
  }

  // 2. Generate stable logical execution reference
  const attemptNumber = existingActions.length + 1;
  const idempotencyKey = `sim_${recoveryCase.id}_${targetAction.toLowerCase()}_v${attemptNumber}`;

  // 3. Evaluate policy
  const policyDecision = evaluatePolicy({
    recoveryCase,
    diagnosis,
    candidateAction: targetAction,
    events,
    existingActions,
    candidateReference: idempotencyKey,
    allowSimulated: true,
    now
  });

  await repository.addAudit(recoveryCase.id, 'POLICY_EVALUATED', `Policy decision for simulated execution: ${policyDecision.decision}`, {
    decision: policyDecision.decision,
    action: targetAction,
    reasons: policyDecision.reasons,
    policyVersion: policyDecision.policyVersion
  });

  if (policyDecision.decision !== 'ALLOW') {
    const status = policyDecision.decision === 'REVIEW' ? 'REVIEW_REQUIRED' : 'BLOCKED';
    const auditType = policyDecision.decision === 'REVIEW' ? 'ACTION_REVIEW_REQUIRED' : 'ACTION_BLOCKED';

    const blockedAction = await repository.createAction({
      recoveryCaseId: recoveryCase.id,
      actionType: targetAction,
      status,
      policyDecision: policyDecision.decision,
      policyVersion: policyDecision.policyVersion,
      idempotencyKey,
      provider: 'simulated',
      amount: recoveryCase.amount,
      currency: recoveryCase.currency,
      requestMetadata: { reasons: policyDecision.reasons, strategy: targetAction },
      failureReason: policyDecision.reasons.join('; ')
    });

    await repository.addAudit(recoveryCase.id, auditType, `Simulated action ${targetAction} was ${status.toLowerCase()}`, {
      actionId: blockedAction.id,
      actionType: targetAction,
      reasons: policyDecision.reasons
    });

    throw new SimulatedActionExecutorError(`Simulated action '${targetAction}' blocked by policy: ${policyDecision.reasons.join('; ')}`, 422, {
      policyDecision
    });
  }

  // 4. Create EXECUTED simulated action
  const retryDelayHours = strategy.parameters?.retryDelayHours || 48;
  const nextRetryTimestamp = targetAction === 'SCHEDULE_RETRY_WINDOW'
    ? new Date(now().getTime() + retryDelayHours * 3600 * 1000).toISOString()
    : null;

  const requestMetadata = {
    strategy: targetAction,
    strategyName: strategy.name,
    executionMode: strategy.executionMode,
    isSimulated: true,
    proposedNextStep: targetAction === 'SCHEDULE_RETRY_WINDOW'
      ? `Schedule secondary subscription auto-debit retry window at ${nextRetryTimestamp} (configurable merchant policy: +${retryDelayHours}h)`
      : (targetAction === 'INVOICE_REMINDER'
          ? 'Issue structured corporate accounts receivable reminder referencing invoice payment terms'
          : (targetAction === 'CHECKOUT_RECOVERY'
              ? 'Preserve customer cart items and generate personalized recovery session link'
              : (targetAction === 'CUSTOMER_OUTREACH' ? 'Dispatch customer reminder notification across verified channels' : 'Execute simulated advisory workflow'))),
    retrySchedule: targetAction === 'SCHEDULE_RETRY_WINDOW' ? {
      attemptNumber,
      nextRetryAt: nextRetryTimestamp,
      cooldownHours: 24,
      policy: `merchant_configured_backoff_+${retryDelayHours}h`
    } : null,
    domainContext: {
      caseId: recoveryCase.id,
      amount: recoveryCase.amount,
      currency: recoveryCase.currency,
      customerReference: recoveryCase.customerReference,
      invoiceId: targetAction === 'INVOICE_REMINDER' ? recoveryCase.paymentId : undefined
    }
  };

  const responseMetadata = {
    simulated: true,
    executedAt: now().toISOString(),
    nextRetryAt: nextRetryTimestamp,
    externalApiCalled: false,
    provider: 'simulated',
    recoveredAmount: 0,
    notice: 'Simulated action executed in advisory mode; no external payment provider was contacted.'
  };

  const createdAction = await repository.createAction({
    recoveryCaseId: recoveryCase.id,
    actionType: targetAction,
    status: 'EXECUTED',
    policyDecision: 'ALLOW',
    policyVersion: policyDecision.policyVersion,
    idempotencyKey,
    provider: 'simulated',
    providerActionId: `sim_act_${recoveryCase.id}_${attemptNumber}`,
    amount: recoveryCase.amount,
    currency: recoveryCase.currency,
    requestMetadata,
    responseMetadata
  });

  await repository.addAudit(recoveryCase.id, 'ACTION_EXECUTED', `Simulated recovery action '${targetAction}' executed`, {
    actionId: createdAction.id,
    actionType: targetAction,
    isSimulated: true,
    nextRetryAt: nextRetryTimestamp
  });

  return {
    action: createdAction,
    duplicate: false,
    executed: true,
    isSimulated: true,
    message: `Simulated action '${targetAction}' successfully executed.`
  };
}

module.exports = {
  executeSimulatedAction,
  SimulatedActionExecutorError
};
