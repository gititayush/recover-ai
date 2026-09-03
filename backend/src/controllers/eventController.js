const { z } = require('zod');
const { processEvent } = require('../services/eventService');

const ALLOWED_EVENT_TYPES = [
  'payment.failed',
  'payment.authorized',
  'payment.captured',
  'payment.succeeded',
  'order.paid',
  'payment.refunded',
  'checkout.started',
  'checkout.progress',
  'checkout.payment_step_reached',
  'checkout.abandoned',
  'checkout.drop_off',
  'checkout.completed',
  'checkout.cancelled',
  'subscription.created',
  'subscription.renewal_due',
  'subscription.renewal_failed',
  'subscription.charged',
  'subscription.cancelled',
  'subscription.paused',
  'subscription.resumed',
  'subscription.expired',
  'invoice.created',
  'invoice.due',
  'invoice.overdue',
  'invoice.payment_failed',
  'invoice.paid',
  'invoice.disputed',
  'invoice.cancelled'
];

const eventSchema = z.object({
  eventId: z.string().trim().min(1).max(128),
  eventType: z.enum(ALLOWED_EVENT_TYPES),
  paymentId: z.string().trim().min(1).max(128),
  orderId: z.string().trim().min(1).max(128).nullable().optional(),
  amount: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  paymentStatus: z.string().trim().min(1).max(64).optional(),
  failureReason: z.string().trim().min(1).max(256).nullable().optional(),
  customerReference: z.string().trim().min(1).max(128).nullable().optional(),
  timestamp: z.string().datetime({ offset: true }),
  checkoutStage: z.string().trim().max(64).optional(),
  cartReference: z.string().trim().max(128).optional(),
  subscriptionId: z.string().trim().max(128).optional(),
  billingCycle: z.string().trim().max(64).optional(),
  attemptNumber: z.number().int().nonnegative().optional(),
  invoiceId: z.string().trim().max(128).optional(),
  dueDate: z.string().datetime({ offset: true }).optional(),
  daysOverdue: z.number().int().optional(),
  playbook: z.string().trim().max(64).optional(),
  rawPayload: z.record(z.any()).optional()
}).strict();

function normalizeEvent(input) {
  const event = eventSchema.parse(input);
  return {
    ...event,
    orderId: event.orderId ?? null,
    customerReference: event.customerReference ?? event.cartReference ?? null,
    failureReason: event.failureReason ?? null,
    paymentStatus: event.paymentStatus || (event.eventType.includes('.') ? event.eventType.split('.')[1] : event.eventType),
    rawPayload: event.rawPayload || input
  };
}

function createEventController(repository) {
  return async (request, response, next) => {
    try {
      const result = await processEvent(repository, normalizeEvent(request.body));
      if (result.duplicate) return response.status(200).json({ accepted: true, duplicate: true, message: 'Event was already processed.' });
      return response.status(201).json({ accepted: true, duplicate: false, recoveryCase: result.recoveryCase, suppressed: result.suppressed || false });
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { createEventController };
