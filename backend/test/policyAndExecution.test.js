const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { processEvent } = require('../src/services/eventService');
const { createDiagnosisService } = require('../src/ai/diagnosisService');
const { evaluatePolicy } = require('../src/policy/policyEngine');
const { executePaymentLink, RecoveryExecutorError } = require('../src/actions/paymentLinkExecutor');

const fixedNow = () => new Date('2026-08-31T10:30:00.000Z');

async function seedFailedCase(repository, overrides = {}) {
  await processEvent(repository, {
    eventId: `evt_policy_${Date.now()}_${Math.random()}`,
    eventType: 'payment.failed',
    paymentId: 'pay_policy_001',
    orderId: 'order_policy_001',
    amount: 499900,
    currency: 'INR',
    paymentStatus: 'failed',
    failureReason: 'timeout',
    timestamp: '2026-08-31T10:00:00.000Z',
    ...overrides
  });
  return repository.getCaseDetail(1);
}

function mockProposal(overrides = {}) {
  return {
    diagnosis: {
      cause: 'Payment attempt timed out.',
      confidence: 0.85,
      evidence: [{ field: 'payment.failureReason', value: 'timeout' }],
      ...(overrides.diagnosis || {})
    },
    recommendation: {
      action: 'CREATE_PAYMENT_LINK',
      ...(overrides.recommendation || {})
    }
  };
}

function mockRazorpayClient(overrides = {}) {
  return {
    isConfigured: true,
    isTestMode: true,
    keyId: 'rzp_test_mock123',
    createPaymentLink: vi.fn().mockResolvedValue({
      id: 'plink_test_12345',
      short_url: 'https://rzp.io/i/test12345',
      status: 'created',
      amount: 499900,
      currency: 'INR',
      reference_id: 'razorpay_case_1_plink_v1'
    }),
    ...overrides
  };
}

describe('Milestone 4 — Policy Engine & Bounded Recovery Execution', () => {

  // ================= POLICY ENGINE TESTS ================= //
  describe('Policy Engine Rules', () => {
    it('1. returns ALLOW for normal valid recoverable case with high confidence', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const decision = evaluatePolicy({
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        existingActions: [],
        now: fixedNow
      });
      expect(decision.decision).toBe('ALLOW');
      expect(decision.action).toBe('CREATE_PAYMENT_LINK');
      expect(decision.reasons).toHaveLength(0);
    });

    it('2. returns REVIEW for low AI confidence proposal', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const decision = evaluatePolicy({
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal({ diagnosis: { cause: 'unclear', confidence: 0.4, evidence: [] } }),
        events: detail.events,
        existingActions: [],
        confidenceThreshold: 0.65,
        now: fixedNow
      });
      expect(decision.decision).toBe('REVIEW');
      expect(decision.reasons[0]).toContain('below the automatic execution threshold');
    });

    it('3. returns REVIEW for high-value recovery amount', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository, { amount: 5000000 }); // ₹50,000 > ₹25,000 limit
      const decision = evaluatePolicy({
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        existingActions: [],
        highValueThresholdPaise: 2500000,
        now: fixedNow
      });
      expect(decision.decision).toBe('REVIEW');
      expect(decision.reasons[0]).toContain('exceeds automatic execution limit');
    });

    it('4. returns BLOCK for terminal payment status', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const decision = evaluatePolicy({
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: [{ eventType: 'payment.captured', paymentStatus: 'captured' }],
        existingActions: [],
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('Payment is already terminal');
    });

    it('5. returns BLOCK for resolved or suppressed case status', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      detail.recoveryCase.riskStatus = 'RESOLVED';
      const decision = evaluatePolicy({
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        existingActions: [],
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('Case is in terminal status RESOLVED');
    });

    it('6. returns BLOCK when an active duplicate recovery action exists', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const existingAction = {
        id: 1,
        actionType: 'CREATE_PAYMENT_LINK',
        status: 'EXECUTED',
        providerActionId: 'plink_existing'
      };
      const decision = evaluatePolicy({
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        existingActions: [existingAction],
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('An active or executed recovery action');
    });

    it('7. returns REVIEW when maximum automated recovery attempts are reached', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const existingActions = [
        { id: 1, actionType: 'CREATE_PAYMENT_LINK', status: 'FAILED' },
        { id: 2, actionType: 'CREATE_PAYMENT_LINK', status: 'FAILED' }
      ];
      const decision = evaluatePolicy({
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        existingActions,
        maxAutomatedAttempts: 2,
        now: fixedNow
      });
      expect(decision.decision).toBe('REVIEW');
      expect(decision.reasons[0]).toContain('Maximum automated recovery attempts (2) reached');
    });

    it('8. returns REVIEW when cooldown period has not elapsed', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const tenMinutesAgo = new Date('2026-08-31T10:20:00.000Z');
      const existingActions = [
        { id: 1, actionType: 'CREATE_PAYMENT_LINK', status: 'FAILED', createdAt: tenMinutesAgo.toISOString() }
      ];
      const decisionWithRecent = evaluatePolicy({
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        existingActions,
        cooldownMinutes: 30,
        now: fixedNow
      });
      expect(decisionWithRecent.decision).toBe('REVIEW');
      expect(decisionWithRecent.reasons[0]).toContain('Cooldown period of 30 minutes has not elapsed');
    });

    it('9. returns BLOCK for unsupported candidate action', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const decision = evaluatePolicy({
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        candidateAction: 'UNSUPPORTED_ACTION',
        events: detail.events,
        existingActions: [],
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('not in the authorized action allowlist');
    });

    it('10. returns BLOCK when required case context is missing or invalid', async () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, amount: 0, currency: 'INR' },
        diagnosis: mockProposal(),
        events: [],
        existingActions: [],
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons.some((r) => r.includes('missing or invalid') || r.includes('Invalid recovery amount'))).toBe(true);
    });
  });

  // ================= EXECUTOR TESTS ================= //
  describe('Payment Link Executor', () => {
    it('11 & 16. executes approved Payment Link action and stores returned Payment Link ID', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const rzpClient = mockRazorpayClient();

      const result = await executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        razorpayClient: rzpClient,
        now: fixedNow
      });

      expect(result.executed).toBe(true);
      expect(result.action).toMatchObject({
        status: 'EXECUTED',
        providerActionId: 'plink_test_12345',
        paymentLinkUrl: 'https://rzp.io/i/test12345',
        amount: 499900
      });
      expect(rzpClient.createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({
        amount: 499900,
        currency: 'INR'
      }));
    });

    it('12 & 22. executor cannot run without policy approval and blocks execution', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository, { amount: 5000000 }); // High value -> REVIEW
      const rzpClient = mockRazorpayClient();

      await expect(executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        razorpayClient: rzpClient,
        now: fixedNow
      })).rejects.toThrow('Policy decision is REVIEW');

      expect(rzpClient.createPaymentLink).not.toHaveBeenCalled();
      expect(repository.actions[0].status).toBe('REVIEW_REQUIRED');
    });

    it('13. executor rejects terminal case', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      detail.events.push({ eventType: 'payment.captured', paymentStatus: 'captured' });
      const rzpClient = mockRazorpayClient();

      await expect(executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        razorpayClient: rzpClient,
        now: fixedNow
      })).rejects.toThrow('Policy decision is BLOCK');

      expect(rzpClient.createPaymentLink).not.toHaveBeenCalled();
    });

    it('14. executor preserves exact amount from recovery case', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository, { amount: 125050 }); // ₹1,250.50
      const rzpClient = mockRazorpayClient();

      const result = await executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        razorpayClient: rzpClient,
        now: fixedNow
      });

      expect(result.action.amount).toBe(125050);
      expect(rzpClient.createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({ amount: 125050 }));
    });

    it('15. executor blocks execution when not in Test Mode', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const rzpClient = mockRazorpayClient({ isTestMode: false });

      await expect(executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        razorpayClient: rzpClient,
        now: fixedNow
      })).rejects.toThrow('not configured for Razorpay Test Mode');

      expect(rzpClient.createPaymentLink).not.toHaveBeenCalled();
    });

    it('17 & 23. repeated execution is idempotent and returns existing action', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const rzpClient = mockRazorpayClient();

      const first = await executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        razorpayClient: rzpClient,
        now: fixedNow
      });

      const second = await executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        razorpayClient: rzpClient,
        now: fixedNow
      });

      expect(second.duplicate).toBe(true);
      expect(second.action.id).toBe(first.action.id);
      expect(rzpClient.createPaymentLink).toHaveBeenCalledTimes(1);
    });

    it('18 & 27. Razorpay API failure persists FAILED state and logs failure audit', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const rzpClient = mockRazorpayClient({
        createPaymentLink: vi.fn().mockRejectedValue(new Error('Razorpay API error: Service Unavailable'))
      });

      await expect(executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        razorpayClient: rzpClient,
        now: fixedNow
      })).rejects.toThrow('Razorpay API error: Service Unavailable');

      expect(repository.actions[0].status).toBe('FAILED');
      expect(repository.audits.some((a) => a.eventType === 'ACTION_EXECUTION_FAILED')).toBe(true);
    });

    it('19. creating a Payment Link does NOT mark recoveryCase as RESOLVED or money recovered', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const rzpClient = mockRazorpayClient();

      await executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: mockProposal(),
        events: detail.events,
        razorpayClient: rzpClient,
        now: fixedNow
      });

      const updated = await repository.findCaseByPaymentId(detail.recoveryCase.paymentId);
      expect(updated.riskStatus).toBe('RECOVERABLE'); // Still RECOVERABLE, not RESOLVED
      expect(updated.outcome).toBeNull(); // Money is NOT recovered yet
    });
  });

  // ================= API ENDPOINT TESTS ================= //
  describe('Policy & Recovery Action APIs', () => {
    it('20. POST /api/cases/:id/policy evaluates policy and returns decision', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository);
      const app = createApp(repository, {
        diagnosisService: createDiagnosisService({ provider: { diagnose: vi.fn().mockResolvedValue(mockProposal()) } }),
        razorpayClient: mockRazorpayClient()
      });

      const response = await request(app).post('/api/cases/1/policy').expect(200);

      expect(response.body.policy).toMatchObject({
        decision: 'ALLOW',
        action: 'CREATE_PAYMENT_LINK',
        policyVersion: 'recoverai-policy-v1'
      });
      expect(repository.audits.some((a) => a.eventType === 'POLICY_EVALUATED')).toBe(true);
    });

    it('21. POST /api/cases/:id/recovery-actions executes recovery action when allowed', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository);
      const rzpClient = mockRazorpayClient();
      const app = createApp(repository, {
        diagnosisService: createDiagnosisService({ provider: { diagnose: vi.fn().mockResolvedValue(mockProposal()) } }),
        razorpayClient: rzpClient
      });

      const response = await request(app).post('/api/cases/1/recovery-actions').send({ action: 'CREATE_PAYMENT_LINK' }).expect(201);

      expect(response.body.executed).toBe(true);
      expect(response.body.action).toMatchObject({
        status: 'EXECUTED',
        providerActionId: 'plink_test_12345',
        paymentLinkUrl: 'https://rzp.io/i/test12345'
      });
    });

    it('22. POST /api/cases/:id/recovery-actions rejects execution when policy blocks or demands review', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository, { amount: 10000000 }); // ₹100,000 > ₹25,000 -> REVIEW
      const rzpClient = mockRazorpayClient();
      const app = createApp(repository, {
        diagnosisService: createDiagnosisService({ provider: { diagnose: vi.fn().mockResolvedValue(mockProposal()) } }),
        razorpayClient: rzpClient
      });

      const response = await request(app).post('/api/cases/1/recovery-actions').send({ action: 'CREATE_PAYMENT_LINK' }).expect(422);

      expect(response.body.error).toBe('EXECUTION_REJECTED');
      expect(rzpClient.createPaymentLink).not.toHaveBeenCalled();
    });

    it('23. GET /api/cases/:id/recovery-actions returns executed recovery actions for case', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository);
      const app = createApp(repository, {
        diagnosisService: createDiagnosisService({ provider: { diagnose: vi.fn().mockResolvedValue(mockProposal()) } }),
        razorpayClient: mockRazorpayClient()
      });

      await request(app).post('/api/cases/1/recovery-actions').expect(201);
      const response = await request(app).get('/api/cases/1/recovery-actions').expect(200);

      expect(response.body.actions).toHaveLength(1);
      expect(response.body.actions[0]).toMatchObject({ status: 'EXECUTED', providerActionId: 'plink_test_12345' });
    });
  });

  // ================= AUDIT TRAIL TESTS ================= //
  describe('Audit Trail Verification', () => {
    it('24 & 26. records POLICY_EVALUATED, ACTION_EXECUTION_STARTED, and ACTION_EXECUTED audits', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository);
      const app = createApp(repository, {
        diagnosisService: createDiagnosisService({ provider: { diagnose: vi.fn().mockResolvedValue(mockProposal()) } }),
        razorpayClient: mockRazorpayClient()
      });

      await request(app).post('/api/cases/1/recovery-actions').expect(201);

      const auditTypes = repository.audits.map((a) => a.eventType);
      expect(auditTypes).toContain('POLICY_EVALUATED');
      expect(auditTypes).toContain('ACTION_EXECUTION_STARTED');
      expect(auditTypes).toContain('ACTION_EXECUTED');
    });

    it('25. records ACTION_REVIEW_REQUIRED audit on policy review decision', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository, { amount: 5000000 }); // High value -> REVIEW
      const app = createApp(repository, {
        diagnosisService: createDiagnosisService({ provider: { diagnose: vi.fn().mockResolvedValue(mockProposal()) } }),
        razorpayClient: mockRazorpayClient()
      });

      await request(app).post('/api/cases/1/recovery-actions').expect(422);

      const auditTypes = repository.audits.map((a) => a.eventType);
      expect(auditTypes).toContain('POLICY_EVALUATED');
      expect(auditTypes).toContain('ACTION_REVIEW_REQUIRED');
    });
  });

  // ================= RAZORPAY CLIENT & TEST MODE SAFETY ================= //
  describe('Razorpay Client & Test Mode Safety', () => {
    const { createRazorpayClient, isTestModeKey } = require('../src/services/razorpayClient');

    it('28. isTestModeKey correctly validates rzp_test_ prefix', () => {
      expect(isTestModeKey('rzp_test_12345678')).toBe(true);
      expect(isTestModeKey('rzp_live_12345678')).toBe(false);
      expect(isTestModeKey('')).toBe(false);
      expect(isTestModeKey(null)).toBe(false);
      expect(isTestModeKey(undefined)).toBe(false);
    });

    it('29. blocks execution when credentials are missing or unconfigured', async () => {
      const client = createRazorpayClient({ keyId: null, keySecret: null });
      expect(client.isConfigured).toBe(false);
      expect(client.isTestMode).toBe(false);

      await expect(client.createPaymentLink({ amount: 1000, referenceId: 'ref_1' }))
        .rejects.toThrow('Razorpay API credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are not configured.');
    });

    it('30. blocks execution when live key is provided', async () => {
      const client = createRazorpayClient({ keyId: 'rzp_live_dangerous_123', keySecret: 'secret_123' });
      expect(client.isConfigured).toBe(true);
      expect(client.isTestMode).toBe(false);

      await expect(client.createPaymentLink({ amount: 1000, referenceId: 'ref_1' }))
        .rejects.toThrow('Razorpay key is not a Test Mode key (must start with rzp_test_). Execution blocked.');
    });

    it('31. getPaymentLinksByReferenceId filters out links with different reference_id in memory', async () => {
      const client = createRazorpayClient({ keyId: 'rzp_test_mock123', keySecret: 'secret_123' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          payment_links: [
            { id: 'plink_case_1', amount: 10000, currency: 'INR', reference_id: 'razorpay_case_1_plink_v1', short_url: 'https://rzp.io/1' },
            { id: 'plink_case_2', amount: 50000, currency: 'INR', reference_id: 'razorpay_case_2_plink_v1', short_url: 'https://rzp.io/2' }
          ]
        })
      });

      const matched = await client.getPaymentLinksByReferenceId('razorpay_case_2_plink_v1');
      expect(matched).toHaveLength(1);
      expect(matched[0].id).toBe('plink_case_2');

      const unmatched = await client.getPaymentLinksByReferenceId('razorpay_case_3_plink_v1');
      expect(unmatched).toHaveLength(0);

      fetchSpy.mockRestore();
    });

    it('32. executePaymentLink does not mistake an unrelated Payment Link for current case', async () => {
      const repository = new InMemoryRecoveryRepository();
      const caseDetail = await seedFailedCase(repository, { amount: 50000 });
      caseDetail.recoveryCase.id = 2; // Case #2 (50000 paise)

      // Razorpay returns an unrelated link from Case 1 (10000 paise)
      const razorpayClient = {
        isConfigured: true,
        isTestMode: true,
        keyId: 'rzp_test_mock123',
        getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([
          { id: 'plink_unrelated_case_1', amount: 10000, currency: 'INR', reference_id: 'razorpay_case_1_plink_v1', short_url: 'https://rzp.io/1' }
        ]),
        createPaymentLink: vi.fn().mockResolvedValue({
          id: 'plink_new_case_2',
          amount: 50000,
          currency: 'INR',
          reference_id: 'razorpay_case_2_plink_v1',
          short_url: 'https://rzp.io/case2',
          status: 'created'
        })
      };

      const result = await executePaymentLink(repository, {
        recoveryCase: caseDetail.recoveryCase,
        diagnosis: mockProposal(),
        events: caseDetail.events,
        razorpayClient
      });

      expect(result.executed).toBe(true);
      expect(razorpayClient.createPaymentLink).toHaveBeenCalledTimes(1);
      expect(result.action.providerActionId).toBe('plink_new_case_2');
    });
  });
});
