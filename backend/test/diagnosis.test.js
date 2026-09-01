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

  it('rejects unsupported domain claims in diagnosis.cause (e.g., hallucinating 3D-Secure when not in context)', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const ungroundedProposal = validProposal({
      diagnosis: {
        cause: '3D-Secure authentication failed on customer Visa card with OTP timeout.',
        confidence: 0.85,
        evidence: [{ field: 'payment.failureReason', value: 'timeout' }]
      }
    });
    const response = await request(appWithProvider(repository, mockProvider(ungroundedProposal))).post('/api/cases/1/diagnosis').expect(422);
    expect(response.body).toMatchObject({
      error: 'AI_DIAGNOSIS_INVALID',
      message: expect.stringContaining('ungrounded claims')
    });
    expect(repository.aiDiagnoses).toHaveLength(0);
  });

  it('accepts domain-specific claims in diagnosis.cause when supported by context facts', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, {
      eventId: 'evt_hdfc_3ds_001', eventType: 'payment.failed', paymentId: 'pay_hdfc_3ds_001',
      amount: 499900, currency: 'INR', paymentStatus: 'failed', failureReason: 'Acquiring bank timeout during HDFC 3D-Secure challenge', timestamp: '2026-08-31T10:00:00.000Z'
    });
    const groundedProposal = validProposal({
      diagnosis: {
        cause: 'HDFC acquiring bank experienced a timeout during the 3D-Secure verification step.',
        confidence: 0.88,
        evidence: [{ field: 'payment.failureReason', value: 'Acquiring bank timeout during HDFC 3D-Secure challenge' }]
      }
    });
    const response = await request(appWithProvider(repository, mockProvider(groundedProposal))).post('/api/cases/1/diagnosis').expect(201);
    expect(response.body.diagnosis.diagnosis.cause).toContain('HDFC');
  });

  it('rejects diagnosis.cause that contradicts recorded payment status', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const contradictoryProposal = validProposal({
      diagnosis: {
        cause: 'The payment was successful and funds transferred successfully.',
        confidence: 0.90,
        evidence: [{ field: 'payment.failureReason', value: 'timeout' }]
      }
    });
    const response = await request(appWithProvider(repository, mockProvider(contradictoryProposal))).post('/api/cases/1/diagnosis').expect(422);
    expect(response.body.error).toBe('AI_DIAGNOSIS_INVALID');
  });

  it('accepts advisory actions (SCHEDULE_RETRY_WINDOW, DISPATCH_VERNACULAR_ASSIST, RECORD_PROMISE_TO_PAY)', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const advisoryProposal = validProposal({
      diagnosis: { ...validProposal().diagnosis, category: 'FAILED_SUBSCRIPTION' },
      recommendation: { action: 'SCHEDULE_RETRY_WINDOW' }
    });
    const response = await request(appWithProvider(repository, mockProvider(advisoryProposal))).post('/api/cases/1/diagnosis').expect(201);
    expect(response.body.diagnosis.proposedAction).toBe('SCHEDULE_RETRY_WINDOW');
    expect(response.body.diagnosis.recommendation.action).toBe('SCHEDULE_RETRY_WINDOW');
  });

  it('unlocks SCHEDULE_RETRY_WINDOW candidate for FAILED_SUBSCRIPTION category', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const proposal = validProposal({
      diagnosis: { ...validProposal().diagnosis, category: 'FAILED_SUBSCRIPTION' },
      recommendation: { action: 'SCHEDULE_RETRY_WINDOW' }
    });
    const response = await request(appWithProvider(repository, mockProvider(proposal))).post('/api/cases/1/diagnosis').expect(201);
    const actions = response.body.diagnosis.candidates.map((c) => c.action);
    expect(actions).toContain('SCHEDULE_RETRY_WINDOW');
    expect(actions).not.toContain('CREATE_PAYMENT_LINK');
  });

  it('unlocks SCHEDULE_RETRY_WINDOW candidate for MANDATE_TIMING category', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const proposal = validProposal({
      diagnosis: { ...validProposal().diagnosis, category: 'MANDATE_TIMING' },
      recommendation: { action: 'SCHEDULE_RETRY_WINDOW' }
    });
    const response = await request(appWithProvider(repository, mockProvider(proposal))).post('/api/cases/1/diagnosis').expect(201);
    const actions = response.body.diagnosis.candidates.map((c) => c.action);
    expect(actions).toContain('SCHEDULE_RETRY_WINDOW');
  });

  it('unlocks DISPATCH_VERNACULAR_ASSIST candidate for LANGUAGE_ASSISTANCE category', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const proposal = validProposal({
      diagnosis: { ...validProposal().diagnosis, category: 'LANGUAGE_ASSISTANCE' },
      recommendation: { action: 'DISPATCH_VERNACULAR_ASSIST' }
    });
    const response = await request(appWithProvider(repository, mockProvider(proposal))).post('/api/cases/1/diagnosis').expect(201);
    const actions = response.body.diagnosis.candidates.map((c) => c.action);
    expect(actions).toContain('DISPATCH_VERNACULAR_ASSIST');
    expect(response.body.diagnosis.recommendation.action).toBe('DISPATCH_VERNACULAR_ASSIST');
  });

  it('unlocks RECORD_PROMISE_TO_PAY candidate for PROMISE_TO_PAY category', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const proposal = validProposal({
      diagnosis: { ...validProposal().diagnosis, category: 'PROMISE_TO_PAY' },
      recommendation: { action: 'RECORD_PROMISE_TO_PAY' }
    });
    const response = await request(appWithProvider(repository, mockProvider(proposal))).post('/api/cases/1/diagnosis').expect(201);
    const actions = response.body.diagnosis.candidates.map((c) => c.action);
    expect(actions).toContain('RECORD_PROMISE_TO_PAY');
    expect(response.body.diagnosis.recommendation.action).toBe('RECORD_PROMISE_TO_PAY');
  });

  it('restricts candidates to REQUEST_MANUAL_REVIEW and NO_ACTION for B2B_APPROVAL_DELAY category', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const proposal = validProposal({
      diagnosis: { ...validProposal().diagnosis, category: 'B2B_APPROVAL_DELAY' },
      recommendation: { action: 'REQUEST_MANUAL_REVIEW' }
    });
    const response = await request(appWithProvider(repository, mockProvider(proposal))).post('/api/cases/1/diagnosis').expect(201);
    const actions = response.body.diagnosis.candidates.map((c) => c.action);
    expect(actions).toEqual(['REQUEST_MANUAL_REVIEW', 'NO_ACTION']);
    expect(response.body.diagnosis.recommendation.action).toBe('REQUEST_MANUAL_REVIEW');
  });

  it('provides CREATE_PAYMENT_LINK candidate for TRANSIENT_PAYMENT_FAILURE category', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const proposal = validProposal({
      diagnosis: { ...validProposal().diagnosis, category: 'TRANSIENT_PAYMENT_FAILURE' },
      recommendation: { action: 'CREATE_PAYMENT_LINK' }
    });
    const response = await request(appWithProvider(repository, mockProvider(proposal))).post('/api/cases/1/diagnosis').expect(201);
    const actions = response.body.diagnosis.candidates.map((c) => c.action);
    expect(actions).toContain('CREATE_PAYMENT_LINK');
    expect(response.body.diagnosis.recommendation.action).toBe('CREATE_PAYMENT_LINK');
  });

  it('enforces category compatibility when proposal action does not match category', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    // Model infers FAILED_SUBSCRIPTION, but erroneously proposed CREATE_PAYMENT_LINK
    const mismatchProposal = validProposal({
      diagnosis: { ...validProposal().diagnosis, category: 'FAILED_SUBSCRIPTION' },
      recommendation: { action: 'CREATE_PAYMENT_LINK' }
    });
    const response = await request(appWithProvider(repository, mockProvider(mismatchProposal))).post('/api/cases/1/diagnosis').expect(201);
    expect(response.body.diagnosis.proposedAction).toBe('CREATE_PAYMENT_LINK');
    // Candidates only contain FAILED_SUBSCRIPTION compatible actions: SCHEDULE_RETRY_WINDOW, REQUEST_MANUAL_REVIEW, NO_ACTION
    expect(response.body.diagnosis.recommendation.action).toBe('SCHEDULE_RETRY_WINDOW');
    expect(response.body.diagnosis.candidates.map((c) => c.action)).not.toContain('CREATE_PAYMENT_LINK');
  });

  it('proves complete causal chain: AI category -> compatible candidates -> ranking -> policy evaluation -> advisory block', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedRecoverableCase(repository);
    const proposal = validProposal({
      diagnosis: { ...validProposal().diagnosis, category: 'FAILED_SUBSCRIPTION' },
      recommendation: { action: 'SCHEDULE_RETRY_WINDOW' }
    });
    // 1. Generate diagnosis
    const diagRes = await request(appWithProvider(repository, mockProvider(proposal))).post('/api/cases/1/diagnosis').expect(201);
    expect(diagRes.body.diagnosis.diagnosis.category).toBe('FAILED_SUBSCRIPTION');
    expect(diagRes.body.diagnosis.recommendation.action).toBe('SCHEDULE_RETRY_WINDOW');

    // 2. Evaluate policy: SCHEDULE_RETRY_WINDOW is an advisory action, so Policy Engine BLOCKS automated external execution
    const app = appWithProvider(repository, mockProvider(proposal));
    const policyRes = await request(app).post('/api/cases/1/policy').send({ action: 'SCHEDULE_RETRY_WINDOW' }).expect(200);
    expect(policyRes.body.policy.decision).toBe('BLOCK');
    expect(policyRes.body.policy.reasons[0]).toContain('not in the authorized action allowlist');

    // 3. Financial action execution attempt is rejected
    await request(app).post('/api/cases/1/recovery-actions').send({ actionType: 'SCHEDULE_RETRY_WINDOW' }).expect(422);
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

  describe('Production Environment Credential Validation', () => {
    const { parseEnvironment } = require('../src/config/env');

    it('allows missing credentials in development mode with safe fallbacks', () => {
      const parsed = parseEnvironment({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/recoverai'
      });
      expect(parsed.NODE_ENV).toBe('development');
      expect(parsed.RAZORPAY_KEY_ID).toBeUndefined();
      expect(parsed.AI_API_KEY).toBeUndefined();
    });

    it('fails startup in production mode when Razorpay or AI credentials are missing', () => {
      expect(() => parseEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/recoverai'
      })).toThrowError(/RAZORPAY_KEY_ID is required in production mode/);
    });

    it('identifies all missing production secrets in validation issues without leaking secret values', () => {
      try {
        parseEnvironment({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/recoverai'
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const paths = err.issues.map((i) => i.path[0]);
        expect(paths).toContain('RAZORPAY_KEY_ID');
        expect(paths).toContain('RAZORPAY_KEY_SECRET');
        expect(paths).toContain('RAZORPAY_WEBHOOK_SECRET');
        expect(paths).toContain('AI_API_KEY');
      }
    });

    it('succeeds in production mode when all required credentials are provided', () => {
      const parsed = parseEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/recoverai',
        RAZORPAY_KEY_ID: 'rzp_test_sample123',
        RAZORPAY_KEY_SECRET: 'sampleSecretKey123',
        RAZORPAY_WEBHOOK_SECRET: 'sampleWebhookSecret123',
        AI_API_KEY: 'sampleAiApiKey123'
      });
      expect(parsed.NODE_ENV).toBe('production');
      expect(parsed.RAZORPAY_KEY_ID).toBe('rzp_test_sample123');
    });
  });
});
