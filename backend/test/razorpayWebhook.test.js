const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');

const testWebhookSecret = 'recoverai-test-webhook-secret-not-a-provider-credential';
process.env.RAZORPAY_WEBHOOK_SECRET = testWebhookSecret;

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'razorpay', name));
}

function signature(body, secret = testWebhookSecret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function webhook(app, eventId, body, options = {}) {
  let requestBuilder = request(app)
    .post('/api/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', options.signature || signature(body));
  if (!options.omitEventId) requestBuilder = requestBuilder.set('x-razorpay-event-id', eventId);
  return requestBuilder.send(body.toString('utf8'));
}

describe('Razorpay webhook adapter', () => {
  it('verifies the exact raw body, normalizes payment.failed, and creates a canonical recovery case', async () => {
    const repository = new InMemoryRecoveryRepository();
    const body = fixture('payment.failed.json');
    const response = await webhook(createApp(repository), 'rzp_evt_failed_001', body).expect(202);

    expect(response.body.recoveryCase).toMatchObject({ paymentId: 'pay_webhook_failed_001', riskStatus: 'RECOVERABLE', riskLevel: 'MEDIUM' });
    expect(repository.providerWebhookEvents[0]).toMatchObject({ provider: 'razorpay', providerEventId: 'rzp_evt_failed_001', processingStatus: 'PROCESSED', rawPayload: body.toString('utf8') });
    expect(repository.events[0]).toMatchObject({ eventId: 'rzp_evt_failed_001', eventType: 'payment.failed', failureReason: 'Payment session timed out' });
  });

  it('rejects an invalid signature before persisting or processing the webhook', async () => {
    const repository = new InMemoryRecoveryRepository();
    await webhook(createApp(repository), 'rzp_evt_invalid_sig', fixture('payment.failed.json'), { signature: '0'.repeat(64) }).expect(401);
    expect(repository.providerWebhookEvents).toHaveLength(0);
    expect(repository.events).toHaveLength(0);
  });

  it('rejects a missing signature', async () => {
    const app = createApp(new InMemoryRecoveryRepository());
    await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-event-id', 'rzp_evt_missing_sig').send(fixture('payment.failed.json')).expect(401);
  });

  it('rejects a valid signature for body bytes that differ from the signed body', async () => {
    const body = fixture('payment.failed.json');
    const altered = Buffer.from(`${body.toString('utf8')} `);
    await webhook(createApp(new InMemoryRecoveryRepository()), 'rzp_evt_raw_mismatch', altered, { signature: signature(body) }).expect(401);
  });

  it('deduplicates repeated provider event delivery before canonical processing', async () => {
    const repository = new InMemoryRecoveryRepository();
    const app = createApp(repository);
    const body = fixture('payment.failed.json');
    await webhook(app, 'rzp_evt_duplicate_001', body).expect(202);
    const duplicate = await webhook(app, 'rzp_evt_duplicate_001', body).expect(200);
    expect(duplicate.body.duplicate).toBe(true);
    expect(repository.providerWebhookEvents).toHaveLength(1);
    expect(repository.events).toHaveLength(1);
    expect(repository.cases).toHaveLength(1);
    expect(repository.audits).toHaveLength(3);
  });

  it('normalizes payment.authorized without creating a recovery opportunity', async () => {
    const repository = new InMemoryRecoveryRepository();
    await webhook(createApp(repository), 'rzp_evt_authorized_001', fixture('payment.authorized.json')).expect(202);
    expect(repository.events[0]).toMatchObject({ eventType: 'payment.authorized', paymentStatus: 'authorized', amount: 120000 });
    expect(repository.cases).toHaveLength(0);
  });

  it('normalizes payment.captured and resolves an existing case', async () => {
    const repository = new InMemoryRecoveryRepository();
    const app = createApp(repository);
    await webhook(app, 'rzp_evt_failed_to_captured_001', fixture('payment.failed.json')).expect(202);
    const captured = await webhook(app, 'rzp_evt_captured_001', fixture('payment.captured.json')).expect(202);
    expect(captured.body.recoveryCase).toMatchObject({ riskStatus: 'RESOLVED', outcome: 'PAID' });
  });

  it('normalizes order.paid using payment and order entities when supplied', async () => {
    const repository = new InMemoryRecoveryRepository();
    await webhook(createApp(repository), 'rzp_evt_order_paid_001', fixture('order.paid.json')).expect(202);
    expect(repository.events[0]).toMatchObject({ eventType: 'order.paid', paymentId: 'pay_webhook_order_paid_001', orderId: 'order_webhook_003', customerReference: 'receipt_webhook_003' });
  });

  it('accepts a valid webhook with optional customer and order fields absent', async () => {
    const repository = new InMemoryRecoveryRepository();
    await webhook(createApp(repository), 'rzp_evt_minimal_001', fixture('payment.failed.minimal.json')).expect(202);
    expect(repository.events[0]).toMatchObject({ orderId: null, customerReference: null, failureReason: null });
  });

  it('records signed malformed JSON without sending it to the canonical pipeline', async () => {
    const repository = new InMemoryRecoveryRepository();
    await webhook(createApp(repository), 'rzp_evt_malformed_001', fixture('malformed.json.txt')).expect(400);
    expect(repository.providerWebhookEvents[0]).toMatchObject({ processingStatus: 'FAILED', processingError: 'Malformed JSON payload' });
    expect(repository.events).toHaveLength(0);
  });

  it('records a signed unsupported event as failed without a business transition', async () => {
    const repository = new InMemoryRecoveryRepository();
    const response = await webhook(createApp(repository), 'rzp_evt_unsupported_001', fixture('unsupported.json')).expect(202);
    expect(response.body.error).toBe('UNSUPPORTED_EVENT');
    expect(repository.providerWebhookEvents[0].processingStatus).toBe('FAILED');
    expect(repository.events).toHaveLength(0);
  });

  it('rejects a missing provider event ID', async () => {
    await webhook(createApp(new InMemoryRecoveryRepository()), 'unused', fixture('payment.failed.json'), { omitEventId: true }).expect(400);
  });

  it('does not reopen a case when payment.failed arrives after payment.captured', async () => {
    const repository = new InMemoryRecoveryRepository();
    const app = createApp(repository);
    await webhook(app, 'rzp_evt_capture_first_001', fixture('payment.captured.json')).expect(202);
    const lateFailure = await webhook(app, 'rzp_evt_late_failure_001', fixture('payment.failed.json')).expect(202);
    expect(lateFailure.body).toMatchObject({ recoveryCase: null, ignored: true });
    expect(repository.cases).toHaveLength(0);
  });

  it('returns a clear configuration failure when no webhook secret is configured', async () => {
    const priorSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    await webhook(createApp(new InMemoryRecoveryRepository()), 'rzp_evt_no_config_001', fixture('payment.failed.json')).expect(503);
    process.env.RAZORPAY_WEBHOOK_SECRET = priorSecret;
  });
});
