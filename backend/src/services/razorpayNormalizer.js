const supportedEventTypes = new Set([
  'payment.failed',
  'payment.authorized',
  'payment.captured',
  'payment.refunded',
  'order.paid',
  'payment_link.paid',
  'payment_link.partially_paid',
  'payment_link.cancelled',
  'payment_link.expired'
]);

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

  const paymentLink = payload.payload?.payment_link?.entity;
  const payment = payload.payload?.payment?.entity;
  const order = payload.payload?.order?.entity;

  if (!payment && !paymentLink && !order) {
    throw new RazorpayNormalizationError('Supported Razorpay events require a payment or payment_link entity.');
  }

  const paymentLinkId = firstString(paymentLink?.id);
  const referenceId = firstString(paymentLink?.reference_id);
  const paymentId = firstString(payment?.id, paymentLink?.id, order?.id);
  const orderId = firstString(payment?.order_id, order?.id, paymentLink?.order_id);
  const currency = firstString(paymentLink?.currency, payment?.currency, order?.currency);

  const amount = Number.isInteger(paymentLink?.amount)
    ? paymentLink.amount
    : Number.isInteger(payment?.amount)
      ? payment.amount
      : Number.isInteger(order?.amount)
        ? order.amount
        : null;

  const amountPaid = Number.isInteger(paymentLink?.amount_paid)
    ? paymentLink.amount_paid
    : Number.isInteger(payment?.amount)
      ? payment.amount
      : Number.isInteger(order?.amount_paid)
        ? order.amount_paid
        : amount;

  const timestamp = toIsoTimestamp(paymentLink?.updated_at)
    || toIsoTimestamp(paymentLink?.created_at)
    || toIsoTimestamp(payment?.created_at)
    || toIsoTimestamp(order?.created_at);

  if (!paymentId || typeof amount !== 'number' || amount < 0 || !currency || !timestamp) {
    throw new RazorpayNormalizationError('Razorpay payload entity is missing required normalized event fields.');
  }

  const paymentStatus = firstString(paymentLink?.status, payment?.status, order?.status) || eventType.split('.')[1];

  let failureReason = null;
  if (eventType === 'payment.failed') {
    failureReason = firstString(payment?.error_description, payment?.error_reason, payment?.error_code);
  }

  const customerReference = firstString(
    payment?.customer_id,
    payment?.contact,
    payment?.email,
    paymentLink?.customer?.contact,
    paymentLink?.customer?.email,
    paymentLink?.customer?.name,
    order?.customer_id,
    order?.receipt
  );

  return {
    eventId: providerEventId,
    eventType,
    paymentId,
    orderId,
    paymentLinkId,
    referenceId,
    amount,
    amountPaid,
    currency,
    paymentStatus,
    failureReason,
    customerReference,
    timestamp
  };
}

module.exports = { normalizeRazorpayWebhook, RazorpayNormalizationError, supportedEventTypes };
