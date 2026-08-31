const { assessRisk } = require('../risk/detector');

async function processEvent(repository, event) {
  const rawPayload = event.rawPayload || event;
  const { rawPayload: ignoredRawPayload, ...normalizedEvent } = event;
  const storedEvent = await repository.createEvent({ ...normalizedEvent, rawPayload });
  if (!storedEvent) return { duplicate: true };

  const eventHistory = await repository.getEventsForPayment(event.paymentId);
  const assessment = assessRisk(event, eventHistory);
  const existingCase = await repository.findCaseByPaymentId(event.paymentId);

  if (assessment.terminal) {
    if (!existingCase) return { duplicate: false, recoveryCase: null, suppressed: true };
    const updated = await repository.updateCase(existingCase.id, {
      riskStatus: assessment.outcome === 'PAID' ? 'RESOLVED' : 'SUPPRESSED',
      riskReason: assessment.outcome === 'PAID' ? 'Payment reached a successful terminal state' : 'Payment was refunded; recovery is suppressed',
      riskLevel: 'LOW', outcome: assessment.outcome, lastEventAt: event.timestamp
    });
    await repository.addAudit(updated.id, 'EVENT_RECEIVED', `Received ${event.eventType}`, { eventId: event.eventId });
    await repository.addAudit(updated.id, 'CASE_UPDATED', `Case ${updated.riskStatus.toLowerCase()} after terminal event`, { eventId: event.eventId, outcome: assessment.outcome });
    return { duplicate: false, recoveryCase: updated, suppressed: assessment.outcome === 'REFUNDED' };
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

  if (!existingCase) {
    const recoveryCase = await repository.createCase({
      paymentId: event.paymentId, orderId: event.orderId, amount: event.amount, currency: event.currency,
      customerReference: event.customerReference, riskStatus: assessment.riskStatus, riskReason: assessment.riskReason,
      riskLevel: assessment.riskLevel, firstDetectedAt: event.timestamp, lastEventAt: event.timestamp
    });
    await repository.addAudit(recoveryCase.id, 'EVENT_RECEIVED', `Received ${event.eventType}`, { eventId: event.eventId });
    await repository.addAudit(recoveryCase.id, 'RISK_DETECTED', assessment.riskReason, { failureCount: assessment.failureCount, riskLevel: assessment.riskLevel });
    await repository.addAudit(recoveryCase.id, 'CASE_CREATED', 'Recovery case created', { status: recoveryCase.riskStatus });
    return { duplicate: false, recoveryCase };
  }

  const updated = await repository.updateCase(existingCase.id, {
    riskStatus: assessment.riskStatus, riskReason: assessment.riskReason, riskLevel: assessment.riskLevel,
    outcome: null, lastEventAt: event.timestamp
  });
  await repository.addAudit(updated.id, 'EVENT_RECEIVED', `Received ${event.eventType}`, { eventId: event.eventId });
  await repository.addAudit(updated.id, 'RISK_DETECTED', assessment.riskReason, { failureCount: assessment.failureCount, riskLevel: assessment.riskLevel });
  await repository.addAudit(updated.id, 'CASE_UPDATED', 'Recovery case updated from repeated payment failure', { status: updated.riskStatus });
  return { duplicate: false, recoveryCase: updated };
}

module.exports = { processEvent };
