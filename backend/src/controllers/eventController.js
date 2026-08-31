const { z } = require('zod');
const { processEvent } = require('../services/eventService');

const eventSchema = z.object({
  eventId: z.string().trim().min(1).max(128),
  eventType: z.enum(['payment.failed', 'payment.authorized', 'payment.captured', 'payment.succeeded', 'order.paid', 'payment.refunded']),
  paymentId: z.string().trim().min(1).max(128),
  orderId: z.string().trim().min(1).max(128).nullable().optional(),
  amount: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  paymentStatus: z.string().trim().min(1).max(64).optional(),
  failureReason: z.string().trim().min(1).max(256).nullable().optional(),
  customerReference: z.string().trim().min(1).max(128).nullable().optional(),
  timestamp: z.string().datetime({ offset: true })
}).strict();

function normalizeEvent(input) {
  const event = eventSchema.parse(input);
  return {
    ...event,
    orderId: event.orderId ?? null,
    customerReference: event.customerReference ?? null,
    failureReason: event.failureReason ?? null,
    paymentStatus: event.paymentStatus || event.eventType.split('.')[1]
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
