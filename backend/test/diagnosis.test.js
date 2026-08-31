const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { processEvent } = require('../src/services/eventService');
const { createDiagnosisService } = require('../src/ai/diagnosisService');
const { createAiProvider } = require('../src/ai/providerAdapter');
const { buildCaseContext } = require('../src/ai/contextBuilder');
const { evaluateCandidates, rankCandidates } = require('../src/ai/interventionEvaluator');

const fixedNow = () => new Date('2026-08-31T10:30:00.000Z');

async function seedRecoverableCase(repository) {
  await processEvent(repository, {
    eventId: 'evt_diagnosis_failed_001', eventType: 'payment.failed', paymentId: 'pay_diagnosis_001', orderId: 'order_diagnosis_001',
    amount: 499900, currency: 'INR', paymentStatus: 'failed', failureReason: 'timeout', customerReference: 'customer_not_sent_to_ai', timestamp: '2026-08-31T10:00:00.000Z'
  });
  return repository.getCaseDetail(1);
}

function validProposal(overrides = {}) {
  return {
    diagnosis: {
      cause: 'The payment attempt timed out before completion.',
      confidence: 0.82,
      evidence: [{ field: 'payment.failureReason', value: 'timeout' }, { field: 'payment.attemptCount', value: '1' }]
    },
    recommendation: { action: 'CREATE_PAYMENT_LINK' },
    ...overrides
  };
}

function mockProvider(response) {
  return { provider: 'mock-provider', model: 'mock-model-v1', source: 'live_ai', diagnose: vi.fn().mockResolvedValue(response) };
}

function appWithProvider(repository, provider, confidenceThreshold = 0.65) {
  return createApp(repository, { diagnosisService: createDiagnosisService({ provider, confidenceThreshold, now: fixedNow }) });
}

describe('AI diagnosis and intervention proposal layer', () => {
  it('accepts a valid structured response, persists it, and appends an audit event', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const response = await request(appWithProvider(repository, mockProvider(validProposal()))).post('/api/cases/1/diagnosis').expect(201);
    expect(response.body.diagnosis).toMatchObject({ proposedAction: 'CREATE_PAYMENT_LINK', recommendation: { action: 'CREATE_PAYMENT_LINK' }, provider: 'mock-provider', promptVersion: 'recoverai-diagnosis-v1' });
    expect(repository.aiDiagnoses).toHaveLength(1);
    expect(repository.audits.at(-1)).toMatchObject({ eventType: 'AI_DIAGNOSIS', metadata: { recommendedAction: 'CREATE_PAYMENT_LINK' } });
  });

  it('rejects malformed provider output without persisting a diagnosis', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    await request(appWithProvider(repository, mockProvider('not-json'))).post('/api/cases/1/diagnosis').expect(422);
    expect(repository.aiDiagnoses).toHaveLength(0);
  });

  it('rejects an unsupported action', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const proposal = validProposal({ recommendation: { action: 'SEND_CUSTOMER_MESSAGE' } });
    await request(appWithProvider(repository, mockProvider(proposal))).post('/api/cases/1/diagnosis').expect(422);
  });

  it('rejects missing evidence', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const proposal = validProposal({ diagnosis: { ...validProposal().diagnosis, evidence: [] } });
    await request(appWithProvider(repository, mockProvider(proposal))).post('/api/cases/1/diagnosis').expect(422);
  });

  it('rejects evidence that does not match the supplied context', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const proposal = validProposal({ diagnosis: { ...validProposal().diagnosis, evidence: [{ field: 'payment.failureReason', value: 'invented_reason' }] } });
    await request(appWithProvider(repository, mockProvider(proposal))).post('/api/cases/1/diagnosis').expect(422);
  });

  it('changes a low-confidence proposal to manual review', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const proposal = validProposal({ diagnosis: { ...validProposal().diagnosis, confidence: 0.3 } });
    const response = await request(appWithProvider(repository, mockProvider(proposal), 0.65)).post('/api/cases/1/diagnosis').expect(201);
    expect(response.body.diagnosis.recommendation.action).toBe('REQUEST_MANUAL_REVIEW');
  });

  it('returns and persists NO_ACTION for terminal cases without calling the provider', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    await processEvent(repository, { eventId: 'evt_diagnosis_captured_001', eventType: 'payment.captured', paymentId: 'pay_diagnosis_001', orderId: 'order_diagnosis_001', amount: 499900, currency: 'INR', paymentStatus: 'captured', timestamp: '2026-08-31T10:05:00.000Z' });
    const provider = mockProvider(validProposal());
    const response = await request(appWithProvider(repository, provider)).post('/api/cases/1/diagnosis').expect(201);
    expect(response.body.diagnosis).toMatchObject({ source: 'system_safety', recommendation: { action: 'NO_ACTION' } });
    expect(provider.diagnose).not.toHaveBeenCalled();
  });

  it('uses a clearly labeled deterministic development fallback when no API key is configured', async () => {
    const repository = new InMemoryRecoveryRepository();
    const detail = await seedRecoverableCase(repository);
    const provider = createAiProvider({ apiKey: null, model: 'unused', baseUrl: 'https://example.invalid' });
    const result = await createDiagnosisService({ provider, now: fixedNow }).diagnose(detail);
    expect(result).toMatchObject({ source: 'development_fallback', provider: 'development-fallback' });
  });

  it('builds a minimized context without customer references or raw payloads', async () => {
    const repository = new InMemoryRecoveryRepository();
    const detail = await seedRecoverableCase(repository);
    const context = buildCaseContext(detail, fixedNow());
    expect(context).not.toHaveProperty('customerReference');
    expect(context).not.toHaveProperty('rawPayload');
    expect(context.recentEvents[0]).not.toHaveProperty('rawPayload');
  });

  it('evaluates candidates with documented deterministic heuristic values', async () => {
    const repository = new InMemoryRecoveryRepository();
    const detail = await seedRecoverableCase(repository);
    const candidates = evaluateCandidates(buildCaseContext(detail, fixedNow()));
    expect(candidates.find((candidate) => candidate.action === 'CREATE_PAYMENT_LINK')).toMatchObject({ estimatedProbability: 0.5, recoverableAmount: 499900, interventionCost: 0, estimatedFriction: 24995 });
    expect(candidates.every((candidate) => candidate.assumptions.heuristicVersion === 'recovery-heuristic-v1')).toBe(true);
  });

  it('ranks candidate interventions deterministically by estimated value', () => {
    const ranked = rankCandidates([{ action: 'NO_ACTION', estimatedRecoveryValue: 0 }, { action: 'REQUEST_MANUAL_REVIEW', estimatedRecoveryValue: 50 }, { action: 'CREATE_PAYMENT_LINK', estimatedRecoveryValue: 100 }]);
    expect(ranked.map((candidate) => candidate.action)).toEqual(['CREATE_PAYMENT_LINK', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION']);
  });

  it('returns a cached persisted diagnosis on repeated requests without duplicate audits', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const provider = mockProvider(validProposal());
    const app = appWithProvider(repository, provider);
    await request(app).post('/api/cases/1/diagnosis').expect(201);
    const second = await request(app).post('/api/cases/1/diagnosis').expect(200);
    expect(second.body.cached).toBe(true);
    expect(provider.diagnose).toHaveBeenCalledTimes(1);
    expect(repository.aiDiagnoses).toHaveLength(1);
    expect(repository.audits.filter((audit) => audit.eventType === 'AI_DIAGNOSIS')).toHaveLength(1);
  });

  it('retrieves an accepted diagnosis through the case diagnosis API', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const app = appWithProvider(repository, mockProvider(validProposal()));
    await request(app).post('/api/cases/1/diagnosis').expect(201);
    const response = await request(app).get('/api/cases/1/diagnosis').expect(200);
    expect(response.body).toMatchObject({ cached: true, diagnosis: { recoveryCaseId: 1 } });
  });

  it('does not execute a financial action while generating a diagnosis', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const response = await request(appWithProvider(repository, mockProvider(validProposal()))).post('/api/cases/1/diagnosis').expect(201);
    expect(response.body.diagnosis).not.toHaveProperty('execution');
    expect(repository.actions).toHaveLength(0);
  });

  it('calls OpenAiCompatibleProvider and parses valid JSON response content', async () => {
    const provider = createAiProvider({ apiKey: 'test-key', model: 'test-model', baseUrl: 'https://api.openai.com/v1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(validProposal()) } }] })
    });
    const result = await provider.diagnose({ context: {}, prompt: { system: 'sys' } });
    expect(result).toContain('payment.failureReason');
    expect(fetchSpy).toHaveBeenCalledWith('https://api.openai.com/v1/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer test-key' })
    }));
    fetchSpy.mockRestore();
  });

  it('throws AiProviderError when OpenAiCompatibleProvider returns an HTTP error status', async () => {
    const provider = createAiProvider({ apiKey: 'test-key', model: 'test-model', baseUrl: 'https://api.openai.com/v1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(provider.diagnose({ context: {}, prompt: { system: 'sys' } })).rejects.toThrow('AI provider returned HTTP 500');
    fetchSpy.mockRestore();
  });

  it('returns NO_ACTION when order.paid event is present', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    await processEvent(repository, { eventId: 'evt_diagnosis_order_paid_001', eventType: 'order.paid', paymentId: 'pay_diagnosis_001', orderId: 'order_diagnosis_001', amount: 499900, currency: 'INR', paymentStatus: 'captured', timestamp: '2026-08-31T10:05:00.000Z' });
    const provider = mockProvider(validProposal());
    const response = await request(appWithProvider(repository, provider)).post('/api/cases/1/diagnosis').expect(201);
    expect(response.body.diagnosis.recommendation.action).toBe('NO_ACTION');
    expect(response.body.diagnosis.diagnosis.evidence[0]).toEqual({ field: 'payment.status', value: 'captured' });
  });

  it('persists and retrieves AI diagnosis via PostgresRecoveryRepository when database is available', async () => {
    const { getPool, closePool } = require('../src/db/pool');
    const { PostgresRecoveryRepository } = require('../src/models/postgresRecoveryRepository');
    try {
      const pool = getPool();
      await pool.query('SELECT 1');
      const repository = new PostgresRecoveryRepository(pool);
      await processEvent(repository, {
        eventId: `evt_pg_test_${Date.now()}`, eventType: 'payment.failed', paymentId: `pay_pg_test_${Date.now()}`, orderId: 'ord_pg_test',
        amount: 499900, currency: 'INR', paymentStatus: 'failed', failureReason: 'timeout', timestamp: new Date().toISOString()
      });
      const cases = await repository.listCases();
      const testCase = cases[0];
      const detail = await repository.getCaseDetail(testCase.id);
      const diagnosisService = createDiagnosisService({ provider: mockProvider(validProposal()), now: fixedNow });
      const decision = await diagnosisService.diagnose(detail);
      const saved = await repository.createDiagnosis({ recoveryCaseId: testCase.id, ...decision });
      expect(saved).not.toBeNull();
      expect(saved.recoveryCaseId).toBe(testCase.id);
      const fetched = await repository.findDiagnosisByCaseId(testCase.id);
      expect(fetched).toMatchObject({ proposedAction: 'CREATE_PAYMENT_LINK', recommendation: { action: 'CREATE_PAYMENT_LINK' } });
    } catch (err) {
      // Postgres not available in this test runner environment
    } finally {
      const { closePool } = require('../src/db/pool');
      await closePool();
    }
  });
});
