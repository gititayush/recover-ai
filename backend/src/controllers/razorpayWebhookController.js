const crypto = require('crypto');
const { getRazorpayWebhookSecret } = require('../config/env');
const { processEvent } = require('../services/eventService');
const { normalizeRazorpayWebhook, RazorpayNormalizationError } = require('../services/razorpayNormalizer');

function hasValidSignature(rawBody, signature, secret) {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(signature, 'hex');
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function persistFailedWebhook(repository, providerEventId, eventType, rawPayload, errorMessage) {
  return repository.withTransaction(async (transaction) => {
    const received = await transaction.createProviderWebhookEvent({
      provider: 'razorpay', providerEventId, eventType, rawPayload, signatureVerified: true, processingStatus: 'RECEIVED'
    });
    if (!received) return { duplicate: true };
    await transaction.updateProviderWebhookEvent(received.id, { processingStatus: 'FAILED', processingError: errorMessage });
    return { duplicate: false };
  });
}

function createRazorpayWebhookController(repository) {
  return async (request, response, next) => {
    try {
      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) return response.status(400).json({ error: 'INVALID_WEBHOOK_BODY', message: 'Expected a JSON request body.' });

      const webhookSecret = getRazorpayWebhookSecret();
      if (!webhookSecret) return response.status(503).json({ error: 'WEBHOOK_NOT_CONFIGURED', message: 'Razorpay webhook verification is not configured.' });

      const signature = request.get('X-Razorpay-Signature');
      if (!signature) return response.status(401).json({ error: 'MISSING_SIGNATURE', message: 'Razorpay webhook signature is required.' });
      if (!hasValidSignature(rawBody, signature, webhookSecret)) return response.status(401).json({ error: 'INVALID_SIGNATURE', message: 'Razorpay webhook signature is invalid.' });

      const providerEventId = request.get('x-razorpay-event-id');
      if (!providerEventId) return response.status(400).json({ error: 'MISSING_PROVIDER_EVENT_ID', message: 'Razorpay event ID header is required.' });

      const rawPayload = rawBody.toString('utf8');
      let payload;
      try {
        payload = JSON.parse(rawPayload);
      } catch (error) {
        const result = await persistFailedWebhook(repository, providerEventId, null, rawPayload, 'Malformed JSON payload');
        return response.status(result.duplicate ? 200 : 400).json({ accepted: false, duplicate: result.duplicate, error: 'MALFORMED_JSON', message: 'Webhook body is not valid JSON.' });
      }

      let normalizedEvent;
      try {
        normalizedEvent = normalizeRazorpayWebhook(providerEventId, payload);
      } catch (error) {
        if (!(error instanceof RazorpayNormalizationError)) throw error;
        const result = await persistFailedWebhook(repository, providerEventId, payload.event || null, rawPayload, error.message);
        return response.status(result.duplicate ? 200 : error.statusCode).json({ accepted: false, duplicate: result.duplicate, error: error.statusCode === 202 ? 'UNSUPPORTED_EVENT' : 'MALFORMED_PAYLOAD', message: error.message });
      }

      const result = await repository.withTransaction(async (transaction) => {
        const received = await transaction.createProviderWebhookEvent({
          provider: 'razorpay', providerEventId, eventType: normalizedEvent.eventType, rawPayload, signatureVerified: true, processingStatus: 'PROCESSING'
        });
        if (!received) return { duplicate: true };
        const processed = await processEvent(transaction, normalizedEvent);
        await transaction.updateProviderWebhookEvent(received.id, { processingStatus: 'PROCESSED' });
        return { duplicate: false, processed };
      });

      if (result.duplicate) return response.status(200).json({ accepted: true, duplicate: true, message: 'Razorpay event was already processed.' });
      return response.status(202).json({ accepted: true, duplicate: false, recoveryCase: result.processed.recoveryCase || null, suppressed: result.processed.suppressed || false, ignored: result.processed.ignored || false });
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { createRazorpayWebhookController, hasValidSignature };
