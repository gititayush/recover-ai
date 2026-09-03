import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { InMemoryRecoveryRepository } from '../src/models/inMemoryRecoveryRepository';

describe('Milestone 7 Frontend ↔ Backend Contract Tests', () => {
  let repository;
  let app;
  let mockWhatsAppProvider;

  beforeEach(async () => {
    repository = new InMemoryRecoveryRepository();

    mockWhatsAppProvider = {
      isConfigured: () => true,
      getProviderMode: () => 'SANDBOX',
      getSender: () => 'whatsapp:+17372212163',
      sendMessage: vi.fn().mockResolvedValue({
        providerMessageId: 'SM_test_mock_12345',
        provider: 'twilio_sandbox',
        status: 'queued'
      })
    };

    app = createApp(repository, { whatsappProvider: mockWhatsAppProvider });

    // Seed Case #1 as RESOLVED (Matching Production Cases #1, #2, #3)
    await repository.createCase({
      id: 1,
      paymentId: 'pay_resolved_001',
      amount: 50000,
      currency: 'INR',
      riskStatus: 'RESOLVED',
      outcome: 'RECOVERED',
      recoveredAmount: 50000,
      riskLevel: 'LOW',
      riskReason: 'Revenue successfully recovered via verified Payment Link',
      customerReference: '+916202045661',
      customerName: 'Ayush'
    });

    await repository.createAction({
      recoveryCaseId: 1,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'OUTCOME_CONFIRMED',
      providerActionId: 'plink_test_resolved_001',
      paymentLinkUrl: 'https://rzp.io/rzp/test001',
      amount: 50000,
      currency: 'INR'
    });

    // Seed Case #2 as ELIGIBLE (Active Failure)
    await repository.createCase({
      id: 2,
      paymentId: 'pay_eligible_002',
      amount: 75000,
      currency: 'INR',
      riskStatus: 'RECOVERABLE',
      outcome: null,
      recoveredAmount: 0,
      riskLevel: 'LOW',
      riskReason: 'Bank gateway timeout during checkout',
      customerReference: '+916202045661',
      customerName: 'Ayush'
    });

    await repository.createDiagnosis({
      recoveryCaseId: 2,
      recommendation: { action: 'CUSTOMER_OUTREACH' },
      diagnosis: {
        rootCause: 'Bank gateway timeout during checkout',
        confidence: 0.88,
        category: 'TRANSIENT_PAYMENT_FAILURE',
        evidence: [{ field: 'payment.failureReason', value: 'Bank gateway timeout during checkout' }]
      }
    });
  });

  it('1. resolved case: preview returns BLOCK, PAYMENT_RECOVERED, and send is stopped', async () => {
    const previewRes = await request(app)
      .post('/api/cases/1/communication/preview')
      .send({ channel: 'whatsapp', language: 'hinglish' });

    expect(previewRes.status).toBe(200);
    expect(previewRes.body.policyDecision).toBe('BLOCK');
    expect(previewRes.body.stoppingEvaluation.stopped).toBe(true);
    expect(previewRes.body.stoppingEvaluation.reasonCode).toBe('PAYMENT_RECOVERED');
    expect(previewRes.body.stoppingEvaluation.actionDisposition).toBe('HARD_STOP');
    expect(previewRes.body.policyReasons.some((r) => r.includes('RESOLVED'))).toBe(true);

    const sendRes = await request(app)
      .post('/api/cases/1/communication/send')
      .send({ channel: 'whatsapp', language: 'hinglish', recipientPhone: '+916202045661' });

    expect(sendRes.status).toBe(422);
    expect(sendRes.body.error).toBe('EXECUTION_STOPPED');
    expect(sendRes.body.reasonCode).toBe('PAYMENT_RECOVERED');
  });

  it('2. eligible case: preview returns ALLOW, CONTINUE, and grounding valid', async () => {
    const previewRes = await request(app)
      .post('/api/cases/2/communication/preview')
      .send({ channel: 'whatsapp', language: 'hinglish' });

    expect(previewRes.status).toBe(200);
    expect(previewRes.body.policyDecision).toBe('ALLOW');
    expect(previewRes.body.stoppingEvaluation.stopped).toBe(false);
    expect(previewRes.body.stoppingEvaluation.actionDisposition).toBe('CONTINUE');
    expect(previewRes.body.groundingValid).toBe(true);
    expect(previewRes.body.amountFormatted).toBe('₹750');
  });

  it('3. eligible case: send dispatches with recipientPhone and records MessageSid', async () => {
    const sendRes = await request(app)
      .post('/api/cases/2/communication/send')
      .send({
        channel: 'whatsapp',
        language: 'hinglish',
        recipientPhone: '+916202045661'
      });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.action).toBeDefined();
    expect(sendRes.body.action.actionType).toBe('CUSTOMER_OUTREACH');
    expect(sendRes.body.action.status).toBe('EXECUTED');
    expect(sendRes.body.communication.providerMessageId).toBe('SM_test_mock_12345');
    expect(sendRes.body.communication.recipient).toBe('+916202045661');
    expect(mockWhatsAppProvider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+916202045661' })
    );
  });

  it('4. client tampering of amount or payment link is completely ignored', async () => {
    const sendRes = await request(app)
      .post('/api/cases/2/communication/send')
      .send({
        channel: 'whatsapp',
        language: 'hinglish',
        recipientPhone: '+916202045661',
        amount: 100, // Attempted tamper: ₹1
        paymentLinkUrl: 'https://malicious-phishing.com'
      });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.communication.message).toContain('₹750');
    expect(sendRes.body.communication.message).not.toContain('₹1');
    expect(sendRes.body.communication.message).not.toContain('malicious-phishing.com');
  });

  it('5. policyReasons and stoppingDisposition are visible in preview response', async () => {
    const res = await request(app)
      .post('/api/cases/1/communication/preview')
      .send({ channel: 'whatsapp', language: 'en' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.policyReasons)).toBe(true);
    expect(res.body.policyReasons.length).toBeGreaterThan(0);
    expect(res.body.stoppingEvaluation.humanReadableReason).toBeDefined();
  });

  it('6. failed dispatch due to unsupported language or channel returns structured error', async () => {
    const res = await request(app)
      .post('/api/cases/2/communication/send')
      .send({ channel: 'unsupported_channel', language: 'hinglish' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSUPPORTED_CHANNEL');
  });

  it('7. case detail endpoint includes the executed outreach action and status for UI tracking', async () => {
    await request(app)
      .post('/api/cases/2/communication/send')
      .send({ channel: 'whatsapp', language: 'hinglish', recipientPhone: '+916202045661' });

    const caseDetailRes = await request(app).get('/api/cases/2');
    expect(caseDetailRes.status).toBe(200);
    const commAction = caseDetailRes.body.actions.find((a) => a.actionType === 'CUSTOMER_OUTREACH');
    expect(commAction).toBeDefined();
    expect(commAction.providerActionId).toBe('SM_test_mock_12345');
    expect(commAction.status).toBe('EXECUTED');
  });

  it('8. dispatching outreach leaves recovered_amount strictly at 0 and preserves ledger metrics', async () => {
    const metricsBefore = await repository.getRecoveryMetrics();

    await request(app)
      .post('/api/cases/2/communication/send')
      .send({ channel: 'whatsapp', language: 'hinglish', recipientPhone: '+916202045661' });

    const caseRes = await repository.getCaseDetail(2);
    expect(caseRes.recoveryCase.recoveredAmount).toBe(0);

    const metricsAfter = await repository.getRecoveryMetrics();
    expect(metricsAfter.revenue_recovered).toBe(metricsBefore.revenue_recovered);
  });
});
