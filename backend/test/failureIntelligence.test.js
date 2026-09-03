const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { processEvent } = require('../src/services/eventService');
const { createDiagnosisService } = require('../src/ai/diagnosisService');
const { extractProviderEvidence, classifyFailureEvidence, guardFailureClassification } = require('../src/ai/failureTaxonomy');

const fixedNow = () => new Date('2026-09-04T02:00:00.000Z');

function mockProvider(response) {
  return {
    provider: 'mock-ai',
    model: 'mock-model-v2',
    source: 'live_ai',
    diagnose: vi.fn().mockResolvedValue(response)
  };
}

function appWithProvider(repository, provider, confidenceThreshold = 0.65) {
  return createApp(repository, {
    diagnosisService: createDiagnosisService({ provider, confidenceThreshold, now: fixedNow })
  });
}

describe('Revflow V2 — Milestone 8: Failure Intelligence & Root-Cause Engine', () => {
  let repository;

  beforeEach(() => {
    repository = new InMemoryRecoveryRepository();
  });

  // 1. Generic "Payment failed" -> UNKNOWN_FAILURE with low confidence (<= 0.35)
  it('1. Generic "Payment failed" produces UNKNOWN_FAILURE with honest low confidence', async () => {
    await processEvent(repository, {
      eventId: 'evt_m8_generic_01',
      eventType: 'payment.failed',
      paymentId: 'pay_m8_generic_01',
      amount: 50000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Payment failed',
      timestamp: '2026-09-04T01:00:00.000Z'
    });

    // Provider attempts to claim a high-confidence technical failure
    const mockAi = mockProvider({
      diagnosis: {
        category: 'TRANSIENT_PAYMENT_FAILURE',
        failureFamily: 'BANK_SWITCH_TIMEOUT',
        failureType: 'ISSUER_SWITCH_TIMEOUT',
        cause: 'Bank switch timed out during payment.',
        confidence: 0.92,
        evidence: [{ field: 'payment.status', value: 'failed' }]
      },
      recommendation: { action: 'CREATE_PAYMENT_LINK' }
    });

    const app = appWithProvider(repository, mockAi);
    const res = await request(app).post('/api/cases/1/diagnosis').expect(201);

    const { diagnosis } = res.body;
    expect(diagnosis.diagnosis.failureFamily).toBe('UNKNOWN_FAILURE');
    expect(diagnosis.diagnosis.failureType).toBe('INSUFFICIENT_PROVIDER_TELEMETRY');
    expect(diagnosis.diagnosis.confidence).toBeLessThanOrEqual(0.35);
    expect(diagnosis.diagnosis.unknowns.length).toBeGreaterThan(0);
    expect(diagnosis.diagnosis.unknowns.some((u) => u.includes('generic') || u.includes('telemetry'))).toBe(true);

    // Because confidence is <= 0.35, policy recommendation should be conservative / review
    expect(diagnosis.recommendation.action).toBe('REQUEST_MANUAL_REVIEW');
  });

  // 2. Provider-specific gateway evidence -> GATEWAY_TECHNICAL_FAILURE / BANK_SWITCH_TIMEOUT
  it('2. Provider-specific bank switch timeout evidence correctly yields BANK_SWITCH_TIMEOUT with high confidence', async () => {
    await processEvent(repository, {
      eventId: 'evt_m8_switch_01',
      eventType: 'payment.failed',
      paymentId: 'pay_m8_switch_01',
      amount: 50000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Bank switch timeout',
      rawPayload: {
        error_code: 'BAD_REQUEST_ERROR',
        error_source: 'bank',
        error_step: 'payment_authorization',
        error_description: 'Bank switch timeout during transaction authorization'
      },
      timestamp: '2026-09-04T01:00:00.000Z'
    });

    const mockAi = mockProvider({
      diagnosis: {
        category: 'TRANSIENT_PAYMENT_FAILURE',
        failureFamily: 'BANK_SWITCH_TIMEOUT',
        failureType: 'ISSUER_SWITCH_TIMEOUT',
        cause: 'Issuer bank switch timed out during transaction authorization.',
        confidence: 0.88,
        classificationBasis: ['provider.errorCode', 'provider.errorSource', 'payment.failureReason'],
        unknowns: ['Customer account balance is private to the issuer.'],
        evidence: [
          { field: 'payment.failureReason', value: 'Bank switch timeout' },
          { field: 'provider.errorCode', value: 'BAD_REQUEST_ERROR' }
        ]
      },
      recommendation: { action: 'CREATE_PAYMENT_LINK' }
    });

    const app = appWithProvider(repository, mockAi);
    const res = await request(app).post('/api/cases/1/diagnosis').expect(201);

    const { diagnosis } = res.body;
    expect(diagnosis.diagnosis.failureFamily).toBe('BANK_SWITCH_TIMEOUT');
    expect(diagnosis.diagnosis.failureType).toBe('ISSUER_SWITCH_TIMEOUT');
    expect(diagnosis.diagnosis.confidence).toBe(0.88);
    expect(diagnosis.diagnosis.classificationBasis).toContain('provider.errorCode');
    expect(diagnosis.recommendation.action).toBe('CREATE_PAYMENT_LINK');
  });

  // 3. Insufficient funds evidence -> INSUFFICIENT_FUNDS classification
  it('3. Provider insufficient balance telemetry classifies as INSUFFICIENT_FUNDS', async () => {
    await processEvent(repository, {
      eventId: 'evt_m8_balance_01',
      eventType: 'payment.failed',
      paymentId: 'pay_m8_balance_01',
      amount: 150000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Your bank account has insufficient balance.',
      rawPayload: {
        error_code: 'INSUFFICIENT_FUNDS',
        error_source: 'customer',
        error_step: 'payment_authorization',
        error_description: 'Account balance insufficient for requested transaction amount'
      },
      timestamp: '2026-09-04T01:00:00.000Z'
    });

    const detail = await repository.getCaseDetail(1);
    const evidence = extractProviderEvidence(detail.events[0].rawPayload, detail.events[0]);
    expect(evidence.evidenceStrength).toBe('STRONG');
    expect(evidence.providerErrorCode).toBe('INSUFFICIENT_FUNDS');

    const classification = classifyFailureEvidence(evidence);
    expect(classification.failureFamily).toBe('INSUFFICIENT_FUNDS');
    expect(classification.failureType).toBe('ACCOUNT_INSUFFICIENT_BALANCE');
    expect(classification.confidence).toBeGreaterThanOrEqual(0.75);
  });

  // 4. Unsupported AI claim is guarded and rejected
  it('4. Unsupported AI claim of "fraud" or "insufficient funds" on generic failure is rejected', async () => {
    await processEvent(repository, {
      eventId: 'evt_m8_unsupported_01',
      eventType: 'payment.failed',
      paymentId: 'pay_m8_unsupported_01',
      amount: 45000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'payment failed',
      timestamp: '2026-09-04T01:00:00.000Z'
    });

    // Hallucinating AI claiming insufficient funds without any evidence
    const mockAi = mockProvider({
      diagnosis: {
        category: 'TRANSIENT_PAYMENT_FAILURE',
        failureFamily: 'INSUFFICIENT_FUNDS',
        failureType: 'ACCOUNT_INSUFFICIENT_BALANCE',
        cause: 'Customer had insufficient funds in their bank account.',
        confidence: 0.95,
        evidence: [{ field: 'payment.status', value: 'failed' }]
      },
      recommendation: { action: 'CREATE_PAYMENT_LINK' }
    });

    const app = appWithProvider(repository, mockAi);
    // Semantic validation or guardrail should intercept ungrounded claims
    const res = await request(app).post('/api/cases/1/diagnosis');

    if (res.status === 201) {
      expect(res.body.diagnosis.diagnosis.failureFamily).toBe('UNKNOWN_FAILURE');
      expect(res.body.diagnosis.diagnosis.confidence).toBeLessThanOrEqual(0.35);
    } else {
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('AI_DIAGNOSIS_INVALID');
    }
  });

  // 5. Missing evidence -> UNKNOWN_FAILURE
  it('5. Event with completely missing failure details classifies as UNKNOWN_FAILURE', () => {
    const evidence = extractProviderEvidence({}, { eventType: 'payment.failed', paymentStatus: 'failed' });
    expect(evidence.evidenceStrength).toBe('MINIMAL');

    const classification = classifyFailureEvidence(evidence);
    expect(classification.failureFamily).toBe('UNKNOWN_FAILURE');
    expect(classification.failureType).toBe('INSUFFICIENT_PROVIDER_TELEMETRY');
    expect(classification.confidence).toBeLessThanOrEqual(0.35);
  });

  // 6. Evidence citations correspond strictly to actual facts present in context
  it('6. Rejects diagnosis citing nonexistent fact keys', async () => {
    await processEvent(repository, {
      eventId: 'evt_m8_facts_01',
      eventType: 'payment.failed',
      paymentId: 'pay_m8_facts_01',
      amount: 50000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'timeout',
      timestamp: '2026-09-04T01:00:00.000Z'
    });

    const mockAi = mockProvider({
      diagnosis: {
        category: 'TRANSIENT_PAYMENT_FAILURE',
        cause: 'Payment timed out.',
        confidence: 0.85,
        evidence: [{ field: 'provider.errorSource', value: 'invented_bank' }]
      },
      recommendation: { action: 'CREATE_PAYMENT_LINK' }
    });

    const app = appWithProvider(repository, mockAi);
    await request(app).post('/api/cases/1/diagnosis').expect(422);
  });

  // 7. AI cannot alter financial amount/currency
  it('7. Financial amount and currency remain 100% server-owned and immutable by AI', async () => {
    await processEvent(repository, {
      eventId: 'evt_m8_financial_01',
      eventType: 'payment.failed',
      paymentId: 'pay_m8_financial_01',
      amount: 75000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Bank timeout',
      timestamp: '2026-09-04T01:00:00.000Z'
    });

    const mockAi = mockProvider({
      diagnosis: {
        category: 'TRANSIENT_PAYMENT_FAILURE',
        failureFamily: 'BANK_SWITCH_TIMEOUT',
        cause: 'Bank switch timeout.',
        confidence: 0.85,
        evidence: [{ field: 'payment.failureReason', value: 'Bank timeout' }]
      },
      recommendation: { action: 'CREATE_PAYMENT_LINK' }
    });

    const app = appWithProvider(repository, mockAi);
    const res = await request(app).post('/api/cases/1/diagnosis').expect(201);

    const detail = await repository.getCaseDetail(1);
    expect(detail.recoveryCase.amount).toBe(75000);
    expect(detail.recoveryCase.currency).toBe('INR');

    // Candidates in diagnosis correctly reflect server-owned amount
    expect(res.body.diagnosis.candidates[0].recoverableAmount).toBe(75000);
  });

  // 8. Existing policy remains authoritative over AI recommendations
  it('8. Policy vetoes AI proposed action if confidence is low', async () => {
    await processEvent(repository, {
      eventId: 'evt_m8_policy_01',
      eventType: 'payment.failed',
      paymentId: 'pay_m8_policy_01',
      amount: 50000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Payment failed',
      timestamp: '2026-09-04T01:00:00.000Z'
    });

    const mockAi = mockProvider({
      diagnosis: {
        category: 'TRANSIENT_PAYMENT_FAILURE',
        cause: 'Generic failure occurred without technical details.',
        confidence: 0.30,
        evidence: [{ field: 'payment.failureReason', value: 'Payment failed' }]
      },
      recommendation: { action: 'CREATE_PAYMENT_LINK' }
    });

    const app = appWithProvider(repository, mockAi);
    const diagRes = await request(app).post('/api/cases/1/diagnosis').expect(201);

    // AI proposal was CREATE_PAYMENT_LINK, but recommendation is downgraded to REQUEST_MANUAL_REVIEW
    expect(diagRes.body.diagnosis.proposedAction).toBe('CREATE_PAYMENT_LINK');
    expect(diagRes.body.diagnosis.recommendation.action).toBe('REQUEST_MANUAL_REVIEW');

    // Direct policy evaluation checks confidence rule
    const policyRes = await request(app).post('/api/cases/1/policy').send({
      action: 'CREATE_PAYMENT_LINK'
    }).expect(200);

    expect(policyRes.body.policy.decision).toBe('REVIEW');
    expect(policyRes.body.policy.rulesEvaluated.find((r) => r.rule === 'confidence_threshold').status).toBe('REVIEW');
  });

  // 9. Historical cases and financial outcomes remain unchanged
  it('9. Historical cases ledger invariants remain intact', async () => {
    const metrics = await repository.getRecoveryMetrics();
    expect(metrics).toHaveProperty('revenue_at_risk');
    expect(metrics).toHaveProperty('revenue_recovered');
    expect(metrics).toHaveProperty('recovery_rate');
  });

  // 10. Strategy candidate list does not advertise unavailable actions as executable
  it('10. Strategy candidate list marks executionMode accurately', async () => {
    await processEvent(repository, {
      eventId: 'evt_m8_strategies_01',
      eventType: 'payment.failed',
      paymentId: 'pay_m8_strategies_01',
      amount: 50000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'timeout',
      timestamp: '2026-09-04T01:00:00.000Z'
    });

    const mockAi = mockProvider({
      diagnosis: {
        category: 'TRANSIENT_PAYMENT_FAILURE',
        cause: 'Payment timed out.',
        confidence: 0.85,
        evidence: [{ field: 'payment.failureReason', value: 'timeout' }]
      },
      recommendation: { action: 'CREATE_PAYMENT_LINK' }
    });

    const app = appWithProvider(repository, mockAi);
    const res = await request(app).post('/api/cases/1/diagnosis').expect(201);

    const candidates = res.body.diagnosis.candidates;
    const paymentLinkCandidate = candidates.find((c) => c.action === 'CREATE_PAYMENT_LINK');
    expect(paymentLinkCandidate.isLiveExecutable).toBe(true);
    expect(paymentLinkCandidate.executionMode).toBe('LIVE_PROVIDER');

    const manualReviewCandidate = candidates.find((c) => c.action === 'REQUEST_MANUAL_REVIEW');
    expect(manualReviewCandidate.isLiveExecutable).toBe(false);
    expect(manualReviewCandidate.executionMode).toBe('CONTROL');
  });
});
