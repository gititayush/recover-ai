function latestEvent(events, eventType) {
  return [...events].reverse().find((event) => event.eventType === eventType) || null;
}

function buildCaseContext(detail, now = new Date()) {
  const { recoveryCase, events } = detail;
  const lastEvent = events.at(-1) || null;
  const lastFailure = latestEvent(events, 'payment.failed');
  const failureCount = events.filter((event) => event.eventType === 'payment.failed').length;
  const timeSinceFailureMinutes = lastFailure
    ? Math.max(0, Math.floor((now.getTime() - new Date(lastFailure.timestamp || lastFailure.occurredAt).getTime()) / 60000))
    : null;

  const hasPriorSuccess = events.some((event) => ['captured', 'paid', 'authorized'].includes(event.paymentStatus) || event.eventType === 'order.paid');
  const hasOrder = Boolean(recoveryCase.orderId || events.some((event) => Boolean(event.orderId)));

  let errorCode = null;
  if (lastFailure) {
    if (lastFailure.errorCode) {
      errorCode = lastFailure.errorCode;
    } else if (lastFailure.rawPayload && typeof lastFailure.rawPayload === 'object') {
      errorCode = lastFailure.rawPayload.error_code || lastFailure.rawPayload?.payload?.payment?.entity?.error_code || null;
    }
  }

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
    errorCode,
    paymentAttemptCount: failureCount,
    timeSinceFailureMinutes,
    hasOrder,
    hasPriorSuccess,
    recentEvents: events.slice(-5).map((event) => ({
      eventType: event.eventType,
      paymentStatus: event.paymentStatus,
      failureReason: event.failureReason || null,
      timestamp: event.timestamp || event.occurredAt
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
    'case.hasOrder': String(context.hasOrder),
    'case.hasPriorSuccess': String(context.hasPriorSuccess),
    'payment.status': context.paymentStatus,
    'payment.failureReason': context.failureReason,
    'payment.errorCode': context.errorCode,
    'payment.attemptCount': String(context.paymentAttemptCount),
    'payment.timeSinceFailureMinutes': context.timeSinceFailureMinutes === null ? null : String(context.timeSinceFailureMinutes),
    'order.status': context.orderStatus
  };
}

module.exports = { buildCaseContext, contextFacts };
