const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');

function buildApp() { return createApp(new InMemoryRecoveryRepository()); }

const failedEvent = {
  eventId: 'evt_test_001', eventType: 'payment.failed', paymentId: 'pay_test_001', orderId: 'order_test_001',
  amount: 499900, currency: 'INR', failureReason: 'timeout', customerReference: 'customer_test_001', timestamp: '2026-08-31T10:00:00.000Z'
};

describe('event ingestion and recovery cases', () => {
  it('stores a valid failed event and creates a recoverable case', async () => {
    const response = await request(buildApp()).post('/api/events').send(failedEvent).expect(201);
    expect(response.body.recoveryCase.riskStatus).toBe('RECOVERABLE');
    expect(response.body.recoveryCase.riskLevel).toBe('MEDIUM');
  });

  it('rejects malformed events', async () => {
    const response = await request(buildApp()).post('/api/events').send({ eventId: 'missing-fields' }).expect(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('makes duplicate event IDs idempotent', async () => {
    const app = buildApp();
    await request(app).post('/api/events').send(failedEvent).expect(201);
    const duplicate = await request(app).post('/api/events').send(failedEvent).expect(200);
    expect(duplicate.body).toMatchObject({ accepted: true, duplicate: true });
    const cases = await request(app).get('/api/cases').expect(200);
    expect(cases.body.cases).toHaveLength(1);
  });

  it('raises the risk level for repeated payment failures', async () => {
    const app = buildApp();
    await request(app).post('/api/events').send(failedEvent).expect(201);
    const response = await request(app).post('/api/events').send({ ...failedEvent, eventId: 'evt_test_002', failureReason: 'bank_declined', timestamp: '2026-08-31T10:01:00.000Z' }).expect(201);
    expect(response.body.recoveryCase.riskLevel).toBe('HIGH');
  });

  it('resolves an existing case on a successful terminal event', async () => {
    const app = buildApp();
    await request(app).post('/api/events').send(failedEvent).expect(201);
    const response = await request(app).post('/api/events').send({ ...failedEvent, eventId: 'evt_test_003', eventType: 'payment.captured', failureReason: null, timestamp: '2026-08-31T10:02:00.000Z' }).expect(201);
    expect(response.body.recoveryCase).toMatchObject({ riskStatus: 'RESOLVED', outcome: 'PAID' });
  });

  it('suppresses an existing case when a payment is refunded', async () => {
    const app = buildApp();
    await request(app).post('/api/events').send(failedEvent).expect(201);
    const response = await request(app).post('/api/events').send({ ...failedEvent, eventId: 'evt_test_004', eventType: 'payment.refunded', failureReason: null, timestamp: '2026-08-31T10:02:00.000Z' }).expect(201);
    expect(response.body.recoveryCase).toMatchObject({ riskStatus: 'SUPPRESSED', outcome: 'REFUNDED' });
  });

  it('returns a case with its event and audit timeline', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/events').send(failedEvent).expect(201);
    const detail = await request(app).get(`/api/cases/${created.body.recoveryCase.id}`).expect(200);
    expect(detail.body.events).toHaveLength(1);
    expect(detail.body.auditEvents.map((item) => item.eventType)).toEqual(['EVENT_RECEIVED', 'RISK_DETECTED', 'CASE_CREATED']);
  });
});
