const { playbookEngine } = require('../playbooks/playbookEngine');
const { extractProviderEvidence } = require('./failureTaxonomy');

function latestEvent(events, eventType) {
  return [...events].reverse().find((event) => event.eventType === eventType) || null;
}

function buildCaseContext(detail, now = new Date()) {
  const { recoveryCase, events = [] } = detail;
  const lastEvent = events.at(-1) || null;
  const activePlaybook = playbookEngine.identifyPlaybook(lastEvent || { playbook: recoveryCase?.playbook });
  const playbook = activePlaybook?.id || 'payment_degradation';
  const lastFailure = latestEvent(events, 'payment.failed');
  const failureCount = events.filter((event) => event.eventType === 'payment.failed').length;

  const lastDropOff = latestEvent(events, 'checkout.abandoned')
    || latestEvent(events, 'checkout.drop_off')
    || latestEvent(events, 'checkout.payment_step_reached')
    || (lastEvent?.eventType?.startsWith('checkout.') ? lastEvent : null);

  const lastSubscriptionFailure = latestEvent(events, 'subscription.renewal_failed')
    || (lastEvent?.eventType?.startsWith('subscription.') ? lastEvent : null);

  const lastInvoiceFailure = latestEvent(events, 'invoice.payment_failed')
    || latestEvent(events, 'invoice.overdue')
    || (lastEvent?.eventType?.startsWith('invoice.') ? lastEvent : null);

  const lastActionable = lastFailure || lastDropOff || lastSubscriptionFailure || lastInvoiceFailure;

  const timeSinceFailureMinutes = lastActionable
    ? Math.max(0, Math.floor((now.getTime() - new Date(lastActionable.timestamp || lastActionable.occurredAt).getTime()) / 60000))
    : null;

  const hasPriorSuccess = events.some((event) =>
    ['captured', 'paid', 'authorized'].includes(event.paymentStatus) ||
    event.eventType === 'order.paid' ||
    event.eventType === 'checkout.completed' ||
    event.eventType === 'subscription.charged' ||
    event.eventType === 'invoice.paid'
  );
  const hasOrder = Boolean(recoveryCase.orderId || events.some((event) => Boolean(event.orderId)));

  const primaryEvent = lastFailure || lastActionable || lastEvent || {};
  const providerEvidence = extractProviderEvidence(primaryEvent.rawPayload || {}, primaryEvent);

  let errorCode = providerEvidence.providerErrorCode;
  if (!errorCode && lastFailure?.errorCode) {
    errorCode = lastFailure.errorCode;
  }

  const failureReason = lastFailure?.failureReason
    || providerEvidence.failureReason
    || lastDropOff?.failureReason
    || lastDropOff?.rawPayload?.abandonmentReason
    || lastSubscriptionFailure?.failureReason
    || lastSubscriptionFailure?.rawPayload?.failureReason
    || lastSubscriptionFailure?.rawPayload?.mandateFailureReason
    || lastInvoiceFailure?.failureReason
    || lastInvoiceFailure?.rawPayload?.failureReason
    || recoveryCase.riskReason
    || null;

  return {
    playbook,
    caseId: recoveryCase.id,
    amount: recoveryCase.amount,
    currency: recoveryCase.currency,
    caseStatus: recoveryCase.riskStatus,
    riskLevel: recoveryCase.riskLevel,
    riskReason: recoveryCase.riskReason,
    paymentStatus: lastEvent?.paymentStatus || null,
    orderStatus: events.some((event) => event.eventType === 'order.paid' || event.eventType === 'checkout.completed' || event.eventType === 'subscription.charged' || event.eventType === 'invoice.paid') ? 'paid' : null,
    failureReason,
    errorCode,
    providerErrorCode: providerEvidence.providerErrorCode,
    providerErrorSource: providerEvidence.providerErrorSource,
    providerErrorStep: providerEvidence.providerErrorStep,
    providerErrorDescription: providerEvidence.providerErrorDescription,
    paymentMethod: providerEvidence.paymentMethod,
    failureSignature: providerEvidence.failureSignature,
    evidenceStrength: providerEvidence.evidenceStrength,
    providerEvidence,
    paymentAttemptCount: failureCount,
    timeSinceFailureMinutes,
    hasOrder,
    hasPriorSuccess,
    recentEvents: events.slice(-5).map((event) => ({
      eventType: event.eventType,
      paymentStatus: event.paymentStatus,
      failureReason: event.failureReason || event.rawPayload?.abandonmentReason || null,
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
    'order.status': context.orderStatus,
    'provider.errorCode': context.providerErrorCode,
    'provider.errorSource': context.providerErrorSource,
    'provider.errorStep': context.providerErrorStep,
    'provider.errorDescription': context.providerErrorDescription,
    'provider.paymentMethod': context.paymentMethod,
    'provider.evidenceStrength': context.evidenceStrength,
    'provider.failureSignature': context.failureSignature
  };
}

module.exports = { buildCaseContext, contextFacts };
