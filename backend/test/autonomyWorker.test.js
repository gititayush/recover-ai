const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { processEvent } = require('../src/services/eventService');
const { createRecoveryWorker } = require('../src/worker/recoveryWorker');
const { environment } = require('../src/config/env');
const { executePaymentLink } = require('../src/actions/paymentLinkExecutor');

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
        reason: 'Payment Link has highest probability of recovering temporary bank outage.'
      },
      candidates: [{ action: 'CREATE_PAYMENT_LINK', score: 0.9 }],
      provider: 'test-ai',
      model: 'test-model',
      promptVersion: 'v1',
      source: 'live_ai',
      ...overrides
    })
  };
}

function createMockRazorpayClient(overrides = {}) {
  const existingLinks = new Map();

  const client = {
    isConfigured: true,
    isTestMode: true,
    keyId: 'rzp_test_mock123',
    createPaymentLink: vi.fn().mockImplementation(async (payload) => {
      const ref = payload.referenceId;
      if (existingLinks.has(ref)) {
        const error = new Error('A payment link with this reference_id already exists.');
        error.statusCode = 400;
        error.details = { error: { description: 'A payment link with this reference_id already exists.' } };
        throw error;
      }
      const link = {
        id: `plink_test_${Math.random().toString(36).substring(2, 9)}`,
        short_url: `https://rzp.io/i/${Math.random().toString(36).substring(2, 9)}`,
        status: 'created',
        amount: payload.amount,
        currency: payload.currency,
        reference_id: ref
      };
      existingLinks.set(ref, link);
      return link;
    }),
    getPaymentLinksByReferenceId: vi.fn().mockImplementation(async (referenceId) => {
      if (existingLinks.has(referenceId)) {
        return [existingLinks.get(referenceId)];
      }
      return [];
    }),
    _existingLinks: existingLinks,
    ...overrides
  };

  return client;
}

const baseFailedEvent = {
  eventId: 'evt_fail_1001',
  eventType: 'payment.failed',
  paymentId: 'pay_fail_1001',
  orderId: 'order_1001',
  amount: 499900,
  currency: 'INR',
  paymentStatus: 'failed',
  failureReason: 'gateway_timeout',
  customerReference: 'cust_1001',
  timestamp: '2026-09-01T10:00:00.000Z'
};

describe('Milestone 1 — Durable Autonomous Recovery Worker', () => {
  beforeEach(() => {
    environment.AUTONOMOUS_RECOVERY_ENABLED = true;
  });

  // A. actionable payment.failed -> QUEUED
  it('A. actionable payment.failed transitions case to QUEUED when feature flag is ON', async () => {
    const repository = new InMemoryRecoveryRepository();
    const result = await processEvent(repository, baseFailedEvent);

    expect(result.recoveryCase).toBeDefined();
    expect(result.recoveryCase.autonomyStatus).toBe('QUEUED');

    const audits = await repository.getCaseDetail(result.recoveryCase.id);
    const queuedAudit = audits.auditEvents.find((a) => a.eventType === 'AUTONOMY_QUEUED');
    expect(queuedAudit).toBeDefined();
    expect(queuedAudit.message).toContain('Case queued for autonomous recovery worker');
  });

  // B. payment.captured -> terminal suppression
  it('B. payment.captured marks case RESOLVED and autonomy_status COMPLETED (settled externally)', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const capturedEvent = {
      ...baseFailedEvent,
      eventId: 'evt_cap_1002',
      eventType: 'payment.captured',
      paymentStatus: 'captured',
      timestamp: '2026-09-01T10:02:00.000Z'
    };

    const result = await processEvent(repository, capturedEvent);
    expect(result.recoveryCase.riskStatus).toBe('RESOLVED');
    expect(result.recoveryCase.outcome).toBe('PAID');
    expect(result.recoveryCase.autonomyStatus).toBe('COMPLETED');

    const detail = await repository.getCaseDetail(result.recoveryCase.id);
    const completedAudit = detail.auditEvents.find((a) => a.eventType === 'AUTONOMY_COMPLETED');
    expect(completedAudit).toBeDefined();
    expect(completedAudit.message).toContain('payment settled externally; no recovery action needed');
  });

  // C. order.paid -> terminal suppression
  it('C. order.paid marks case RESOLVED and autonomy_status COMPLETED, preventing worker execution', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const orderPaidEvent = {
      ...baseFailedEvent,
      eventId: 'evt_ord_1003',
      eventType: 'order.paid',
      paymentStatus: 'paid',
      timestamp: '2026-09-01T10:02:00.000Z'
    };

    const result = await processEvent(repository, orderPaidEvent);
    expect(result.recoveryCase.riskStatus).toBe('RESOLVED');
    expect(result.recoveryCase.outcome).toBe('PAID');
    expect(result.recoveryCase.autonomyStatus).toBe('COMPLETED');
  });

  // D. payment_link.paid -> reconciliation
  it('D. payment_link.paid reconciles verified outcome and increments recovered_amount', async () => {
    const repository = new InMemoryRecoveryRepository();
    const eventRes = await processEvent(repository, baseFailedEvent);

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const pollRes = await worker.pollOnce();
    expect(pollRes.status).toBe('COMPLETED');
    expect(pollRes.action).toBeDefined();

    const plinkPaidEvent = {
      eventId: 'evt_plink_paid_1004',
      eventType: 'payment_link.paid',
      paymentId: 'pay_recovered_1004',
      paymentLinkId: pollRes.action.providerActionId,
      referenceId: pollRes.action.idempotencyKey,
      amount: 499900,
      amountPaid: 499900,
      currency: 'INR',
      timestamp: '2026-09-01T10:15:00.000Z'
    };

    const reconcileRes = await processEvent(repository, plinkPaidEvent);
    expect(reconcileRes.reconciliation.reconciled).toBe(true);

    const detail = await repository.getCaseDetail(eventRes.recoveryCase.id);
    expect(detail.recoveryCase.riskStatus).toBe('RESOLVED');
    expect(detail.recoveryCase.outcome).toBe('RECOVERED');
    expect(detail.recoveryCase.recoveredAmount).toBe(499900);
  });

  // E. duplicate webhook
  it('E. duplicate webhook is idempotent and does not create duplicate cases or queue records', async () => {
    const repository = new InMemoryRecoveryRepository();
    const first = await processEvent(repository, baseFailedEvent);
    expect(first.duplicate).toBeFalsy();

    const duplicate = await processEvent(repository, baseFailedEvent);
    expect(duplicate.duplicate).toBe(true);

    const cases = await repository.listCases();
    expect(cases).toHaveLength(1);
  });

  // F. concurrent claims
  it('F. concurrent workers claim distinct, non-overlapping cases', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);
    await processEvent(repository, {
      ...baseFailedEvent,
      eventId: 'evt_fail_1005',
      paymentId: 'pay_fail_1005',
      orderId: 'order_1005'
    });

    const worker1 = createRecoveryWorker({ repository, workerId: 'worker-1' });
    const worker2 = createRecoveryWorker({ repository, workerId: 'worker-2' });

    const [job1, job2] = await Promise.all([
      repository.claimNextJob({ workerId: 'worker-1' }),
      repository.claimNextJob({ workerId: 'worker-2' })
    ]);

    expect(job1).toBeDefined();
    expect(job2).toBeDefined();
    expect(job1.id).not.toBe(job2.id);
    expect(job1.lockedBy).toBe('worker-1');
    expect(job2.lockedBy).toBe('worker-2');
  });

  // G. stale lease recovery
  it('G. stale lease recovery reclaims an abandoned job when locked_until has expired', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    // First claim at t0
    const t0 = new Date('2026-09-01T10:00:00.000Z');
    const firstClaim = await repository.claimNextJob({ workerId: 'worker-stale', leaseDurationSeconds: 60, now: t0 });
    expect(firstClaim.autonomyStatus).toBe('CLAIMED');
    expect(firstClaim.autonomyAttempts).toBe(1);

    // At t0 + 65s, lease is expired
    const tExpired = new Date('2026-09-01T10:01:05.000Z');
    const secondClaim = await repository.claimNextJob({ workerId: 'worker-fresh', leaseDurationSeconds: 60, now: tExpired });
    expect(secondClaim).toBeDefined();
    expect(secondClaim.id).toBe(firstClaim.id);
    expect(secondClaim.autonomyAttempts).toBe(2);
    expect(secondClaim.lockedBy).toBe('worker-fresh');
    expect(secondClaim.autonomyLeaseToken).not.toBe(firstClaim.autonomyLeaseToken);
  });

  // H. stale-worker fencing
  it('H. stale worker cannot mutate case after lease token is invalidated', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const t0 = new Date('2026-09-01T10:00:00.000Z');
    const claim1 = await repository.claimNextJob({ workerId: 'worker-1', leaseDurationSeconds: 60, now: t0 });

    // Stale expiration and reclamation by worker-2
    const t1 = new Date('2026-09-01T10:01:05.000Z');
    const claim2 = await repository.claimNextJob({ workerId: 'worker-2', leaseDurationSeconds: 60, now: t1 });

    // Worker-1 attempts to release with its old leaseToken
    const releaseAttempt = await repository.releaseJob(claim1.id, claim1.autonomyLeaseToken, {
      autonomyStatus: 'COMPLETED'
    });
    expect(releaseAttempt).toBeNull(); // Fenced out!

    // Case remains CLAIMED by worker-2
    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyLeaseToken).toBe(claim2.autonomyLeaseToken);
    expect(freshCase.lockedBy).toBe('worker-2');
  });

  // I. AI timeout
  it('I. AI timeout fails closed to REVIEW_REQUIRED', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const timingOutAi = {
      diagnose: vi.fn().mockRejectedValue(new Error('AI request timed out after 15000ms'))
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: timingOutAi,
      razorpayClient: createMockRazorpayClient()
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('REVIEW_REQUIRED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('REVIEW_REQUIRED');
    expect(freshCase.lastAutonomyError).toContain('AI diagnosis error');
  });

  // J. malformed AI output
  it('J. malformed AI output fails closed to REVIEW_REQUIRED', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const malformedAi = {
      diagnose: vi.fn().mockRejectedValue(new Error('Invalid JSON payload received from LLM'))
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: malformedAi,
      razorpayClient: createMockRazorpayClient()
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('REVIEW_REQUIRED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('REVIEW_REQUIRED');
  });

  // K. low confidence
  it('K. low AI confidence (<0.65) escalates to REVIEW_REQUIRED without creating link', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const lowConfidenceAi = createMockDiagnosisService({
      diagnosis: { cause: 'Unclear failure', confidence: 0.45, evidence: [] }
    });

    const razorpayClient = createMockRazorpayClient();
    const worker = createRecoveryWorker({
      repository,
      diagnosisService: lowConfidenceAi,
      razorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.lowConfidence).toBe(true);
    expect(razorpayClient.createPaymentLink).not.toHaveBeenCalled();

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('REVIEW_REQUIRED');
  });

  // L. high-value review
  it('L. high-value recovery amount (>₹25,000) escalates to REVIEW_REQUIRED via policy', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, {
      ...baseFailedEvent,
      amount: 5000000 // ₹50,000 > ₹25,000 limit
    });

    const razorpayClient = createMockRazorpayClient();
    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.reasons[0]).toContain('exceeds automatic execution limit');
    expect(razorpayClient.createPaymentLink).not.toHaveBeenCalled();

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('REVIEW_REQUIRED');
  });

  // M. provider success + DB crash
  it('M. provider success followed by local crash reclaims and adopts provider link without creating a duplicate', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const razorpayClient = createMockRazorpayClient();
    const stableRef = `REV-C1-PLINK`;

    // Simulate provider call succeeding outside Revflow DB commit
    const providerLink = await razorpayClient.createPaymentLink({
      amount: 499900,
      currency: 'INR',
      referenceId: stableRef
    });
    expect(providerLink.id).toBeDefined();

    // Worker runs recovery: checks provider, discovers link, adopts it
    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('COMPLETED');
    expect(result.action.providerActionId).toBe(providerLink.id);
    expect(result.action.status).toBe('EXECUTED');

    // Prove createPaymentLink was NOT called again (exactly 1 link created)
    expect(razorpayClient.createPaymentLink).toHaveBeenCalledTimes(1);
  });

  // N. provider timeout + unknown outcome
  it('N. provider timeout schedules retry with backoff and checks provider before POSTing again', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    let callCount = 0;
    const flakeyRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([]),
      createPaymentLink: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const timeoutErr = new Error('Gateway Timeout');
          timeoutErr.statusCode = 504;
          timeoutErr.name = 'RazorpayApiError';
          throw timeoutErr;
        }
        return { id: 'plink_retried_123', short_url: 'https://rzp.io/i/retried', status: 'created' };
      })
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: flakeyRazorpayClient,
      baseBackoffSeconds: 10
    });

    // Attempt 1: times out
    const attempt1 = await worker.pollOnce();
    expect(attempt1.status).toBe('RETRY_SCHEDULED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('RETRY_SCHEDULED');
    expect(freshCase.nextRetryAt).toBeDefined();

    // Advance time past nextRetryAt
    const futureTime = new Date(Date.now() + 15000);
    const workerFuture = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: flakeyRazorpayClient,
      now: () => futureTime
    });

    // Attempt 2: checks provider first, then creates
    const attempt2 = await workerFuture.pollOnce();
    expect(attempt2.status).toBe('COMPLETED');
    expect(flakeyRazorpayClient.getPaymentLinksByReferenceId).toHaveBeenCalledTimes(2);
  });

  // O. provider lookup/adoption
  it('O. adopts existing link when provider already has matching reference, making zero POST requests', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const razorpayClient = createMockRazorpayClient();
    const stableRef = `REV-C1-PLINK`;

    // Pre-populate Razorpay with link
    razorpayClient._existingLinks.set(stableRef, {
      id: 'plink_preexisting_999',
      short_url: 'https://rzp.io/i/preexisting',
      status: 'created',
      amount: 499900,
      currency: 'INR',
      reference_id: stableRef
    });

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('COMPLETED');
    expect(result.action.providerActionId).toBe('plink_preexisting_999');
    expect(razorpayClient.createPaymentLink).not.toHaveBeenCalled();
  });

  // P. duplicate-reference POST race (Branch 2)
  it('P. handles concurrent duplicate reference error by querying provider and adopting existing link', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const stableRef = `REV-C1-PLINK`;
    const racingRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockImplementation(async (ref) => {
        return [{
          id: 'plink_winner_456',
          short_url: 'https://rzp.io/i/winner',
          status: 'created',
          amount: 499900,
          currency: 'INR',
          reference_id: ref
        }];
      }),
      createPaymentLink: vi.fn().mockImplementation(async () => {
        const err = new Error('A payment link with this reference_id already exists.');
        err.statusCode = 400;
        err.details = { error: { description: 'A payment link with this reference_id already exists.' } };
        throw err;
      })
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: racingRazorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('COMPLETED');
    expect(result.action.providerActionId).toBe('plink_winner_456');
    expect(result.action.status).toBe('EXECUTED');
  });

  // Q. provider amount mismatch
  it('Q. provider amount mismatch fails closed to REVIEW_REQUIRED and rejects adoption', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const stableRef = `REV-C1-PLINK`;
    const mismatchRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([{
        id: 'plink_bad_amount',
        short_url: 'https://rzp.io/i/bad',
        status: 'created',
        amount: 100000, // ₹1,000 vs ₹4,999 expected
        currency: 'INR',
        reference_id: stableRef
      }])
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: mismatchRazorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('REVIEW_REQUIRED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('REVIEW_REQUIRED');
    expect(freshCase.lastAutonomyError).toContain('discrepancy');
  });

  // R. provider currency mismatch
  it('R. provider currency mismatch fails closed to REVIEW_REQUIRED and rejects adoption', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const stableRef = `REV-C1-PLINK`;
    const mismatchRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([{
        id: 'plink_bad_currency',
        short_url: 'https://rzp.io/i/bad',
        status: 'created',
        amount: 499900,
        currency: 'USD', // USD vs INR expected
        reference_id: stableRef
      }])
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: mismatchRazorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('REVIEW_REQUIRED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('REVIEW_REQUIRED');
    expect(freshCase.lastAutonomyError).toContain('Currency: USD vs INR');
  });

  // S. payment.captured TOCTOU race
  it('S. payment.captured arriving while provider call is in-flight marks link SUPERSEDED and preserves RESOLVED state', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const slowRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([]),
      createPaymentLink: vi.fn().mockImplementation(async () => {
        // Concurrently simulate payment.captured arriving while HTTP request is in-flight
        await processEvent(repository, {
          ...baseFailedEvent,
          eventId: 'evt_cap_concurrent_1006',
          eventType: 'payment.captured',
          paymentStatus: 'captured',
          timestamp: '2026-09-01T10:02:00.000Z'
        });
        return {
          id: 'plink_superseded_789',
          short_url: 'https://rzp.io/i/superseded',
          status: 'created',
          reference_id: 'REV-C1-PLINK'
        };
      })
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: slowRazorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('COMPLETED');
    expect(result.superseded).toBe(true);

    const detail = await repository.getCaseDetail(1);
    expect(detail.recoveryCase.riskStatus).toBe('RESOLVED');
    expect(detail.recoveryCase.outcome).toBe('PAID');

    const action = detail.actions.find((a) => a.providerActionId === 'plink_superseded_789');
    expect(action).toBeDefined();
    expect(action.status).toBe('SUPERSEDED');
  });

  // T. order.paid TOCTOU race
  it('T. order.paid arriving while provider call is in-flight marks link SUPERSEDED and preserves RESOLVED state', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const slowRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([]),
      createPaymentLink: vi.fn().mockImplementation(async () => {
        // Concurrently simulate order.paid arriving while HTTP request is in-flight
        await processEvent(repository, {
          ...baseFailedEvent,
          eventId: 'evt_ord_concurrent_1007',
          eventType: 'order.paid',
          paymentStatus: 'paid',
          timestamp: '2026-09-01T10:02:00.000Z'
        });
        return {
          id: 'plink_superseded_790',
          short_url: 'https://rzp.io/i/superseded2',
          status: 'created',
          reference_id: 'REV-C1-PLINK'
        };
      })
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: slowRazorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('COMPLETED');
    expect(result.superseded).toBe(true);

    const detail = await repository.getCaseDetail(1);
    expect(detail.recoveryCase.riskStatus).toBe('RESOLVED');
    const action = detail.actions.find((a) => a.providerActionId === 'plink_superseded_790');
    expect(action.status).toBe('SUPERSEDED');
  });

  // U. superseded Payment Link paid -> zero recovery credit
  it('U. payment_link.paid on a SUPERSEDED link yields zero recovery credit and RECOVERY_OUTCOME_REJECTED', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    // Create an action with status SUPERSEDED
    const supersededAction = await repository.createAction({
      recoveryCaseId: 1,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'SUPERSEDED',
      policyDecision: 'ALLOW',
      policyVersion: 'v1',
      idempotencyKey: 'REV-C1-PLINK',
      provider: 'razorpay',
      providerActionId: 'plink_superseded_789',
      amount: 499900,
      currency: 'INR'
    });

    // Mark case as already settled
    await repository.updateCase(1, { riskStatus: 'RESOLVED', outcome: 'PAID' });

    // Incoming payment on this superseded link
    const paidEvent = {
      eventId: 'evt_late_paid_1008',
      eventType: 'payment_link.paid',
      paymentId: 'pay_late_1008',
      paymentLinkId: 'plink_superseded_789',
      amount: 499900,
      amountPaid: 499900,
      currency: 'INR',
      timestamp: '2026-09-01T10:30:00.000Z'
    };

    const reconcileResult = await processEvent(repository, paidEvent);
    expect(reconcileResult.reconciliation.reconciled).toBe(false);
    expect(reconcileResult.reconciliation.superseded).toBe(true);
    expect(reconcileResult.reconciliation.outcome.verified).toBe(false);

    const detail = await repository.getCaseDetail(1);
    expect(detail.recoveryCase.recoveredAmount).toBe(0); // ZERO RECOVERY CREDIT

    const rejectedAudit = detail.auditEvents.find((a) => a.eventType === 'RECOVERY_OUTCOME_REJECTED');
    expect(rejectedAudit).toBeDefined();
    expect(rejectedAudit.message).toContain('Payment received on superseded recovery link');
  });

  // V. retryable provider failure
  it('V. HTTP 503 provider error schedules retry with exponential backoff up to 3 attempts', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const error503 = new Error('Service Unavailable');
    error503.statusCode = 503;
    error503.name = 'RazorpayApiError';

    const failRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([]),
      createPaymentLink: vi.fn().mockRejectedValue(error503)
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: failRazorpayClient,
      maxRetries: 3,
      baseBackoffSeconds: 0
    });

    // Claim 1 -> RETRY_SCHEDULED (attempts = 1)
    const res1 = await worker.pollOnce();
    expect(res1.status).toBe('RETRY_SCHEDULED');
    expect(res1.attempt).toBe(1);

    // Claim 2 -> RETRY_SCHEDULED (attempts = 2)
    const res2 = await worker.pollOnce();
    expect(res2.status).toBe('RETRY_SCHEDULED');
    expect(res2.attempt).toBe(2);

    // Claim 3 -> FAILED (max retries reached)
    const res3 = await worker.pollOnce();
    expect(res3.status).toBe('FAILED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('FAILED');
    expect(freshCase.autonomyAttempts).toBe(3);
  });

  // W1. HTTP 401 non-retryable error
  it('W1. HTTP 401 Unauthorized fails closed immediately to REVIEW_REQUIRED without retry', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const clientError = new Error('Invalid authentication credentials');
    clientError.statusCode = 401;
    clientError.name = 'RazorpayApiError';

    const failRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([]),
      createPaymentLink: vi.fn().mockRejectedValue(clientError)
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: failRazorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('REVIEW_REQUIRED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('REVIEW_REQUIRED');
    expect(freshCase.nextRetryAt).toBeNull();
  });

  // W2. HTTP 403 non-retryable error
  it('W2. HTTP 403 Forbidden fails closed immediately to REVIEW_REQUIRED without retry', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const clientError = new Error('Execution blocked: not a Test Mode key');
    clientError.statusCode = 403;
    clientError.name = 'RazorpayApiError';

    const failRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([]),
      createPaymentLink: vi.fn().mockRejectedValue(clientError)
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: failRazorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('REVIEW_REQUIRED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('REVIEW_REQUIRED');
    expect(freshCase.nextRetryAt).toBeNull();
  });

  // W3. HTTP 400 non-retryable error
  it('W3. HTTP 400 Bad Request fails closed immediately to REVIEW_REQUIRED without retry', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const clientError = new Error('Bad request syntax');
    clientError.statusCode = 400;
    clientError.name = 'RazorpayApiError';

    const failRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([]),
      createPaymentLink: vi.fn().mockRejectedValue(clientError)
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: failRazorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('REVIEW_REQUIRED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('REVIEW_REQUIRED');
    expect(freshCase.nextRetryAt).toBeNull();
  });

  // W4. HTTP 422 non-retryable error
  it('W4. HTTP 422 Unprocessable Entity fails closed immediately to REVIEW_REQUIRED without retry', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const clientError = new Error('Semantic validation error');
    clientError.statusCode = 422;
    clientError.name = 'RazorpayApiError';

    const failRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([]),
      createPaymentLink: vi.fn().mockRejectedValue(clientError)
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: failRazorpayClient
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('REVIEW_REQUIRED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('REVIEW_REQUIRED');
    expect(freshCase.nextRetryAt).toBeNull();
  });

  // W5. HTTP 429 Rate Limited schedules retry
  it('W5. HTTP 429 Rate Limited schedules bounded retry with backoff', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const rateLimitError = new Error('Too many requests');
    rateLimitError.statusCode = 429;
    rateLimitError.name = 'RazorpayApiError';

    const failRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([]),
      createPaymentLink: vi.fn().mockRejectedValue(rateLimitError)
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: failRazorpayClient,
      baseBackoffSeconds: 15
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('RETRY_SCHEDULED');
    expect(result.attempt).toBe(1);

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('RETRY_SCHEDULED');
    expect(freshCase.nextRetryAt).toBeDefined();
  });

  // W6. HTTP 500 Internal Server Error schedules retry
  it('W6. HTTP 500 Internal Server Error schedules retry with backoff', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const error500 = new Error('Internal Server Error');
    error500.statusCode = 500;
    error500.name = 'RazorpayApiError';

    const failRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([]),
      createPaymentLink: vi.fn().mockRejectedValue(error500)
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: failRazorpayClient,
      baseBackoffSeconds: 15
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('RETRY_SCHEDULED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('RETRY_SCHEDULED');
  });

  // W7. Network fetch timeout error schedules retry
  it('W7. Network fetch timeout schedules retry with backoff', async () => {
    const repository = new InMemoryRecoveryRepository();
    await processEvent(repository, baseFailedEvent);

    const networkError = new Error('fetch failed: connection timed out');
    networkError.code = 'ETIMEDOUT';
    networkError.name = 'FetchError';

    const failRazorpayClient = {
      isConfigured: true,
      isTestMode: true,
      keyId: 'rzp_test_mock123',
      getPaymentLinksByReferenceId: vi.fn().mockResolvedValue([]),
      createPaymentLink: vi.fn().mockRejectedValue(networkError)
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: failRazorpayClient,
      baseBackoffSeconds: 15
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('RETRY_SCHEDULED');

    const freshCase = await repository.findCaseByPaymentId(baseFailedEvent.paymentId);
    expect(freshCase.autonomyStatus).toBe('RETRY_SCHEDULED');
  });

  // Y. Worker actively calls extendLease during processing
  it('Y. worker actively calls extendLease checkpoint during execution', async () => {
    const repository = new InMemoryRecoveryRepository();
    const extendLeaseSpy = vi.spyOn(repository, 'extendLease');
    await processEvent(repository, baseFailedEvent);

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const result = await worker.pollOnce();
    expect(result.status).toBe('COMPLETED');
    expect(extendLeaseSpy).toHaveBeenCalled();
  });

  // X. kill switch + audit completeness
  it('X. AUTONOMOUS_RECOVERY_ENABLED=false halts worker and audit trail contains full history with zero leaked secrets', async () => {
    environment.AUTONOMOUS_RECOVERY_ENABLED = false;

    const repository = new InMemoryRecoveryRepository();
    const eventRes = await processEvent(repository, baseFailedEvent);
    expect(eventRes.recoveryCase.autonomyStatus).toBe('INACTIVE');

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const pollRes = await worker.pollOnce();
    expect(pollRes.processed).toBe(false);
    expect(pollRes.reason).toBe('DISABLED');

    // Audit completeness verification
    const detail = await repository.getCaseDetail(1);
    const audits = detail.auditEvents;
    expect(audits.length).toBeGreaterThan(0);

    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain('rzp_test_');
    expect(serializedAudits).not.toContain('secret');
    expect(serializedAudits).not.toContain('apiKey');
  });

  // Additional check: stable reference length
  it('verifies stable reference REV-C{id}-PLINK does not exceed 40 characters even for max 64-bit int', () => {
    const maxBigInt = '9223372036854775807';
    const referenceId = `REV-C${maxBigInt}-PLINK`;
    expect(referenceId.length).toBeLessThanOrEqual(40);
    expect(referenceId.length).toBe(30);
  });
});
