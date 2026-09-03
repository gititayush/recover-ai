const {
  STOP_REASON_CODES,
  ACTION_DISPOSITIONS,
  evaluateStoppingCriteria
} = require('../src/policy/stoppingEngine');
const { evaluatePolicy } = require('../src/policy/policyEngine');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { createRecoveryWorker } = require('../src/worker/recoveryWorker');
const { createDiagnosisService } = require('../src/ai/diagnosisService');
const { environment } = require('../src/config/env');

const fixedNow = () => new Date('2026-08-31T12:00:00.000Z');

function createBaseCase(overrides = {}) {
  return {
    id: 1,
    paymentId: 'pay_test_stop_001',
    amount: 100000, // ₹1,000 (100,000 paise)
    currency: 'INR',
    riskStatus: 'RECOVERABLE',
    riskReason: 'Transient gateway timeout',
    riskLevel: 'MEDIUM',
    recoveredAmount: 0,
    outcome: null,
    firstDetectedAt: '2026-08-31T11:00:00.000Z', // 1 hour ago
    lastEventAt: '2026-08-31T11:00:00.000Z',
    customerReference: 'cust_001',
    ...overrides
  };
}

describe('V2 Explicit Stopping Engine — Core Evaluation', () => {
  it('1. triggers PAYMENT_RECOVERED when case is resolved or has verified recovered amount', () => {
    // Resolved risk status
    const caseResolved = createBaseCase({ riskStatus: 'RESOLVED', outcome: 'PAID', recoveredAmount: 100000 });
    const res1 = evaluateStoppingCriteria({ recoveryCase: caseResolved, now: fixedNow });
    expect(res1.stopped).toBe(true);
    expect(res1.reasonCode).toBe(STOP_REASON_CODES.PAYMENT_RECOVERED);
    expect(res1.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);
    expect(res1.humanReadableReason).toContain('already recovered');

    // Existing confirmed action
    const normalCase = createBaseCase();
    const res2 = evaluateStoppingCriteria({
      recoveryCase: normalCase,
      existingActions: [{ id: 1, actionType: 'CREATE_PAYMENT_LINK', status: 'OUTCOME_CONFIRMED' }],
      now: fixedNow
    });
    expect(res2.stopped).toBe(true);
    expect(res2.reasonCode).toBe(STOP_REASON_CODES.PAYMENT_RECOVERED);
  });

  it('2. triggers TERMINAL_PAYMENT when payment or order reached terminal status outside recovery', () => {
    // Suppressed case
    const caseSuppressed = createBaseCase({ riskStatus: 'SUPPRESSED', outcome: 'REFUNDED' });
    const res1 = evaluateStoppingCriteria({ recoveryCase: caseSuppressed, now: fixedNow });
    expect(res1.stopped).toBe(true);
    expect(res1.reasonCode).toBe(STOP_REASON_CODES.TERMINAL_PAYMENT);
    expect(res1.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);

    // Event history has payment.captured
    const normalCase = createBaseCase();
    const res2 = evaluateStoppingCriteria({
      recoveryCase: normalCase,
      events: [{ eventType: 'payment.captured', paymentStatus: 'captured' }],
      now: fixedNow
    });
    expect(res2.stopped).toBe(true);
    expect(res2.reasonCode).toBe(STOP_REASON_CODES.TERMINAL_PAYMENT);
  });

  it('3. triggers CUSTOMER_OPT_OUT when customer cancels or explicitly opts out', () => {
    const optOutCase = createBaseCase({
      customerOptOut: true,
      riskReason: 'Customer requested opt-out from recovery SMS'
    });
    const res = evaluateStoppingCriteria({ recoveryCase: optOutCase, now: fixedNow });
    expect(res.stopped).toBe(true);
    expect(res.reasonCode).toBe(STOP_REASON_CODES.CUSTOMER_OPT_OUT);
    expect(res.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);
    expect(res.humanReadableReason).toContain('opted out');
  });

  it('4. triggers PROVIDER_INTEGRITY_FAILURE on corrupted amounts or provider failure flag', () => {
    const invalidAmountCase = createBaseCase({ amount: -500 });
    const res = evaluateStoppingCriteria({ recoveryCase: invalidAmountCase, now: fixedNow });
    expect(res.stopped).toBe(true);
    expect(res.reasonCode).toBe(STOP_REASON_CODES.PROVIDER_INTEGRITY_FAILURE);
    expect(res.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);
  });

  it('5. triggers DUPLICATE_ACTION when an active or executing recovery action exists', () => {
    const normalCase = createBaseCase();
    const res = evaluateStoppingCriteria({
      recoveryCase: normalCase,
      candidateAction: 'CREATE_PAYMENT_LINK',
      existingActions: [{
        id: 10,
        actionType: 'CREATE_PAYMENT_LINK',
        status: 'EXECUTED',
        providerActionId: 'plink_live_123'
      }],
      now: fixedNow
    });
    expect(res.stopped).toBe(true);
    expect(res.reasonCode).toBe(STOP_REASON_CODES.DUPLICATE_ACTION);
    expect(res.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);
  });

  it('6. triggers STALE_CASE when elapsed time since failure exceeds threshold (72h)', () => {
    // Detected 80 hours ago
    const staleCase = createBaseCase({
      firstDetectedAt: '2026-08-28T04:00:00.000Z'
    });
    const res = evaluateStoppingCriteria({
      recoveryCase: staleCase,
      staleCaseThresholdMinutes: 4320, // 72 hours
      now: fixedNow
    });
    expect(res.stopped).toBe(true);
    expect(res.reasonCode).toBe(STOP_REASON_CODES.STALE_CASE);
    expect(res.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);
    expect(res.humanReadableReason).toContain('stale');
  });

  it('7. triggers RECOVERY_UNECONOMIC when ERV calculation yields non-positive expected value', () => {
    // Tiny amount of ₹1 (100 paise) where 5% friction + intervention cost exceeds expected recovery
    const microCase = createBaseCase({
      amount: 100, // ₹1
      riskLevel: 'LOW' // 25% prob
    });
    const res = evaluateStoppingCriteria({
      recoveryCase: microCase,
      candidateAction: 'SCHEDULE_RETRY_WINDOW', // Cost 500 paise
      now: fixedNow
    });
    expect(res.stopped).toBe(true);
    expect(res.reasonCode).toBe(STOP_REASON_CODES.RECOVERY_UNECONOMIC);
    expect(res.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);
    expect(res.humanReadableReason).toContain('uneconomic');
  });

  it('8. triggers COOLDOWN_ACTIVE with WAIT disposition when quiet period has not elapsed', () => {
    const normalCase = createBaseCase();
    const res = evaluateStoppingCriteria({
      recoveryCase: normalCase,
      existingActions: [{
        id: 1,
        actionType: 'CREATE_PAYMENT_LINK',
        status: 'FAILED',
        createdAt: '2026-08-31T11:45:00.000Z' // 15 minutes ago (cooldown 30 min)
      }],
      cooldownMinutes: 30,
      now: fixedNow
    });
    expect(res.stopped).toBe(true);
    expect(res.reasonCode).toBe(STOP_REASON_CODES.COOLDOWN_ACTIVE);
    expect(res.actionDisposition).toBe(ACTION_DISPOSITIONS.WAIT);
    expect(res.supportingFacts.remainingMinutes).toBe(15);
    expect(res.supportingFacts.cooldownExpiresAt).toBeDefined();
  });

  it('9. triggers MAX_ATTEMPTS with ESCALATE disposition when attempts reach threshold', () => {
    const normalCase = createBaseCase();
    const res = evaluateStoppingCriteria({
      recoveryCase: normalCase,
      existingActions: [
        { id: 1, idempotencyKey: 'rc_1_attempt_1', status: 'FAILED' },
        { id: 2, idempotencyKey: 'rc_1_attempt_2', status: 'FAILED' }
      ],
      maxAutomatedAttempts: 2,
      now: fixedNow
    });
    expect(res.stopped).toBe(true);
    expect(res.reasonCode).toBe(STOP_REASON_CODES.MAX_ATTEMPTS);
    expect(res.actionDisposition).toBe(ACTION_DISPOSITIONS.ESCALATE);
  });

  it('10. triggers LOW_CONFIDENCE with ESCALATE disposition when AI confidence < 0.65', () => {
    const normalCase = createBaseCase();
    const res = evaluateStoppingCriteria({
      recoveryCase: normalCase,
      diagnosis: {
        diagnosis: { confidence: 0.50 }
      },
      confidenceThreshold: 0.65,
      now: fixedNow
    });
    expect(res.stopped).toBe(true);
    expect(res.reasonCode).toBe(STOP_REASON_CODES.LOW_CONFIDENCE);
    expect(res.actionDisposition).toBe(ACTION_DISPOSITIONS.ESCALATE);
  });

  it('11. triggers HIGH_RISK with ESCALATE disposition when amount exceeds ₹25,000', () => {
    const highValueCase = createBaseCase({ amount: 5000000 }); // ₹50,000
    const res = evaluateStoppingCriteria({
      recoveryCase: highValueCase,
      highValueThresholdPaise: 2500000,
      now: fixedNow
    });
    expect(res.stopped).toBe(true);
    expect(res.reasonCode).toBe(STOP_REASON_CODES.HIGH_RISK);
    expect(res.actionDisposition).toBe(ACTION_DISPOSITIONS.ESCALATE);
  });

  it('12. triggers MANUAL_REVIEW_REQUIRED with ESCALATE disposition when action is REQUEST_MANUAL_REVIEW', () => {
    const normalCase = createBaseCase();
    const res = evaluateStoppingCriteria({
      recoveryCase: normalCase,
      candidateAction: 'REQUEST_MANUAL_REVIEW',
      now: fixedNow
    });
    expect(res.stopped).toBe(true);
    expect(res.reasonCode).toBe(STOP_REASON_CODES.MANUAL_REVIEW_REQUIRED);
    expect(res.actionDisposition).toBe(ACTION_DISPOSITIONS.ESCALATE);
  });

  it('13. returns stopped=false and CONTINUE for a safe, eligible, non-stopped case', () => {
    const normalCase = createBaseCase({ amount: 100000 }); // ₹1,000
    const res = evaluateStoppingCriteria({
      recoveryCase: normalCase,
      diagnosis: { diagnosis: { confidence: 0.85 } },
      candidateAction: 'CREATE_PAYMENT_LINK',
      existingActions: [],
      events: [{ eventType: 'payment.failed', failureReason: 'timeout' }],
      now: fixedNow
    });
    expect(res.stopped).toBe(false);
    expect(res.actionDisposition).toBe(ACTION_DISPOSITIONS.CONTINUE);
    expect(res.reasonCode).toBeNull();
    expect(res.humanReadableReason).toBeNull();
  });
});

describe('V2 Explicit Stopping Engine — Policy & Worker Integration', () => {
  beforeEach(() => {
    environment.AUTONOMOUS_RECOVERY_ENABLED = true;
  });

  it('policyEngine embeds structured stopping result without altering ALLOW decision on valid case', () => {
    const recoveryCase = createBaseCase();
    const decision = evaluatePolicy({
      recoveryCase,
      diagnosis: {
        diagnosis: { cause: 'timeout', confidence: 0.88, evidence: [] },
        recommendation: { action: 'CREATE_PAYMENT_LINK' }
      },
      events: [{ eventType: 'payment.failed', failureReason: 'timeout' }],
      existingActions: [],
      now: fixedNow
    });

    expect(decision.decision).toBe('ALLOW');
    expect(decision.stopping).toBeDefined();
    expect(decision.stopping.stopped).toBe(false);
    expect(decision.stopping.actionDisposition).toBe(ACTION_DISPOSITIONS.CONTINUE);
  });

  it('policyEngine stops stale cases with HARD_STOP and decision BLOCK', () => {
    const staleCase = createBaseCase({
      firstDetectedAt: '2026-08-20T00:00:00.000Z' // 11 days ago relative to fixedNow
    });
    const decision = evaluatePolicy({
      recoveryCase: staleCase,
      diagnosis: {
        diagnosis: { cause: 'timeout', confidence: 0.88, evidence: [] },
        recommendation: { action: 'CREATE_PAYMENT_LINK' }
      },
      now: fixedNow
    });

    expect(decision.decision).toBe('BLOCK');
    expect(decision.stopping.stopped).toBe(true);
    expect(decision.stopping.reasonCode).toBe(STOP_REASON_CODES.STALE_CASE);
    expect(decision.stopping.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);
  });

  it('recoveryWorker schedules retry for WAIT conditions (cooldown) instead of permanent failure', async () => {
    const repository = new InMemoryRecoveryRepository();
    const createdCase = await repository.createCase({
      paymentId: 'pay_wait_test_001',
      amount: 100000,
      currency: 'INR',
      riskStatus: 'RECOVERABLE',
      riskReason: 'Transient timeout',
      riskLevel: 'MEDIUM',
      autonomyStatus: 'QUEUED',
      firstDetectedAt: '2026-08-31T11:00:00.000Z',
      lastEventAt: '2026-08-31T11:00:00.000Z'
    });

    // Add a prior failed action 10 minutes ago (within 30m cooldown)
    await repository.createAction({
      recoveryCaseId: createdCase.id,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'FAILED',
      policyDecision: 'ALLOW',
      policyVersion: 'recoverai-policy-v1',
      idempotencyKey: 'rc_wait_test_plink_v1',
      provider: 'razorpay',
      amount: 100000,
      currency: 'INR',
      createdAt: '2026-08-31T11:50:00.000Z' // 10 min ago relative to 12:00:00
    });

    // Mock diagnosis service to return valid proposal
    const mockDiagnosisService = {
      diagnose: async () => ({
        diagnosis: { cause: 'Bank timeout', confidence: 0.85, evidence: [{ field: 'case.amount', value: '100000' }] },
        proposedAction: 'CREATE_PAYMENT_LINK',
        recommendation: { action: 'CREATE_PAYMENT_LINK', reason: 'Highest value' },
        candidates: [{ action: 'CREATE_PAYMENT_LINK', estimatedProbability: 0.5, recoverableAmount: 100000, estimatedRecoveryValue: 45000, interventionCost: 0, estimatedFriction: 5000, assumptions: {} }],
        provider: 'test',
        model: 'test-v1',
        promptVersion: 'v1',
        source: 'live_ai'
      })
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: mockDiagnosisService,
      now: fixedNow
    });

    const result = await worker.pollOnce();
    expect(result.processed).toBe(true);
    expect(result.status).toBe('RETRY_SCHEDULED');
    expect(result.stopping?.actionDisposition).toBe(ACTION_DISPOSITIONS.WAIT);
    expect(result.stopping?.reasonCode).toBe(STOP_REASON_CODES.COOLDOWN_ACTIVE);

    // Verify case in repository transitioned to RETRY_SCHEDULED with nextRetryAt
    const updated = await repository.findCaseByPaymentId('pay_wait_test_001');
    expect(updated.autonomyStatus).toBe('RETRY_SCHEDULED');
    expect(updated.nextRetryAt).toBeDefined();
  });

  it('prevents audit event duplication on repeated poll of stopped cases', async () => {
    const repository = new InMemoryRecoveryRepository();
    const createdCase = await repository.createCase({
      paymentId: 'pay_stale_test_002',
      amount: 100000,
      currency: 'INR',
      riskStatus: 'RECOVERABLE',
      riskReason: 'Transient timeout',
      riskLevel: 'MEDIUM',
      autonomyStatus: 'QUEUED',
      firstDetectedAt: '2026-08-20T00:00:00.000Z', // 11 days ago (stale)
      lastEventAt: '2026-08-20T00:00:00.000Z'
    });

    const mockDiagnosisService = {
      diagnose: async () => ({
        diagnosis: { cause: 'Bank timeout', confidence: 0.85, evidence: [{ field: 'case.amount', value: '100000' }] },
        proposedAction: 'CREATE_PAYMENT_LINK',
        recommendation: { action: 'CREATE_PAYMENT_LINK', reason: 'Highest value' },
        candidates: [],
        provider: 'test',
        model: 'test-v1',
        promptVersion: 'v1',
        source: 'live_ai'
      })
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: mockDiagnosisService,
      now: fixedNow
    });

    // First poll -> BLOCKED + AUTONOMY_BLOCKED audit logged
    const result1 = await worker.pollOnce();
    expect(result1.status).toBe('BLOCKED');
    const auditsAfterFirst = repository.audits.filter((a) => a.recoveryCaseId === createdCase.id && a.eventType === 'AUTONOMY_BLOCKED');
    expect(auditsAfterFirst.length).toBe(1);

    // Case is now BLOCKED, worker will not claim it again unless forced into queue
    await repository.updateCase(createdCase.id, { autonomyStatus: 'QUEUED', lockedUntil: null, lockedBy: null });

    const result2 = await worker.pollOnce();
    expect(result2.status).toBe('BLOCKED');
    // Audit count for AUTONOMY_BLOCKED must remain 1 because last error is identical
    const auditsAfterSecond = repository.audits.filter((a) => a.recoveryCaseId === createdCase.id && a.eventType === 'AUTONOMY_BLOCKED');
    expect(auditsAfterSecond.length).toBe(1);
  });
});
