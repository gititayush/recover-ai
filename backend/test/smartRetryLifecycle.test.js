const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { processEvent } = require('../src/services/eventService');
const { createRecoveryWorker } = require('../src/worker/recoveryWorker');
const { executeSimulatedAction } = require('../src/actions/simulatedActionExecutor');
const { evaluatePolicy } = require('../src/policy/policyEngine');
const { evaluateStoppingCriteria, STOP_REASON_CODES } = require('../src/policy/stoppingEngine');
const { environment } = require('../src/config/env');

describe('Stateful Smart Retry Lifecycle (SCHEDULE_RETRY_WINDOW)', () => {
  const baseSubscriptionFailedEvent = {
    eventId: 'evt_sub_fail_101',
    eventType: 'subscription.renewal_failed',
    paymentId: 'sub_pay_fail_101',
    orderId: 'sub_order_101',
    amount: 199900, // ₹1,999
    currency: 'INR',
    paymentStatus: 'failed',
    failureReason: 'Mandate auto-debit failure',
    customerReference: 'cust_sub_101',
    timestamp: '2026-09-04T10:00:00.000Z'
  };

  it('1. schedules retry window, persists nextRetryAt, and sets case autonomyStatus to RETRY_SCHEDULED', async () => {
    const repository = new InMemoryRecoveryRepository();
    const eventResult = await processEvent(repository, baseSubscriptionFailedEvent);
    const recoveryCase = eventResult.recoveryCase;

    const baseTime = new Date('2026-09-04T10:00:00.000Z');
    const result = await executeSimulatedAction(repository, {
      recoveryCase,
      actionType: 'SCHEDULE_RETRY_WINDOW',
      now: () => baseTime
    });

    expect(result.executed).toBe(true);
    expect(result.action.actionType).toBe('SCHEDULE_RETRY_WINDOW');
    expect(result.action.status).toBe('EXECUTED');

    // Case state must be genuinely stateful
    const updatedCase = await repository.findCaseByPaymentId(baseSubscriptionFailedEvent.paymentId);
    expect(updatedCase.autonomyStatus).toBe('RETRY_SCHEDULED');
    expect(updatedCase.nextRetryAt).toBeDefined();

    const nextRetryTime = new Date(updatedCase.nextRetryAt).getTime();
    expect(nextRetryTime).toBeGreaterThan(baseTime.getTime());

    // Audit trail must record the scheduled retry window
    const detail = await repository.getCaseDetail(recoveryCase.id);
    const scheduledAudit = detail.auditEvents.find((a) => a.eventType === 'RETRY_WINDOW_SCHEDULED');
    expect(scheduledAudit).toBeDefined();
    expect(scheduledAudit.message).toContain('Smart Retry Window scheduled');
  });

  it('2. claimNextJob does NOT claim early before nextRetryAt elapses', async () => {
    const repository = new InMemoryRecoveryRepository();
    const eventResult = await processEvent(repository, baseSubscriptionFailedEvent);
    const recoveryCase = eventResult.recoveryCase;

    const baseTime = new Date('2026-09-04T10:00:00.000Z');
    await executeSimulatedAction(repository, {
      recoveryCase,
      actionType: 'SCHEDULE_RETRY_WINDOW',
      now: () => baseTime
    });

    // 10 minutes later (still within 48h retry delay window)
    const earlyTime = new Date('2026-09-04T10:10:00.000Z');
    const claimedEarly = await repository.claimNextJob({
      workerId: 'test-worker-1',
      leaseDurationSeconds: 60,
      now: earlyTime
    });

    // Worker must NOT claim before due
    expect(claimedEarly).toBeNull();
  });

  it('3. claimNextJob claims when nextRetryAt is reached or passed', async () => {
    const repository = new InMemoryRecoveryRepository();
    const eventResult = await processEvent(repository, baseSubscriptionFailedEvent);
    const recoveryCase = eventResult.recoveryCase;

    const baseTime = new Date('2026-09-04T10:00:00.000Z');
    await executeSimulatedAction(repository, {
      recoveryCase,
      actionType: 'SCHEDULE_RETRY_WINDOW',
      now: () => baseTime
    });

    const updatedCase = await repository.findCaseByPaymentId(baseSubscriptionFailedEvent.paymentId);
    const dueTime = new Date(new Date(updatedCase.nextRetryAt).getTime() + 1000);

    const claimed = await repository.claimNextJob({
      workerId: 'test-worker-1',
      leaseDurationSeconds: 60,
      now: dueTime
    });

    expect(claimed).toBeDefined();
    expect(claimed.id).toBe(recoveryCase.id);
    expect(claimed.autonomyStatus).toBe('CLAIMED');
    expect(claimed.autonomyAttempts).toBe(1);
  });

  it('4. retry scheduling is strictly idempotent (does not duplicate actions or loops)', async () => {
    const repository = new InMemoryRecoveryRepository();
    const eventResult = await processEvent(repository, baseSubscriptionFailedEvent);
    const recoveryCase = eventResult.recoveryCase;

    const baseTime = new Date('2026-09-04T10:00:00.000Z');
    const firstCall = await executeSimulatedAction(repository, {
      recoveryCase,
      actionType: 'SCHEDULE_RETRY_WINDOW',
      now: () => baseTime
    });
    expect(firstCall.duplicate).toBe(false);

    const secondCall = await executeSimulatedAction(repository, {
      recoveryCase,
      actionType: 'SCHEDULE_RETRY_WINDOW',
      now: () => baseTime
    });

    expect(secondCall.duplicate).toBe(true);
    expect(secondCall.executed).toBe(true);

    const actions = await repository.findActionsByCaseId(recoveryCase.id);
    expect(actions).toHaveLength(1);
  });

  it('5. TOCTOU safety: stops and resolves without duplicate action if payment settles before retry execution', async () => {
    const repository = new InMemoryRecoveryRepository();
    const eventResult = await processEvent(repository, baseSubscriptionFailedEvent);
    const recoveryCase = eventResult.recoveryCase;

    const baseTime = new Date('2026-09-04T10:00:00.000Z');
    await executeSimulatedAction(repository, {
      recoveryCase,
      actionType: 'SCHEDULE_RETRY_WINDOW',
      now: () => baseTime
    });

    const updatedCase = await repository.findCaseByPaymentId(baseSubscriptionFailedEvent.paymentId);
    const dueTime = new Date(new Date(updatedCase.nextRetryAt).getTime() + 1000);

    // Customer settles externally before worker execution
    await processEvent(repository, {
      eventId: 'evt_settled_midway',
      eventType: 'payment.captured',
      paymentId: baseSubscriptionFailedEvent.paymentId,
      orderId: baseSubscriptionFailedEvent.orderId,
      amount: baseSubscriptionFailedEvent.amount,
      currency: 'INR',
      paymentStatus: 'captured',
      customerReference: baseSubscriptionFailedEvent.customerReference,
      timestamp: new Date(baseTime.getTime() + 3600000).toISOString()
    });

    const worker = createRecoveryWorker({
      repository,
      now: () => dueTime
    });

    const result = await worker.pollOnce();
    expect(result.processed).toBe(false);

    // Case is marked RESOLVED and autonomy status is COMPLETED
    const finalCase = await repository.findCaseByPaymentId(baseSubscriptionFailedEvent.paymentId);
    expect(finalCase.riskStatus).toBe('RESOLVED');
    expect(finalCase.autonomyStatus).toBe('COMPLETED');

    // No duplicate recovery actions are created (only the initial schedule action)
    const actions = await repository.findActionsByCaseId(recoveryCase.id);
    expect(actions).toHaveLength(1);
  });

  it('6. stops and escalates when max automated attempts are reached', async () => {
    const repository = new InMemoryRecoveryRepository();
    const eventResult = await processEvent(repository, baseSubscriptionFailedEvent);
    const recoveryCase = eventResult.recoveryCase;

    // Simulate 3 prior business attempts
    const existingActions = [
      { id: 1, status: 'EXECUTED', createdAt: '2026-09-01T10:00:00.000Z' },
      { id: 2, status: 'EXECUTED', createdAt: '2026-09-02T10:00:00.000Z' },
      { id: 3, status: 'EXECUTED', createdAt: '2026-09-03T10:00:00.000Z' }
    ];

    const policy = evaluatePolicy({
      recoveryCase,
      candidateAction: 'SCHEDULE_RETRY_WINDOW',
      events: [baseSubscriptionFailedEvent],
      existingActions,
      maxAutomatedAttempts: 3,
      allowSimulated: true
    });

    expect(policy.decision).toBe('REVIEW');
    expect(policy.reasons.some((r) => r.includes('Maximum automated recovery attempts'))).toBe(true);
  });

  it('7. customer opt-out triggers hard stop and prevents retry execution', async () => {
    const repository = new InMemoryRecoveryRepository();
    const optOutEvent = {
      ...baseSubscriptionFailedEvent,
      failureReason: 'Customer requested opt-out'
    };
    const eventResult = await processEvent(repository, optOutEvent);
    const recoveryCase = {
      ...eventResult.recoveryCase,
      customerOptOut: true
    };

    const stopping = evaluateStoppingCriteria({
      recoveryCase,
      events: [optOutEvent],
      candidateAction: 'SCHEDULE_RETRY_WINDOW'
    });

    expect(stopping.stopped).toBe(true);
    expect(stopping.reasonCode).toBe(STOP_REASON_CODES.CUSTOMER_OPT_OUT);
    expect(stopping.actionDisposition).toBe('HARD_STOP');

    const policy = evaluatePolicy({
      recoveryCase,
      events: [optOutEvent],
      candidateAction: 'SCHEDULE_RETRY_WINDOW',
      allowSimulated: true
    });

    expect(policy.decision).toBe('BLOCK');
  });

  it('8. bank switch timeout schedules an expedited short retry window (15m)', async () => {
    const event = {
      eventId: 'evt_bank_switch_expedited',
      eventType: 'subscription.renewal_failed',
      paymentId: 'pay_switch_expedited',
      orderId: 'order_switch_01',
      amount: 150000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Bank switch timeout during auto-debit',
      customerReference: 'cust_switch_01',
      timestamp: '2026-09-04T10:00:00.000Z'
    };
    const repository = new InMemoryRecoveryRepository();
    const eventResult = await processEvent(repository, event);
    const recoveryCase = eventResult.recoveryCase;

    const baseTime = new Date('2026-09-04T10:00:00.000Z');
    const result = await executeSimulatedAction(repository, {
      recoveryCase,
      diagnosis: {
        diagnosis: { failureFamily: 'BANK_SWITCH_TIMEOUT', confidence: 0.85 }
      },
      actionType: 'SCHEDULE_RETRY_WINDOW',
      events: [event],
      now: () => baseTime
    });

    expect(result.executed).toBe(true);

    const updatedCase = await repository.findCaseByPaymentId('pay_switch_expedited');
    const expectedTime = new Date(baseTime.getTime() + 15 * 60 * 1000).toISOString();
    expect(updatedCase.nextRetryAt).toBe(expectedTime);
  });
});
