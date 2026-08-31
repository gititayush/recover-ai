function latestEvent(events, eventType) {
  return [...events].reverse().find((event) => event.eventType === eventType) || null;
}

function buildCaseContext(detail, now = new Date()) {
  const { recoveryCase, events } = detail;
  const lastEvent = events.at(-1) || null;
  const lastFailure = latestEvent(events, 'payment.failed');
  const failureCount = events.filter((event) => event.eventType === 'payment.failed').length;
  const timeSinceFailureMinutes = lastFailure
    ? Math.max(0, Math.floor((now.getTime() - new Date(lastFailure.timestamp).getTime()) / 60000))
    : null;

  return {
    caseId: recoveryCase.id,
    amount: recoveryCase.amount,
    currency: recoveryCase.currency,
    caseStatus: recoveryCase.riskStatus,
    riskLevel: recoveryCase.riskLevel,
    riskReason: recoveryCase.riskReason,
    paymentStatus: lastEvent?.paymentStatus || null,
    orderStatus: events.some((event) => event.eventType === 'order.paid') ? 'paid' : null,
    failureReason: lastFailure?.failureReason || null,
    paymentAttemptCount: failureCount,
    timeSinceFailureMinutes,
    recentEvents: events.slice(-5).map((event) => ({
      eventType: event.eventType,
      paymentStatus: event.paymentStatus,
      failureReason: event.failureReason || null,
      timestamp: event.timestamp
    }))
  };
}

function contextFacts(context) {
  return {
    'case.amount': String(context.amount),
    'case.currency': context.currency,
    'case.status': context.caseStatus,
    'case.riskLevel': context.riskLevel,
    'case.riskReason': context.riskReason,
    'payment.status': context.paymentStatus,
    'payment.failureReason': context.failureReason,
    'payment.attemptCount': String(context.paymentAttemptCount),
    'payment.timeSinceFailureMinutes': context.timeSinceFailureMinutes === null ? null : String(context.timeSinceFailureMinutes),
    'order.status': context.orderStatus
  };
}

module.exports = { buildCaseContext, contextFacts };
