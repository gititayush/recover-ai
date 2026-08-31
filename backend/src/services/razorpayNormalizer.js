const supportedEventTypes = new Set(['payment.failed', 'payment.authorized', 'payment.captured', 'order.paid']);

class RazorpayNormalizationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'RazorpayNormalizationError';
    this.statusCode = statusCode;
  }
}

function toIsoTimestamp(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0) || null;
}

function normalizeRazorpayWebhook(providerEventId, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RazorpayNormalizationError('Webhook JSON must be an object.');
  }
  const eventType = payload.event;
  if (typeof eventType !== 'string' || !supportedEventTypes.has(eventType)) {
    throw new RazorpayNormalizationError('Unsupported Razorpay event type.', 202);
  }

  const payment = payload.payload?.payment?.entity;
  const order = payload.payload?.order?.entity;
  if (!payment || typeof payment !== 'object') {
    throw new RazorpayNormalizationError('Supported Razorpay events require a payment entity.');
  }

  const paymentId = firstString(payment.id);
  const orderId = firstString(payment.order_id, order?.id);
  const currency = firstString(payment.currency);
  const timestamp = toIsoTimestamp(payment.created_at) || toIsoTimestamp(order?.created_at);
  if (!paymentId || !Number.isInteger(payment.amount) || payment.amount < 0 || !currency || !timestamp) {
    throw new RazorpayNormalizationError('Razorpay payment entity is missing required normalized event fields.');
  }

  return {
    eventId: providerEventId,
    eventType,
    paymentId,
    orderId,
    amount: payment.amount,
    currency,
    paymentStatus: firstString(payment.status) || eventType.split('.')[1],
    failureReason: eventType === 'payment.failed'
      ? firstString(payment.error_description, payment.error_reason, payment.error_code)
      : null,
    customerReference: firstString(payment.customer_id, payment.contact, payment.email, order?.customer_id, order?.receipt),
    timestamp
  };
}

module.exports = { normalizeRazorpayWebhook, RazorpayNormalizationError, supportedEventTypes };
