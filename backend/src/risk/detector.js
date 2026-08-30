const terminalEventTypes = new Set(['payment.captured', 'payment.succeeded', 'order.paid', 'payment.refunded']);

function assessRisk(event, eventHistory) {
  if (terminalEventTypes.has(event.eventType)) {
    return { terminal: true, outcome: event.eventType === 'payment.refunded' ? 'REFUNDED' : 'PAID' };
  }

  if (event.eventType !== 'payment.failed') return { terminal: false, actionable: false };

  const failureCount = eventHistory.filter((item) => item.eventType === 'payment.failed').length;
  return {
    terminal: false,
    actionable: true,
    failureCount,
    riskStatus: 'RECOVERABLE',
    riskLevel: failureCount > 1 ? 'HIGH' : 'MEDIUM',
    riskReason: failureCount > 1
      ? `Repeated payment failure (${failureCount} attempts): ${event.failureReason || 'unspecified'}`
      : `Non-terminal payment failure: ${event.failureReason || 'unspecified'}`
  };
}

module.exports = { assessRisk };
