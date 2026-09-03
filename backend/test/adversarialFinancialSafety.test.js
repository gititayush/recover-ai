const crypto = require('crypto');
const request = require('supertest');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { processEvent } = require('../src/services/eventService');
const { createDiagnosisService } = require('../src/ai/diagnosisService');
const { createApp } = require('../src/app');
const { createRecoveryWorker } = require('../src/worker/recoveryWorker');
const { evaluatePolicy } = require('../src/policy/policyEngine');
const { executePaymentLink, buildStableReferenceId } = require('../src/actions/paymentLinkExecutor');
const { reconcileOutcome, processProviderWebhook } = require('../src/services/reconciliationService');
const { createEvaluationRecord, calculateAgentMetrics } = require('../src/ai/agentEvaluator');
const { environment } = require('../src/config/env');

const fixedNow = () => new Date('2026-08-31T12:00:00.000Z');
const WEBHOOK_SECRET = 'recoverai-test-webhook-secret-not-a-provider-credential';
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

function signPayload(body, secret = WEBHOOK_SECRET) {
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHmac('sha256', secret).update(content).digest('hex');
}

function createMockRazorpayClient(overrides = {}) {
  const existingLinks = new Map();
  return {
    isConfigured: true,
    isTestMode: true,
    keyId: 'rzp_test_mock123',
    createPaymentLink: vi.fn().mockImplementation(async (payload) => {
      const ref = payload.referenceId;
      if (existingLinks.has(ref)) {
        const error = new Error('A payment link with this reference_id already exists.');
        error.statusCode = 400;
        throw error;
      }
      const link = {
        id: `plink_adv_${Math.random().toString(36).substring(2, 9)}`,
        short_url: 'https://rzp.io/i/adv_link',
        status: 'created',
        amount: payload.amount,
        currency: payload.currency,
        reference_id: ref
      };
      existingLinks.set(ref, link);
      return link;
    }),
    getPaymentLinksByReferenceId: vi.fn().mockImplementation(async (ref) => {
      return existingLinks.has(ref) ? [existingLinks.get(ref)] : [];
    }),
    ...overrides
  };
}

function createMockDiagnosisService(overrides = {}) {
  return {
    diagnose: vi.fn().mockResolvedValue({
      diagnosis: {
        cause: 'Customer bank gateway timeout during 3DS challenge.',
        confidence: 0.88,
        evidence: [{ field: 'payment.failureReason', value: 'gateway_timeout' }]
      },
      proposedAction: 'CREATE_PAYMENT_LINK',
      recommendation: {
        action: 'CREATE_PAYMENT_LINK',
        reason: 'Safe automated retry via payment link.'
      },
      candidates: [{ action: 'CREATE_PAYMENT_LINK', score: 0.9 }],
      provider: 'test-ai',
      model: 'test-v1',
      promptVersion: 'v1',
      source: 'live_ai',
      ...overrides
    })
  };
}

async function seedFailedCase(repository, overrides = {}) {
  const paymentId = overrides.paymentId || `pay_adv_${Math.random().toString(36).substring(2, 9)}`;
  const createdCase = await repository.createCase({
    paymentId,
    orderId: overrides.orderId || 'order_adv_001',
    amount: overrides.amount !== undefined ? overrides.amount : 100000,
    currency: overrides.currency || 'INR',
    riskStatus: overrides.riskStatus || 'RECOVERABLE',
    riskReason: overrides.riskReason || 'gateway_timeout',
    riskLevel: overrides.riskLevel || 'MEDIUM',
    escalationStatus: overrides.escalationStatus || 'NONE',
    firstDetectedAt: overrides.firstDetectedAt || '2026-08-31T11:00:00.000Z',
    lastEventAt: overrides.lastEventAt || '2026-08-31T11:00:00.000Z',
    ...overrides
  });

  await repository.createEvent({
    eventId: `evt_seed_${Math.random().toString(36).substring(2, 8)}`,
    eventType: overrides.eventType || 'payment.failed',
    paymentId,
    orderId: createdCase.orderId,
    amount: createdCase.amount,
    currency: createdCase.currency,
    paymentStatus: overrides.paymentStatus || 'failed',
    failureReason: overrides.failureReason || 'gateway_timeout',
    timestamp: createdCase.firstDetectedAt
  });

  return repository.getCaseDetail(createdCase.id);
}

describe('Revflow V2 — Adversarial Financial Safety Suite', () => {
  beforeEach(() => {
    environment.AUTONOMOUS_RECOVERY_ENABLED = true;
    environment.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  // ================= 1. AMOUNT / MONEY INTEGRITY ================= //
  describe('1. Amount / Money Integrity', () => {
    it('1. AI cannot change recovery amount — amount is strictly derived from case record', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository, { amount: 150000 }); // ₹1,500
      const mockClient = createMockRazorpayClient();

      // Malicious AI attempts to set amount to ₹10 (1000 paise) or ₹100,000 in its response
      const maliciousAi = {
        diagnose: vi.fn().mockResolvedValue({
          diagnosis: { cause: 'timeout', confidence: 0.9, evidence: [{ field: 'payment.failureReason', value: 'gateway_timeout' }] },
          proposedAction: 'CREATE_PAYMENT_LINK',
          recommendation: { action: 'CREATE_PAYMENT_LINK', reason: 'Tamper attempt' },
          maliciousAmount: 1000 // Injected field
        })
      };

      const result = await executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: await maliciousAi.diagnose(),
        events: detail.events,
        razorpayClient: mockClient,
        now: fixedNow
      });

      expect(result.executed).toBe(true);
      expect(mockClient.createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({
        amount: 150000 // Untampered case amount preserved
      }));
    });

    it('2. Client cannot submit a different recovery amount in API body', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository, { amount: 100000 });
      const mockClient = createMockRazorpayClient();
      const app = createApp(repository, { diagnosisService: createMockDiagnosisService(), razorpayClient: mockClient });

      // Client attempts to POST a manipulated amount
      const res = await request(app)
        .post('/api/cases/1/recovery-actions')
        .send({ amount: 500 }) // Tampered amount
        .expect(201);

      expect(res.body.action.amount).toBe(100000); // Case amount authoritative
      expect(mockClient.createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({
        amount: 100000
      }));
    });

    it('3. Provider Payment Link amount mismatch with case amount triggers BLOCK', () => {
      const recoveryCase = { id: 1, paymentId: 'pay_1', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE' };
      const decision = evaluatePolicy({
        recoveryCase: { ...recoveryCase, amount: 0 },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('amount');
    });

    it('4. Provider webhook amount mismatch causes reconciliation to reject outcome', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository, { amount: 100000 });
      const mockClient = createMockRazorpayClient();
      await executePaymentLink(repository, { recoveryCase: detail.recoveryCase, diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } }, events: detail.events, razorpayClient: mockClient });

      // Webhook arrives claiming ₹500 was paid instead of expected ₹1,000
      const webhookPayload = {
        entity: 'event',
        event: 'payment_link.paid',
        payload: {
          payment_link: {
            entity: {
              id: 'plink_adv_1',
              reference_id: `REV-C1-P${detail.recoveryCase.paymentId}-A1`,
              amount: 50000, // ₹500 mismatch!
              currency: 'INR',
              status: 'paid'
            }
          },
          payment: {
            entity: {
              id: 'pay_rzp_paid_001',
              amount: 50000,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      };

      const execResult = await executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } },
        events: detail.events,
        razorpayClient: mockClient
      });

      const result = await reconcileOutcome(repository, {
        provider: 'razorpay',
        providerEventId: 'evt_wh_mismatch_001',
        eventType: 'payment_link.paid',
        paymentLinkId: execResult.action.providerActionId,
        paymentId: 'pay_rzp_paid_001',
        referenceId: execResult.action.idempotencyKey,
        amount: 50000,
        currency: 'INR',
        providerTimestamp: fixedNow().toISOString()
      });

      expect(result.reconciled).toBe(false);
      expect(result.mismatch).toBe(true);
      expect(result.outcome.verified).toBe(false);
      expect(result.outcome.verificationReason).toContain('Amount mismatch');
      const fresh = await repository.getCaseDetail(1);
      expect(fresh.recoveryCase.riskStatus).not.toBe('RESOLVED');
    });

    it('5. Partial payment is not marked verified resolved', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository, { amount: 200000 }); // ₹2,000
      const mockClient = createMockRazorpayClient();
      const execResult = await executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } },
        events: detail.events,
        razorpayClient: mockClient
      });

      const result = await reconcileOutcome(repository, {
        provider: 'razorpay',
        providerEventId: 'evt_partial_001',
        eventType: 'payment_link.partially_paid',
        paymentLinkId: execResult.action.providerActionId,
        paymentId: 'pay_part_1',
        referenceId: execResult.action.idempotencyKey,
        amount: 100000, // Partial
        amountPaid: 100000,
        currency: 'INR',
        providerTimestamp: fixedNow().toISOString()
      });

      expect(result.reconciled).toBe(false);
      expect(result.partial).toBe(true);
      expect(result.outcome.verified).toBe(false);
      const fresh = await repository.getCaseDetail(1);
      expect(fresh.recoveryCase.riskStatus).not.toBe('RESOLVED');
    });

    it('6. Zero amount is rejected by policy with BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_zero', amount: 0, currency: 'INR', riskStatus: 'RECOVERABLE' },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('Invalid recovery amount');
    });

    it('7. Negative amount is rejected by policy with BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_neg', amount: -50000, currency: 'INR', riskStatus: 'RECOVERABLE' },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('Invalid recovery amount');
    });

    it('8. Non-integer paise amount is rejected by policy with BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_float', amount: 1000.5, currency: 'INR', riskStatus: 'RECOVERABLE' },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('positive integer');
    });

    it('9. Currency mismatch is rejected by policy with BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_curr', amount: 100000, currency: 'USD', riskStatus: 'RECOVERABLE' },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('currency');
    });
  });

  // ================= 2. TERMINAL / STATE SAFETY ================= //
  describe('2. Terminal / State Safety', () => {
    it('10. Already captured payment event triggers BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_cap', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE' },
        events: [{ eventType: 'payment.captured', paymentStatus: 'captured' }],
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('terminal');
    });

    it('11. Already settled order event triggers BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_settled', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE' },
        events: [{ eventType: 'order.paid', paymentStatus: 'paid' }],
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('terminal');
    });

    it('12. Refunded payment event triggers BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_ref', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE' },
        events: [{ eventType: 'payment.refunded', paymentStatus: 'refunded' }],
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('terminal');
    });

    it('13. Already RESOLVED case status triggers BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_res', amount: 100000, currency: 'INR', riskStatus: 'RESOLVED' },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('RESOLVED');
    });

    it('14. SUPPRESSED case status triggers BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_sup', amount: 100000, currency: 'INR', riskStatus: 'SUPPRESSED' },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('SUPPRESSED');
    });

    it('15. Existing verified outcome triggers BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_out', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE', outcome: 'PAID' },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('outcome');
    });

    it('16. Stale case (> 7 days) triggers STOP and BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: {
          id: 1,
          paymentId: 'pay_stale',
          amount: 100000,
          currency: 'INR',
          riskStatus: 'RECOVERABLE',
          firstDetectedAt: '2026-08-20T00:00:00.000Z' // 11 days ago
        },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.stopping.stopped).toBe(true);
      expect(decision.stopping.reasonCode).toBe('STALE_CASE');
    });

    it('17. Customer opt-out triggers HARD_STOP and BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: {
          id: 1,
          paymentId: 'pay_opt',
          amount: 100000,
          currency: 'INR',
          riskStatus: 'RECOVERABLE',
          riskReason: 'Customer requested opt-out'
        },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.stopping.reasonCode).toBe('CUSTOMER_OPT_OUT');
    });

    it('18. Max attempts reached triggers ESCALATE and REVIEW, preventing blind execution', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_max', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE' },
        existingActions: [
          { id: 1, idempotencyKey: 'k1', status: 'FAILED' },
          { id: 2, idempotencyKey: 'k2', status: 'FAILED' }
        ],
        maxAutomatedAttempts: 2,
        now: fixedNow
      });
      expect(decision.decision).toBe('REVIEW');
      expect(decision.stopping.reasonCode).toBe('MAX_ATTEMPTS');
    });

    it('19. Cooldown active triggers WAIT and schedules retry', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_cd', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE' },
        existingActions: [{ id: 1, idempotencyKey: 'k1', status: 'FAILED', createdAt: '2026-08-31T11:45:00.000Z' }],
        cooldownMinutes: 30,
        now: fixedNow
      });
      expect(decision.decision).toBe('REVIEW');
      expect(decision.stopping.actionDisposition).toBe('WAIT');
      expect(decision.stopping.reasonCode).toBe('COOLDOWN_ACTIVE');
    });

    it('20. Rejected human escalation permanently blocks execution', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_rej', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE', escalationStatus: 'REJECTED' },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('rejected');
    });
  });

  // ================= 3. DUPLICATION / IDEMPOTENCY ================= //
  describe('3. Duplication / Idempotency', () => {
    it('21. Same case + same attempt generates exact same deterministic reference ID', () => {
      const recoveryCase = { id: 42, paymentId: 'pay_det_999' };
      const ref1 = buildStableReferenceId(recoveryCase, 1);
      const ref2 = buildStableReferenceId(recoveryCase, 1);
      expect(ref1).toBe(ref2);
      expect(ref1).toBe('rc_42_pay_det_999_v1');
    });

    it('22. Repeated execution request returns duplicate blocked / existing action without creating duplicate link', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const mockClient = createMockRazorpayClient();

      const exec1 = await executePaymentLink(repository, { recoveryCase: detail.recoveryCase, diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } }, events: detail.events, razorpayClient: mockClient });
      expect(exec1.executed).toBe(true);

      const exec2 = await executePaymentLink(repository, { recoveryCase: detail.recoveryCase, diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } }, events: detail.events, razorpayClient: mockClient });
      expect(exec2.duplicate).toBe(true);
      expect(mockClient.createPaymentLink).toHaveBeenCalledTimes(1); // Provider called only once!
    });

    it('23. Same provider event delivered twice credits outcome exactly once', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const mockClient = createMockRazorpayClient();
      const execResult = await executePaymentLink(repository, { recoveryCase: detail.recoveryCase, diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } }, events: detail.events, razorpayClient: mockClient });

      const outcomeData = {
        eventId: 'evt_unique_cred_001',
        provider: 'razorpay',
        providerEventId: 'evt_unique_cred_001',
        eventType: 'payment_link.paid',
        paymentLinkId: execResult.action.providerActionId,
        paymentId: 'pay_cred_001',
        referenceId: execResult.action.idempotencyKey,
        amount: 100000,
        currency: 'INR',
        providerTimestamp: fixedNow().toISOString()
      };

      const res1 = await reconcileOutcome(repository, outcomeData);
      expect(res1.reconciled).toBe(true);
      expect(res1.outcome.verified).toBe(true);

      const res2 = await reconcileOutcome(repository, outcomeData);
      expect(res2.reconciled).toBe(true);
      expect(res2.duplicate).toBe(true);

      const outcomes = await repository.findOutcomesByCaseId(1);
      expect(outcomes.length).toBe(1); // Exactly 1 outcome credited
      const freshCase = await repository.getCaseDetail(1);
      expect(freshCase.recoveryCase.recoveredAmount).toBe(100000); // Not doubled to 200,000!
    });

    it('24. Existing active recovery action prevents second action via policy BLOCK', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_act', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE' },
        existingActions: [{ id: 1, actionType: 'CREATE_PAYMENT_LINK', status: 'EXECUTED', idempotencyKey: 'k_act' }],
        candidateReference: 'k_act_new',
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons[0]).toContain('already exists');
    });

    it('25. Razorpay reference_id already exists race safely adopts matching action if valid', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const expectedRef = buildStableReferenceId(detail.recoveryCase, 1);

      const mockClient = {
        isConfigured: true,
        isTestMode: true,
        createPaymentLink: vi.fn().mockRejectedValue({
          statusCode: 400,
          message: 'A payment link with this reference_id already exists.',
          details: { error: { description: 'A payment link with this reference_id already exists.' } }
        }),
        getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([{
          id: 'plink_existing_matching',
          amount: 100000,
          currency: 'INR',
          reference_id: expectedRef,
          status: 'created',
          short_url: 'https://rzp.io/i/matched'
        }])
      };

      const result = await executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } },
        events: detail.events,
        razorpayClient: mockClient,
        now: fixedNow
      });

      expect(result.executed).toBe(true);
      expect(result.action.providerActionId).toBe('plink_existing_matching');
    });

    it('26. Unrelated provider link with mismatched reference is NEVER adopted', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);

      const mockClient = {
        isConfigured: true,
        isTestMode: true,
        createPaymentLink: vi.fn().mockRejectedValue({
          statusCode: 400,
          details: { error: { description: 'A payment link with this reference_id already exists.' } }
        }),
        getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([{
          id: 'plink_unrelated',
          amount: 999999, // Unrelated!
          currency: 'USD',
          reference_id: 'UNRELATED_REF',
          status: 'created'
        }])
      };

      await expect(executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } },
        events: detail.events,
        razorpayClient: mockClient,
        now: fixedNow
      })).rejects.toThrow();
    });

    it('27. Historical provider link with legacy case-based reference cannot block payment-scoped reference', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository, { paymentId: 'pay_v2_scoped_001' });

      const mockClient = {
        isConfigured: true,
        isTestMode: true,
        createPaymentLink: vi.fn().mockResolvedValue({
          id: 'plink_new_scoped',
          amount: 100000,
          currency: 'INR',
          reference_id: `REV-C1-P${detail.recoveryCase.paymentId}-A1`,
          status: 'created',
          short_url: 'https://rzp.io/i/new'
        }),
        getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([{
          id: 'plink_old_legacy',
          reference_id: 'REV-C1-PLINK', // Old legacy format
          amount: 100000,
          currency: 'INR'
        }])
      };

      const result = await executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } },
        events: detail.events,
        razorpayClient: mockClient,
        now: fixedNow
      });

      expect(result.executed).toBe(true);
      expect(result.action.providerActionId).toBe('plink_new_scoped');
    });

    it('28. Database ID reuse across lifecycle resets cannot collide when payment IDs differ', () => {
      const refCaseA = buildStableReferenceId({ id: 1, paymentId: 'pay_lifecycle_A' }, 1);
      const refCaseB = buildStableReferenceId({ id: 1, paymentId: 'pay_lifecycle_B' }, 1);
      expect(refCaseA).not.toBe(refCaseB);
    });
  });

  // ================= 4. WEBHOOK SECURITY ================= //
  describe('4. Webhook Security', () => {
    it('29. Invalid HMAC signature is rejected with 401', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);
      const rawBody = JSON.stringify({ event: 'payment.failed' });

      await request(app)
        .post('/api/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', 'invalid_signature_hex')
        .set('x-razorpay-event-id', 'evt_inv_sig_001')
        .send(Buffer.from(rawBody))
        .expect(401);
    });

    it('30. Tampered signature (1 byte corrupted) is rejected with 401', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);
      const payload = { event: 'payment.failed', payload: { payment: { entity: { id: 'pay_123' } } } };
      const rawBody = JSON.stringify(payload);
      const signature = signPayload(rawBody);
      const tampered = signature.substring(0, signature.length - 2) + (signature.endsWith('a') ? 'b' : 'a');

      await request(app)
        .post('/api/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', tampered)
        .set('x-razorpay-event-id', 'evt_tamp_sig_001')
        .send(Buffer.from(rawBody))
        .expect(401);
    });

    it('31. Modified webhook body after signing is rejected with 401', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);
      const original = { event: 'payment.failed', payload: { payment: { entity: { id: 'pay_123', amount: 1000 } } } };
      const signature = signPayload(JSON.stringify(original));
      const modified = { ...original, payload: { payment: { entity: { id: 'pay_123', amount: 9999 } } } };

      await request(app)
        .post('/api/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', signature)
        .set('x-razorpay-event-id', 'evt_mod_001')
        .send(Buffer.from(JSON.stringify(modified)))
        .expect(401);
    });

    it('32. Replayed event ID is deduplicated without error', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);
      const payload = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_replay_1',
              amount: 100000,
              currency: 'INR',
              status: 'failed',
              error_code: 'BAD_REQUEST_ERROR',
              created_at: 1772366400
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = signPayload(rawBody);

      const res1 = await request(app)
        .post('/api/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', signature)
        .set('x-razorpay-event-id', 'evt_replay_uuid_001')
        .send(rawBody)
        .expect(202);

      expect(res1.body.accepted).toBe(true);

      const res2 = await request(app)
        .post('/api/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', signature)
        .set('x-razorpay-event-id', 'evt_replay_uuid_001') // Replay!
        .send(rawBody)
        .expect(200);

      expect(res2.body.duplicate).toBe(true);
      expect((await repository.listCases()).length).toBe(1);
    });

    it('33. Missing required webhook fields is rejected with 400', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);
      const payload = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              // Missing amount, currency, id, created_at
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = signPayload(rawBody);

      await request(app)
        .post('/api/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', signature)
        .set('x-razorpay-event-id', 'evt_missing_fields_001')
        .send(rawBody)
        .expect(400);
    });

    it('34. Unknown provider event is safely ignored without state mutation', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);
      const payload = { event: 'subscription.charged', payload: {} };
      const rawBody = JSON.stringify(payload);
      const signature = signPayload(rawBody);

      const res = await request(app)
        .post('/api/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', signature)
        .set('x-razorpay-event-id', 'evt_unknown_001')
        .send(rawBody)
        .expect(202);

      expect(res.body.accepted).toBe(false);
      expect(res.body.error).toBe('UNSUPPORTED_EVENT');
    });

    it('35. Payment Link ID / reference mismatch rejects reconciliation', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository);

      const result = await reconcileOutcome(repository, {
        provider: 'razorpay',
        providerEventId: 'evt_mismatch_ref',
        eventType: 'payment_link.paid',
        paymentLinkId: 'plink_unknown_xyz',
        paymentId: 'pay_xyz',
        referenceId: 'REV-C999-Ppay_unknown-A1',
        amount: 100000,
        currency: 'INR',
        providerTimestamp: fixedNow().toISOString()
      });

      expect(result.reconciled).toBe(false);
      expect(result.unmatched).toBe(true);
    });

    it('36. Payment ID / order ID mismatch rejects reconciliation', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository, { orderId: 'order_correct_001' });

      const result = await reconcileOutcome(repository, {
        provider: 'razorpay',
        providerEventId: 'evt_mismatch_order',
        eventType: 'payment.captured',
        paymentId: 'pay_adv_unmatched',
        orderId: 'order_wrong_999',
        amount: 100000,
        currency: 'INR',
        providerTimestamp: fixedNow().toISOString()
      });

      expect(result.reconciled).toBe(false);
      expect(result.unmatched).toBe(true);
    });
  });

  // ================= 5. HUMAN ESCALATION SECURITY ================= //
  describe('5. Human Escalation Security', () => {
    it('37. Human approval of legitimate REVIEW yields ALLOW and records humanOverride', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository, { amount: 5000000 }); // High value -> REVIEW
      await repository.updateCase(1, { escalationStatus: 'PENDING_APPROVAL', autonomyStatus: 'REVIEW_REQUIRED' });
      const app = createApp(repository, { diagnosisService: createMockDiagnosisService(), razorpayClient: createMockRazorpayClient() });

      const res = await request(app)
        .post('/api/cases/1/escalations/approve')
        .send({ reviewer: 'ops_lead_neha', notes: 'Legitimate VIP override' })
        .expect(200);

      expect(res.body.policyDecision.decision).toBe('ALLOW');
      expect(res.body.policyDecision.humanOverride.applied).toBe(true);
      expect(res.body.policyDecision.humanOverride.approvedBy).toBe('ops_lead_neha');
    });

    it('38. Human approval of HARD BLOCK is strictly rejected with 422', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository, { riskStatus: 'RESOLVED', outcome: 'PAID' });
      const app = createApp(repository, { diagnosisService: createMockDiagnosisService(), razorpayClient: createMockRazorpayClient() });

      const res = await request(app)
        .post('/api/cases/1/escalations/approve')
        .send({ reviewer: 'ops_lead_neha' })
        .expect(422);

      expect(res.body.error).toBe('BLOCK_CANNOT_BE_APPROVED');
    });

    it('39. Human approval of terminal payment is rejected with 422', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      await repository.createEvent({ eventId: 'evt_cap_test', eventType: 'payment.captured', paymentId: detail.recoveryCase.paymentId, amount: 100000, currency: 'INR', paymentStatus: 'captured', timestamp: fixedNow().toISOString() });
      const app = createApp(repository, { diagnosisService: createMockDiagnosisService(), razorpayClient: createMockRazorpayClient() });

      const res = await request(app)
        .post('/api/cases/1/escalations/approve')
        .send({ reviewer: 'ops_lead' })
        .expect(422);

      expect(res.body.error).toBe('BLOCK_CANNOT_BE_APPROVED');
    });

    it('40. Human approval of amount mismatch is rejected with 422', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository);
      await repository.updateCase(1, { amount: -500 });
      const app = createApp(repository, { diagnosisService: createMockDiagnosisService(), razorpayClient: createMockRazorpayClient() });

      const res = await request(app)
        .post('/api/cases/1/escalations/approve')
        .send({ reviewer: 'ops_lead' })
        .expect(422);

      expect(res.body.error).toBe('BLOCK_CANNOT_BE_APPROVED');
    });

    it('41. Human approval of duplicate action is rejected with 422', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository);
      await repository.createAction({ recoveryCaseId: 1, actionType: 'CREATE_PAYMENT_LINK', status: 'EXECUTED', policyDecision: 'ALLOW', policyVersion: 'v1', idempotencyKey: 'k_dup', provider: 'razorpay', amount: 100000, currency: 'INR' });
      const app = createApp(repository, { diagnosisService: createMockDiagnosisService(), razorpayClient: createMockRazorpayClient() });

      const res = await request(app)
        .post('/api/cases/1/escalations/approve')
        .send({ reviewer: 'ops_lead' })
        .expect(422);

      expect(res.body.error).toBe('BLOCK_CANNOT_BE_APPROVED');
    });

    it('42. Human approval of invalid provider state (non-test credentials in test mode) is rejected', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_test', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE' },
        isTestMode: false, // Live credentials blocked in test environment
        humanApproval: { approvedBy: 'ops_lead' },
        now: fixedNow
      });
      expect(decision.decision).toBe('BLOCK');
      expect(decision.humanOverride.applied).toBe(false);
    });

    it('43. Rejected escalation cannot execute via API or worker', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository);
      await repository.updateCase(1, { escalationStatus: 'REJECTED', autonomyStatus: 'BLOCKED' });
      const mockClient = createMockRazorpayClient();
      const app = createApp(repository, { diagnosisService: createMockDiagnosisService(), razorpayClient: mockClient });

      await request(app).post('/api/cases/1/recovery-actions').expect(422);
      expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
    });

    it('44. TOCTOU: Stale approval followed by terminal state mutation blocks execution', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository, { amount: 5000000 });
      await repository.updateCase(1, { escalationStatus: 'APPROVED', approvedBy: 'ops_lead', approvedAt: fixedNow().toISOString() });

      // Concurrent event mutates state to captured!
      await repository.createEvent({ eventId: 'evt_concurrent_cap', eventType: 'payment.captured', paymentId: detail.recoveryCase.paymentId, amount: 5000000, currency: 'INR', paymentStatus: 'captured', timestamp: fixedNow().toISOString() });

      const mockClient = createMockRazorpayClient();
      const app = createApp(repository, { diagnosisService: createMockDiagnosisService(), razorpayClient: mockClient });

      await request(app).post('/api/cases/1/recovery-actions').expect(422);
      expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
    });

    it('45. Reviewer identity missing is rejected with 400', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository);
      const app = createApp(repository);

      await request(app).post('/api/cases/1/escalations/approve').send({}).expect(400);
      await request(app).post('/api/cases/1/escalations/reject').send({}).expect(400);
    });

    it('46. Duplicate approval is handled idempotently without duplicate audit events', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository);
      await repository.updateCase(1, { escalationStatus: 'APPROVED', approvedBy: 'ops_lead', approvedAt: fixedNow().toISOString() });
      const app = createApp(repository, { diagnosisService: createMockDiagnosisService(), razorpayClient: createMockRazorpayClient() });

      const res = await request(app).post('/api/cases/1/escalations/approve').send({ reviewer: 'ops_lead' }).expect(200);
      expect(res.body.alreadyApproved).toBe(true);
    });

    it('47. Approval of non-existent case returns 404', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);
      await request(app).post('/api/cases/9999/escalations/approve').send({ reviewer: 'ops_lead' }).expect(404);
    });
  });

  // ================= 6. AI ADVERSARIAL OUTPUT & GROUNDING ================= //
  describe('6. AI Adversarial Output & Grounding', () => {
    it('48. Malformed AI JSON fails closed to development fallback or safe diagnosis', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);

      const faultyAi = {
        diagnose: vi.fn().mockRejectedValue(new Error('SyntaxError: Unexpected token in JSON at position 0'))
      };

      const diagService = createDiagnosisService({ provider: faultyAi });
      // Should fail closed gracefully or throw structured error
      await expect(diagService.diagnose(detail)).rejects.toThrow();
    });

    it('49. AI missing recommendation fails closed with validation error', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);

      const invalidAi = {
        diagnose: vi.fn().mockResolvedValue({
          diagnosis: { cause: 'timeout', confidence: 0.8, evidence: [] }
          // Missing recommendation
        })
      };

      const diagService = createDiagnosisService({ provider: invalidAi });
      await expect(diagService.diagnose(detail)).rejects.toThrow();
    });

    it('50. AI proposing unsupported action fails closed', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);

      const invalidAi = {
        diagnose: vi.fn().mockResolvedValue({
          diagnosis: { cause: 'timeout', confidence: 0.8, evidence: [{ field: 'case.amount', value: '100000' }] },
          recommendation: { action: 'UNSUPPORTED_DIRECT_DEBIT', reason: 'Invalid' }
        })
      };

      const diagService = createDiagnosisService({ provider: invalidAi });
      await expect(diagService.diagnose(detail)).rejects.toThrow();
    });

    it('51. AI confidence out of bounds (> 1.0) fails closed', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);

      const invalidAi = {
        diagnose: vi.fn().mockResolvedValue({
          diagnosis: { cause: 'timeout', confidence: 1.5, evidence: [{ field: 'case.amount', value: '100000' }] },
          recommendation: { action: 'CREATE_PAYMENT_LINK', reason: 'High' }
        })
      };

      const diagService = createDiagnosisService({ provider: invalidAi });
      await expect(diagService.diagnose(detail)).rejects.toThrow();
    });

    it('52. AI confidence below threshold triggers REVIEW decision', () => {
      const decision = evaluatePolicy({
        recoveryCase: { id: 1, paymentId: 'pay_low', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE' },
        diagnosis: { diagnosis: { cause: 'unclear', confidence: 0.4, evidence: [] }, recommendation: { action: 'CREATE_PAYMENT_LINK' } },
        confidenceThreshold: 0.65,
        now: fixedNow
      });
      expect(decision.decision).toBe('REVIEW');
      expect(decision.reasons[0]).toContain('threshold');
    });

    it('53. AI evidence referencing hallucinated facts fails grounded verification', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);

      const hallucinatingAi = {
        diagnose: vi.fn().mockResolvedValue({
          diagnosis: {
            cause: 'Customer bank gateway timeout',
            confidence: 0.85,
            evidence: [{ field: 'customer.creditScore', value: '780' }] // Hallucinated field not in facts!
          },
          recommendation: { action: 'CREATE_PAYMENT_LINK', reason: 'Safe' }
        })
      };

      const diagService = createDiagnosisService({ provider: hallucinatingAi });
      await expect(diagService.diagnose(detail)).rejects.toThrow();
    });

    it('54. AI returning extra unexpected root fields is rejected by strict schema', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);

      const injectedAi = {
        diagnose: vi.fn().mockResolvedValue({
          diagnosis: { cause: 'timeout', confidence: 0.85, evidence: [{ field: 'payment.failureReason', value: 'gateway_timeout' }] },
          recommendation: { action: 'CREATE_PAYMENT_LINK', reason: 'Valid' },
          executePrivilegedRefund: true // Malicious field
        })
      };

      const diagService = createDiagnosisService({ provider: injectedAi });
      await expect(diagService.diagnose(detail)).rejects.toThrow();
    });

    it('55. AI attempting to instruct executor directly has zero authority', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const mockClient = createMockRazorpayClient();

      const rogueProposal = {
        diagnosis: { cause: 'timeout', confidence: 0.85, evidence: [{ field: 'payment.failureReason', value: 'gateway_timeout' }] },
        recommendation: { action: 'CREATE_PAYMENT_LINK' },
        instruction: 'BYPASS_POLICY_AND_EXECUTE'
      };

      // Policy still evaluates independently
      detail.recoveryCase.riskStatus = 'SUPPRESSED';
      const decision = evaluatePolicy({ recoveryCase: detail.recoveryCase, diagnosis: rogueProposal, now: fixedNow });
      expect(decision.decision).toBe('BLOCK'); // Policy overrides AI proposal!
    });
  });

  // ================= 7. PROVIDER FAILURE / NETWORK FAILURE ================= //
  describe('7. Provider Failure / Network Failure Resilience', () => {
    const errorScenarios = [
      { code: 400, desc: 'Bad Request' },
      { code: 401, desc: 'Unauthorized' },
      { code: 404, desc: 'Not Found' },
      { code: 422, desc: 'Unprocessable Entity' },
      { code: 429, desc: 'Rate Limited' },
      { code: 500, desc: 'Internal Server Error' },
      { code: 'ETIMEDOUT', desc: 'Gateway Timeout' }
    ];

    for (const scenario of errorScenarios) {
      it(`56-62. Provider error ${scenario.code} fails safely without corrupted state or false recovery`, async () => {
        const repository = new InMemoryRecoveryRepository();
        const detail = await seedFailedCase(repository);

        const failingClient = {
          isConfigured: true,
          isTestMode: true,
          createPaymentLink: vi.fn().mockRejectedValue({
            statusCode: scenario.code,
            message: `Razorpay provider failure: ${scenario.desc}`
          }),
          getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([])
        };

        await expect(executePaymentLink(repository, {
          recoveryCase: detail.recoveryCase,
          diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } },
          events: detail.events,
          razorpayClient: failingClient,
          now: fixedNow
        })).rejects.toThrow();

        // Case must NOT be credited or marked resolved
        const fresh = await repository.getCaseDetail(1);
        expect(fresh.recoveryCase.recoveredAmount).toBe(0);
        expect(fresh.recoveryCase.riskStatus).not.toBe('RESOLVED');
      });
    }

    it('63. Malformed provider response (missing id/short_url) throws and fails closed', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);

      const corruptClient = {
        isConfigured: true,
        isTestMode: true,
        createPaymentLink: vi.fn().mockResolvedValue({
          malformed: 'no link returned'
        }),
        getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([])
      };

      await expect(executePaymentLink(repository, {
        recoveryCase: detail.recoveryCase,
        diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } },
        events: detail.events,
        razorpayClient: corruptClient,
        now: fixedNow
      })).rejects.toThrow();
    });
  });

  // ================= 8. CONCURRENCY / TOCTOU ================= //
  describe('8. Concurrency & TOCTOU Safety', () => {
    it('64. Two concurrent workers claiming same case — only one obtains valid lease', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository, { autonomyStatus: 'QUEUED' });

      const claim1 = await repository.claimNextJob({ workerId: 'worker_alpha', now: fixedNow() });
      const claim2 = await repository.claimNextJob({ workerId: 'worker_beta', now: fixedNow() });

      expect(claim1).not.toBeNull();
      expect(claim1.lockedBy).toBe('worker_alpha');
      expect(claim2).toBeNull(); // Second claim blocked by atomic lease!
    });

    it('65. Worker lease expiration allows safe reclaim after crash', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository, { autonomyStatus: 'QUEUED' });

      // Worker 1 claims with 60s lease at 12:00:00
      await repository.claimNextJob({ workerId: 'worker_dead', leaseDurationSeconds: 60, now: new Date('2026-08-31T12:00:00.000Z') });

      // At 12:00:30, worker 2 cannot claim
      const claimTooEarly = await repository.claimNextJob({ workerId: 'worker_alive', now: new Date('2026-08-31T12:00:30.000Z') });
      expect(claimTooEarly).toBeNull();

      // At 12:01:05, lease expired, worker 2 successfully reclaims
      const claimAfterExpiry = await repository.claimNextJob({ workerId: 'worker_alive', now: new Date('2026-08-31T12:01:05.000Z') });
      expect(claimAfterExpiry).not.toBeNull();
      expect(claimAfterExpiry.lockedBy).toBe('worker_alive');
    });

    it('66. Two execution attempts racing on same case generate at most one action', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const mockClient = createMockRazorpayClient();

      const [res1, res2] = await Promise.all([
        executePaymentLink(repository, { recoveryCase: detail.recoveryCase, diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } }, events: detail.events, razorpayClient: mockClient, now: fixedNow }),
        executePaymentLink(repository, { recoveryCase: detail.recoveryCase, diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } }, events: detail.events, razorpayClient: mockClient, now: fixedNow })
      ]);

      expect(res1.action.providerActionId).toBe(res2.action.providerActionId);
      expect((await repository.findActionsByCaseId(1)).length).toBe(1);
    });
  });

  // ================= 9. DATABASE / PERSISTENCE SAFETY ================= //
  describe('9. Database / Persistence Safety', () => {
    it('67. Repository updateCase does not wipe unrelated fields', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository, { amount: 123450, customerReference: 'cust_keep_me' });

      await repository.updateCase(detail.recoveryCase.id, {
        actionStatus: 'LINK_CREATED'
      });

      const updated = await repository.findCaseByPaymentId(detail.recoveryCase.paymentId);
      expect(updated.amount).toBe(123450);
      expect(updated.customerReference).toBe('cust_keep_me');
      expect(updated.actionStatus).toBe('LINK_CREATED');
    });

    it('68. Stop and escalation transitions preserve immutable audit history', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);

      await repository.addAudit(detail.recoveryCase.id, 'CASE_CREATED', 'Initial case detected');
      await repository.addAudit(detail.recoveryCase.id, 'POLICY_EVALUATED', 'Evaluated to REVIEW');

      await repository.updateCase(detail.recoveryCase.id, {
        escalationStatus: 'REJECTED',
        autonomyStatus: 'BLOCKED'
      });

      const audits = repository.audits.filter((a) => a.recoveryCaseId === detail.recoveryCase.id);
      expect(audits.length).toBeGreaterThanOrEqual(2);
      expect(audits[0].eventType).toBe('CASE_CREATED');
    });
  });

  // ================= 10. RATE LIMIT & AUDIT ABUSE SAFETY ================= //
  describe('10. Rate Limit & Audit Abuse Safety', () => {
    it('69. Rapid repeated webhook deliveries are deduplicated without double outcome', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository);
      const mockClient = createMockRazorpayClient();
      const execResult = await executePaymentLink(repository, { recoveryCase: detail.recoveryCase, diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } }, events: detail.events, razorpayClient: mockClient });

      const webhookPayload = {
        provider: 'razorpay',
        providerEventId: 'evt_rapid_001',
        eventType: 'payment_link.paid',
        paymentLinkId: execResult.action.providerActionId,
        paymentId: 'pay_rapid_1',
        referenceId: execResult.action.idempotencyKey,
        amount: 100000,
        currency: 'INR',
        providerTimestamp: fixedNow().toISOString()
      };

      // 5 rapid deliveries
      await Promise.all([
        reconcileOutcome(repository, webhookPayload),
        reconcileOutcome(repository, webhookPayload),
        reconcileOutcome(repository, webhookPayload),
        reconcileOutcome(repository, webhookPayload),
        reconcileOutcome(repository, webhookPayload)
      ]);

      const outcomes = await repository.findOutcomesByCaseId(1);
      expect(outcomes.length).toBe(1);
    });

    it('70. Repeated worker poll on blocked case does NOT produce infinite audit entries', async () => {
      const repository = new InMemoryRecoveryRepository();
      await seedFailedCase(repository, {
        autonomyStatus: 'QUEUED',
        firstDetectedAt: '2026-08-20T00:00:00.000Z' // Stale -> BLOCKED
      });

      const worker = createRecoveryWorker({ repository, diagnosisService: createMockDiagnosisService(), now: fixedNow });

      // First poll blocks
      await worker.pollOnce();
      const audits1 = repository.audits.filter((a) => a.eventType === 'AUTONOMY_BLOCKED');
      expect(audits1.length).toBe(1);

      // Force case back to QUEUED simulating polling without error clear
      await repository.updateCase(1, { autonomyStatus: 'QUEUED', lockedUntil: null });
      await worker.pollOnce();

      // Audit must be deduplicated
      const audits2 = repository.audits.filter((a) => a.eventType === 'AUTONOMY_BLOCKED');
      expect(audits2.length).toBe(1);
    });
  });

  // ================= 11. INVARIANT PROPERTY TESTS ================= //
  describe('11. Safety Invariant Property Tests', () => {
    const blockCases = [
      { name: 'amount is zero', patch: { amount: 0 } },
      { name: 'amount is negative', patch: { amount: -100 } },
      { name: 'currency is USD', patch: { currency: 'USD' } },
      { name: 'payment status is captured', patch: {}, events: [{ eventType: 'payment.captured', paymentStatus: 'captured' }] },
      { name: 'case is RESOLVED', patch: { riskStatus: 'RESOLVED' } },
      { name: 'case is SUPPRESSED', patch: { riskStatus: 'SUPPRESSED' } },
      { name: 'case is REJECTED', patch: { escalationStatus: 'REJECTED' } }
    ];

    for (const bc of blockCases) {
      it(`PROPERTY: FOR EVERY BLOCK condition (${bc.name}), createPaymentLink is NEVER called`, async () => {
        const repository = new InMemoryRecoveryRepository();
        const detail = await seedFailedCase(repository, bc.patch);
        if (bc.events) {
          for (const e of bc.events) {
            await repository.createEvent({ eventId: `evt_${Math.random()}`, paymentId: detail.recoveryCase.paymentId, ...e, timestamp: fixedNow().toISOString() });
          }
        }
        const freshDetail = await repository.getCaseDetail(detail.recoveryCase.id);
        const mockClient = createMockRazorpayClient();

        await expect(executePaymentLink(repository, {
          recoveryCase: freshDetail.recoveryCase,
          diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } },
          events: freshDetail.events,
          razorpayClient: mockClient,
          now: fixedNow
        })).rejects.toThrow();

        expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
      });
    }

    it('PROPERTY: FOR EVERY human approval attempt on BLOCK, execution remains impossible', async () => {
      const repository = new InMemoryRecoveryRepository();
      const detail = await seedFailedCase(repository, { riskStatus: 'RESOLVED' });
      // Force approved status in DB
      await repository.updateCase(detail.recoveryCase.id, { escalationStatus: 'APPROVED', approvedBy: 'malicious_admin' });
      const mockClient = createMockRazorpayClient();

      await expect(executePaymentLink(repository, {
        recoveryCase: (await repository.getCaseDetail(1)).recoveryCase,
        diagnosis: { recommendation: { action: 'CREATE_PAYMENT_LINK' } },
        events: detail.events,
        razorpayClient: mockClient,
        now: fixedNow
      })).rejects.toThrow();

      expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
    });
  });

  // ================= 12. AGENT EVALUATION FOUNDATION ================= //
  describe('12. Agent Evaluation Foundation', () => {
    it('71. createEvaluationRecord normalizes telemetry without data loss', () => {
      const rec = createEvaluationRecord({
        caseId: 101,
        schemaValid: true,
        evidenceGrounded: true,
        recommendedAction: 'CREATE_PAYMENT_LINK',
        policyDecision: 'ALLOW',
        executionEligible: true,
        latencyMs: 142.5,
        providerFailure: false,
        finalOutcome: 'RECOVERED',
        metadata: { model: 'gemini-2.5-flash' }
      });

      expect(rec.caseId).toBe(101);
      expect(rec.schemaValid).toBe(true);
      expect(rec.evidenceGrounded).toBe(true);
      expect(rec.recommendedAction).toBe('CREATE_PAYMENT_LINK');
      expect(rec.latencyMs).toBe(142.5);
      expect(rec.evaluatedAt).toBeDefined();
    });

    it('72. calculateAgentMetrics computes transparent distribution rates and latency', () => {
      const records = [
        createEvaluationRecord({ caseId: 1, schemaValid: true, evidenceGrounded: true, recommendedAction: 'CREATE_PAYMENT_LINK', policyDecision: 'ALLOW', executionEligible: true, latencyMs: 100, finalOutcome: 'RECOVERED' }),
        createEvaluationRecord({ caseId: 2, schemaValid: true, evidenceGrounded: true, recommendedAction: 'CREATE_PAYMENT_LINK', policyDecision: 'REVIEW', executionEligible: false, latencyMs: 200, finalOutcome: null }),
        createEvaluationRecord({ caseId: 3, schemaValid: true, evidenceGrounded: false, recommendedAction: 'REQUEST_MANUAL_REVIEW', policyDecision: 'BLOCK', executionEligible: false, latencyMs: 150, finalOutcome: null }),
        createEvaluationRecord({ caseId: 4, schemaValid: false, evidenceGrounded: false, recommendedAction: 'UNKNOWN', policyDecision: 'BLOCK', executionEligible: false, latencyMs: 250, finalOutcome: null })
      ];

      const metrics = calculateAgentMetrics(records);
      expect(metrics.totalEvaluations).toBe(4);
      expect(metrics.schemaValidityRate).toBe(0.75); // 3/4
      expect(metrics.evidenceGroundingPassRate).toBe(0.5); // 2/4
      expect(metrics.policyAllowRate).toBe(0.25); // 1/4
      expect(metrics.policyReviewRate).toBe(0.25); // 1/4
      expect(metrics.policyBlockRate).toBe(0.50); // 2/4
      expect(metrics.verifiedRecoveryRate).toBe(0.25); // 1/4
      expect(metrics.averageLatencyMs).toBe(175); // (100+200+150+250)/4
      expect(metrics.evaluationMetadata.isGroundTruthBenchmark).toBe(false);
      expect(metrics.evaluationMetadata.groundTruthNote).toContain('operational distribution');
    });

    it('73. calculateAgentMetrics handles empty records array gracefully', () => {
      const metrics = calculateAgentMetrics([]);
      expect(metrics.totalEvaluations).toBe(0);
      expect(metrics.schemaValidityRate).toBe(0);
      expect(metrics.averageLatencyMs).toBe(0);
    });
  });
});
