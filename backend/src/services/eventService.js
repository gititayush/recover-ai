const { environment } = require('../config/env');
const { playbookEngine } = require('../playbooks/playbookEngine');
const { reconcileOutcome, isOutcomeEvent } = require('./reconciliationService');

async function processEvent(repository, event) {
  const rawPayload = event.rawPayload || event;
  const { rawPayload: ignoredRawPayload, ...normalizedEvent } = event;
  const storedEvent = await repository.createEvent({ ...normalizedEvent, rawPayload });
  if (!storedEvent) return { duplicate: true };

  // 1. Check if this is a payment outcome event that reconciles an active recovery action
  if (isOutcomeEvent(event.eventType)) {
    const reconciliation = await reconcileOutcome(repository, event);
    if (reconciliation.reconciled || reconciliation.partial || reconciliation.mismatch || reconciliation.alreadyReconciled || reconciliation.superseded) {
      return {
        duplicate: false,
        recoveryCase: reconciliation.recoveryCase,
        reconciliation,
        suppressed: false
      };
    }
  }

  const eventHistory = await repository.getEventsForPayment(event.paymentId);
  const assessment = playbookEngine.assessRisk(event, eventHistory);
  const existingCase = await repository.findCaseByPaymentId(event.paymentId);

  if (assessment.terminal) {
    if (!existingCase) return { duplicate: false, recoveryCase: null, suppressed: true };
    const wasQueuedOrActive = ['QUEUED', 'RETRY_SCHEDULED', 'CLAIMED'].includes(existingCase.autonomyStatus);
    const isPaid = assessment.outcome === 'PAID';
    const updated = await repository.updateCase(existingCase.id, {
      riskStatus: isPaid ? 'RESOLVED' : 'SUPPRESSED',
      riskReason: isPaid ? 'Payment reached a successful terminal state' : (['OPTED_OUT', 'CANCELLED'].includes(assessment.outcome) ? 'Subscription or checkout was cancelled or customer opted out' : 'Payment was refunded; recovery is suppressed'),
      riskLevel: 'LOW',
      outcome: assessment.outcome,
      autonomyStatus: isPaid ? 'COMPLETED' : 'BLOCKED',
      lockedUntil: null,
      lockedBy: null,
      lastEventAt: event.timestamp
    });
    await repository.addAudit(updated.id, 'EVENT_RECEIVED', `Received ${event.eventType}`, { eventId: event.eventId });
    await repository.addAudit(updated.id, 'CASE_UPDATED', `Case ${updated.riskStatus.toLowerCase()} after terminal event`, { eventId: event.eventId, outcome: assessment.outcome });
    if (wasQueuedOrActive && isPaid) {
      await repository.addAudit(updated.id, 'AUTONOMY_COMPLETED', 'Autonomy job completed: payment settled externally; no recovery action needed', { outcome: assessment.outcome, eventId: event.eventId });
    }
    return { duplicate: false, recoveryCase: updated, suppressed: !isPaid };
  }

  if (!assessment.actionable) {
    if (existingCase && assessment.terminalAlreadyKnown) {
      await repository.addAudit(existingCase.id, 'EVENT_RECEIVED', `Received ${event.eventType} after a terminal payment event; no recovery state was reopened`, { eventId: event.eventId, ignored: true });
    }
    return { duplicate: false, recoveryCase: existingCase, suppressed: false, ignored: assessment.terminalAlreadyKnown || false };
  }

  if (existingCase && ['RESOLVED', 'SUPPRESSED'].includes(existingCase.riskStatus)) {
    await repository.addAudit(existingCase.id, 'EVENT_RECEIVED', `Received ${event.eventType} after terminal case state; no recovery state was reopened`, { eventId: event.eventId, ignored: true });
    return { duplicate: false, recoveryCase: existingCase, suppressed: existingCase.riskStatus === 'SUPPRESSED', ignored: true };
  }

  const isAutonomyEnabled = Boolean(environment.AUTONOMOUS_RECOVERY_ENABLED);

  if (!existingCase) {
    const isDemo = event.isDemo !== undefined ? Boolean(event.isDemo) : false;
    const autonomyStatus = (!isDemo && isAutonomyEnabled && assessment.riskStatus === 'RECOVERABLE') ? 'QUEUED' : 'INACTIVE';
    const recoveryCase = await repository.createCase({
      paymentId: event.paymentId, orderId: event.orderId, amount: event.amount, currency: event.currency,
      customerReference: event.customerReference, riskStatus: assessment.riskStatus, riskReason: assessment.riskReason,
      riskLevel: assessment.riskLevel, autonomyStatus, isDemo, firstDetectedAt: event.timestamp, lastEventAt: event.timestamp
    });
    await repository.addAudit(recoveryCase.id, 'EVENT_RECEIVED', `Received ${event.eventType}`, { eventId: event.eventId });
    await repository.addAudit(recoveryCase.id, 'RISK_DETECTED', assessment.riskReason, { failureCount: assessment.failureCount, riskLevel: assessment.riskLevel });
    await repository.addAudit(recoveryCase.id, 'CASE_CREATED', 'Recovery case created', { status: recoveryCase.riskStatus });
    if (autonomyStatus === 'QUEUED') {
      await repository.addAudit(recoveryCase.id, 'AUTONOMY_QUEUED', 'Case queued for autonomous recovery worker', { paymentId: event.paymentId, riskStatus: assessment.riskStatus, riskLevel: assessment.riskLevel });
    }
    return { duplicate: false, recoveryCase };
  }

  const shouldQueue = isAutonomyEnabled &&
    !existingCase.isDemo &&
    assessment.riskStatus === 'RECOVERABLE' &&
    !['CLAIMED', 'COMPLETED', 'REVIEW_REQUIRED'].includes(existingCase.autonomyStatus);

  const updatedChanges = {
    riskStatus: assessment.riskStatus,
    riskReason: assessment.riskReason,
    riskLevel: assessment.riskLevel,
    outcome: null,
    lastEventAt: event.timestamp
  };

  if (shouldQueue) {
    updatedChanges.autonomyStatus = 'QUEUED';
  }

  const updated = await repository.updateCase(existingCase.id, updatedChanges);
  await repository.addAudit(updated.id, 'EVENT_RECEIVED', `Received ${event.eventType}`, { eventId: event.eventId });
  await repository.addAudit(updated.id, 'RISK_DETECTED', assessment.riskReason, { failureCount: assessment.failureCount, riskLevel: assessment.riskLevel });
  await repository.addAudit(updated.id, 'CASE_UPDATED', 'Recovery case updated from repeated payment failure', { status: updated.riskStatus });
  if (shouldQueue && existingCase.autonomyStatus !== 'QUEUED') {
    await repository.addAudit(updated.id, 'AUTONOMY_QUEUED', 'Case queued for autonomous recovery worker', { paymentId: event.paymentId, riskStatus: assessment.riskStatus, riskLevel: assessment.riskLevel });
  }
  return { duplicate: false, recoveryCase: updated };
}

module.exports = { processEvent };
