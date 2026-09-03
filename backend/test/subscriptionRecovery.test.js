const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { playbookEngine } = require('../src/playbooks/playbookEngine');
const { processEvent } = require('../src/services/eventService');
const { createDiagnosisService } = require('../src/ai/diagnosisService');
const { evaluatePolicy } = require('../src/policy/policyEngine');
const { executePaymentLink } = require('../src/actions/paymentLinkExecutor');
const { executeSimulatedAction } = require('../src/actions/simulatedActionExecutor');
const { reconcileOutcome } = require('../src/services/reconciliationService');
const { evaluateBatch } = require('../src/services/batchRecoveryService');
const { getOverallOutcomeAnalytics } = require('../src/services/outcomeAnalyticsService');

function mockRazorpayClient(overrides = {}) {
  return {
    isConfigured: true,
    isTestMode: true,
    keyId: 'rzp_test_mock123',
    createPaymentLink: vi.fn().mockResolvedValue({
      id: 'plink_sub_mock_001',
      short_url: 'https://rzp.io/i/sub_mock_001',
      status: 'created',
      amount: 499900,
      currency: 'INR',
      reference_id: 'razorpay_case_1_plink_v1'
    }),
    ...overrides
  };
}

function mockAiProvider(proposal) {
  return {
    provider: 'test-mock-ai',
    model: 'gpt-4.1-mini',
    source: 'test',
    diagnose: vi.fn().mockResolvedValue(proposal)
  };
}

describe('Revflow V2 — Milestone 6B: Subscription / Recurring Revenue Recovery', () => {
  let repository;
  let rzpClient;
  let app;

  beforeEach(() => {
    repository = new InMemoryRecoveryRepository();
    rzpClient = mockRazorpayClient();
    app = createApp(repository, { razorpayClient: rzpClient });
  });

  // Test 1: renewal_failed selects failed_subscription
  it('1. subscription renewal failure matches failed_subscription playbook', () => {
    const event = {
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_sess_001',
      amount: 299900,
      currency: 'INR'
    };
    const playbook = playbookEngine.identifyPlaybook(event);
    expect(playbook.id).toBe('failed_subscription');
  });

  // Test 2: payment.failed still selects payment_degradation
  it('2. payment.failed still selects payment_degradation', () => {
    const event = {
      eventType: 'payment.failed',
      paymentId: 'pay_fail_002',
      amount: 150000,
      currency: 'INR'
    };
    const playbook = playbookEngine.identifyPlaybook(event);
    expect(playbook.id).toBe('payment_degradation');
  });

  // Test 3: cancelled subscription hard-stops
  it('3. cancelled subscription is not recoverable and triggers terminal state', async () => {
    // 1. Ingest renewal failure
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_03_fail',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_03_cancel',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    // 2. Customer cancels subscription
    const cancelRes = await request(app).post('/api/events').send({
      eventId: 'evt_sub_03_cancel',
      eventType: 'subscription.cancelled',
      paymentId: 'sub_03_cancel',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    expect(cancelRes.body.recoveryCase.riskStatus).toBe('SUPPRESSED');
    expect(cancelRes.body.recoveryCase.outcome).toBe('CANCELLED');

    // 3. Policy evaluation blocks recovery on cancelled subscription
    const policyRes = await request(app).post('/api/cases/1/policy').send().expect(200);
    expect(policyRes.body.policy.decision).toBe('BLOCK');
  });

  // Test 4: paused subscription follows intended WAIT/STOP semantics
  it('4. paused subscription follows intended WAIT/STOP semantics', async () => {
    // Ingest renewal failure
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_04_fail',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_04_pause',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    // Ingest pause event
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_04_pause',
      eventType: 'subscription.paused',
      paymentId: 'sub_04_pause',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    // Policy blocks execution while paused
    const policyRes = await request(app).post('/api/cases/1/policy').send().expect(200);
    expect(policyRes.body.policy.decision).toBe('BLOCK');
    expect(policyRes.body.policy.reasons.some((r) => r.includes('paused'))).toBe(true);
  });

  // Test 5: already-paid renewal stops
  it('5. renewal already paid stops recovery', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_05_fail',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_05_paid',
      amount: 250000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    // Later, subscription charged event arrives
    const paidRes = await request(app).post('/api/events').send({
      eventId: 'evt_sub_05_charged',
      eventType: 'subscription.charged',
      paymentId: 'sub_05_paid',
      amount: 250000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    expect(paidRes.body.recoveryCase.riskStatus).toBe('RESOLVED');
    expect(paidRes.body.recoveryCase.outcome).toBe('PAID');

    // Policy recheck blocks further action
    const policyRes = await request(app).post('/api/cases/1/policy').send().expect(200);
    expect(policyRes.body.policy.decision).toBe('BLOCK');
  });

  // Test 6: expired subscription stops
  it('6. expired subscription stops recovery', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_06_fail',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_06_exp',
      amount: 300000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    // Ingest expired event
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_06_expired',
      eventType: 'subscription.expired',
      paymentId: 'sub_06_exp',
      amount: 300000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const policyRes = await request(app).post('/api/cases/1/policy').send().expect(200);
    expect(policyRes.body.policy.decision).toBe('BLOCK');
    expect(policyRes.body.policy.reasons.some((r) => r.includes('expired'))).toBe(true);
  });

  // Test 7: retry exhaustion escalates
  it('7. retry-exhausted subscription escalates to human review', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_07_fail3',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_07_exhaust',
      amount: 400000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      rawPayload: {
        attemptNumber: 3,
        subscriptionId: 'sub_07_exhaust'
      }
    }).expect(201);

    const policyRes = await request(app).post('/api/cases/1/policy').send().expect(200);
    expect(policyRes.body.policy.decision).toBe('REVIEW');
    expect(policyRes.body.policy.reasons.some((r) => r.includes('exhausted') || r.includes('review'))).toBe(true);
  });

  // Test 8: missing optional fields remain unknown
  it('8. missing optional fields remain unknown and are never hallucinated', () => {
    const event = {
      eventId: 'evt_sub_08_min',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_08_sparse',
      amount: 150000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    };
    const playbook = playbookEngine.identifyPlaybook(event);
    const context = playbook.extractContext(event, { recoveryCase: { paymentId: 'sub_08_sparse', amount: 150000, currency: 'INR' } });

    expect(context.billingCycle).toBeNull();
    expect(context.mandateStatus).toBeNull();
    expect(context.renewalDueTimestamp).toBeNull();
    expect(context.lastSuccessfulPaymentTimestamp).toBeNull();
    expect(context.attemptNumber).toBe(1);
    expect(context.salaryDate).toBeUndefined();
    expect(context.customerIncome).toBeUndefined();
  });

  // Test 9: malformed subscription input rejected
  it('9. malformed subscription input rejected safely with 400 Bad Request', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_09_bad',
      eventType: 'subscription.renewal_failed',
      amount: 50000,
      currency: 'INR'
    }).expect(400);

    await request(app).post('/api/events').send({
      eventId: 'evt_sub_09_neg',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_09_neg',
      amount: -100,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(400);
  });

  // Test 10: amount integrity
  it('10. amount integrity preserved across detection and case storage in paise', async () => {
    const exactPaise = 749900;
    const res = await request(app).post('/api/events').send({
      eventId: 'evt_sub_10_amt',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_10_amt',
      amount: exactPaise,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    expect(res.body.recoveryCase.amount).toBe(exactPaise);
    const detail = await repository.getCaseDetail(1);
    expect(detail.recoveryCase.amount).toBe(exactPaise);
  });

  // Test 11: currency integrity
  it('11. currency integrity preserved (rejects non-INR currencies from recovery)', async () => {
    const res = await request(app).post('/api/events').send({
      eventId: 'evt_sub_11_curr',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_11_curr',
      amount: 50000,
      currency: 'USD',
      timestamp: new Date().toISOString()
    }).expect(201);
    expect(res.body.recoveryCase).toBeNull();
  });

  // Test 12: high-value escalation
  it('12. high-value subscription escalates for human approval (> ₹25,000 / 2,500,000 paise)', async () => {
    const highValuePaise = 3000000; // ₹30,000
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_12_hv',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_12_hv',
      amount: highValuePaise,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const policyRes = await request(app).post('/api/cases/1/policy').send({
      action: 'CREATE_PAYMENT_LINK'
    }).expect(200);

    expect(policyRes.body.policy.decision).toBe('REVIEW');
    expect(policyRes.body.policy.reasons.some((r) => r.includes('exceeds') || r.includes('limit'))).toBe(true);

    // Direct execution rejected without approval
    await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'CREATE_PAYMENT_LINK'
    }).expect(422);
  });

  // Test 13: low-confidence escalation
  it('13. low-confidence subscription diagnosis escalates to manual review', async () => {
    const customAi = mockAiProvider({
      diagnosis: {
        category: 'FAILED_SUBSCRIPTION',
        cause: 'Uncertain subscription decline reason',
        confidence: 0.40,
        evidence: [{ field: 'case.amount', value: '150000' }]
      },
      recommendation: { action: 'SCHEDULE_RETRY_WINDOW' }
    });
    const customApp = createApp(repository, {
      diagnosisService: createDiagnosisService({ provider: customAi }),
      razorpayClient: rzpClient
    });

    await request(customApp).post('/api/events').send({
      eventId: 'evt_sub_13_lc',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_13_lc',
      amount: 150000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const policyRes = await request(customApp).post('/api/cases/1/policy').send().expect(200);
    expect(policyRes.body.policy.decision).toBe('REVIEW');
    expect(policyRes.body.policy.reasons.some((r) => r.includes('confidence'))).toBe(true);
  });

  // Test 14: simulated retry does not call Razorpay
  it('14. simulated retry does not call Razorpay API', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_14_sim',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_14_sim',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const actionRes = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'SCHEDULE_RETRY_WINDOW'
    }).expect(201);

    expect(actionRes.body.action.status).toBe('EXECUTED');
    expect(actionRes.body.action.provider).toBe('simulated');
    expect(rzpClient.createPaymentLink).not.toHaveBeenCalled();
  });

  // Test 15: simulated retry does not recover revenue
  it('15. simulated retry does not increase recovered revenue', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_15_rev',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_15_rev',
      amount: 250000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'SCHEDULE_RETRY_WINDOW'
    }).expect(201);

    const detail = await repository.getCaseDetail(1);
    expect(Number(detail.recoveryCase.recoveredAmount)).toBe(0);

    const analytics = await getOverallOutcomeAnalytics(repository);
    expect(analytics.portfolioFunnel.funnel.recoveredRevenuePaise).toBe(0);
    expect(analytics.portfolioFunnel.funnel.verified).toBe(0);
  });

  // Test 16: retry timestamp deterministic
  it('16. retry timestamp is deterministically computed based on policy', async () => {
    const fixedNow = new Date('2026-09-03T10:00:00.000Z');
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_16_time',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_16_time',
      amount: 199900,
      currency: 'INR',
      timestamp: fixedNow.toISOString()
    }).expect(201);

    const detail = await repository.getCaseDetail(1);
    const diagnosisService = createDiagnosisService();
    const diagnosis = await diagnosisService.diagnose(detail);

    const result = await executeSimulatedAction(repository, {
      recoveryCase: detail.recoveryCase,
      diagnosis,
      actionType: 'SCHEDULE_RETRY_WINDOW',
      events: detail.events,
      now: () => fixedNow
    });

    const expectedNextRetry = new Date(fixedNow.getTime() + 48 * 3600 * 1000).toISOString();
    expect(result.action.responseMetadata.nextRetryAt).toBe(expectedNextRetry);
    expect(result.action.requestMetadata.retrySchedule.nextRetryAt).toBe(expectedNextRetry);
  });

  // Test 17: retry respects cooldown
  it('17. retry respects cooldown period and blocks rapid re-execution', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_17_cd',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_17_cd',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    // First execution succeeds
    await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'SCHEDULE_RETRY_WINDOW'
    }).expect(201);

    // Policy recheck for candidate with new reference evaluates cooldown
    const detail = await repository.getCaseDetail(1);
    const policy = evaluatePolicy({
      recoveryCase: detail.recoveryCase,
      candidateAction: 'SCHEDULE_RETRY_WINDOW',
      events: detail.events,
      existingActions: detail.actions,
      cooldownMinutes: 60,
      candidateReference: 'new_distinct_attempt_ref_2',
      allowSimulated: true
    });

    expect(policy.decision).toBe('BLOCK');
    const cooldownRule = policy.rulesEvaluated.find((r) => r.rule === 'cooldown_period');
    expect(cooldownRule.status).toBe('REVIEW');
    expect(cooldownRule.message).toContain('Cooldown period');
  });

  // Test 18: retry respects max attempts
  it('18. retry respects maximum automated attempts', async () => {
    const detail = {
      recoveryCase: { id: 1, amount: 150000, currency: 'INR', riskStatus: 'RECOVERABLE', riskLevel: 'MEDIUM', paymentId: 'sub_18_max' },
      events: [{ eventType: 'subscription.renewal_failed', timestamp: new Date().toISOString() }],
      existingActions: [
        { id: 1, status: 'EXECUTED', createdAt: new Date(Date.now() - 3600000).toISOString() },
        { id: 2, status: 'EXECUTED', createdAt: new Date(Date.now() - 1800000).toISOString() }
      ]
    };

    const policy = evaluatePolicy({
      recoveryCase: detail.recoveryCase,
      candidateAction: 'SCHEDULE_RETRY_WINDOW',
      events: detail.events,
      existingActions: detail.existingActions,
      maxAutomatedAttempts: 2,
      allowSimulated: true
    });

    expect(policy.decision).toBe('REVIEW');
    expect(policy.reasons.some((r) => r.includes('Maximum automated recovery attempts'))).toBe(true);
  });

  // Test 19: CREATE_PAYMENT_LINK uses existing bounded executor
  it('19. CREATE_PAYMENT_LINK uses existing bounded executor and calls Razorpay test mode', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_19_link',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_19_link',
      amount: 499900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const actionRes = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'CREATE_PAYMENT_LINK'
    }).expect(201);

    expect(actionRes.body.action.status).toBe('EXECUTED');
    expect(actionRes.body.action.provider).toBe('razorpay');
    expect(rzpClient.createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({
      amount: 499900,
      currency: 'INR'
    }));
  });

  // Test 20: Payment Link outcome reconciles through existing service
  it('20. Payment Link outcome reconciles through existing reconciliation service', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_20_rec',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_20_rec',
      amount: 499900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const actionRes = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'CREATE_PAYMENT_LINK'
    }).expect(201);
    const paymentLinkId = actionRes.body.action.providerActionId;

    const paidWebhook = {
      eventId: 'evt_wh_sub_paid_20',
      eventType: 'payment_link.paid',
      paymentId: 'pay_rzp_sub_real_999',
      paymentLinkId,
      referenceId: actionRes.body.action.idempotencyKey,
      amount: 499900,
      amountPaid: 499900,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      rawPayload: {
        event: 'payment_link.paid'
      }
    };

    const reconciliation = await reconcileOutcome(repository, paidWebhook);
    expect(reconciliation.reconciled).toBe(true);
    expect(reconciliation.outcome.outcome).toBe('PAID');
    expect(reconciliation.outcome.amountPaid).toBe(499900);

    const finalDetail = await repository.getCaseDetail(1);
    expect(finalDetail.recoveryCase.riskStatus).toBe('RESOLVED');
    expect(Number(finalDetail.recoveryCase.recoveredAmount)).toBe(499900);
  });

  // Test 21: duplicate subscription events are idempotent
  it('21. duplicate subscription events are idempotent', async () => {
    const eventPayload = {
      eventId: 'evt_sub_21_dup',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_21_dup',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    };

    const first = await request(app).post('/api/events').send(eventPayload).expect(201);
    expect(first.body.duplicate).toBe(false);

    const second = await request(app).post('/api/events').send(eventPayload).expect(200);
    expect(second.body.duplicate).toBe(true);
  });

  // Test 22: same renewal attempt does not create duplicate recovery
  it('22. same renewal attempt updates existing case idempotently', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_22_a',
      eventType: 'subscription.renewal_due',
      paymentId: 'sub_22_same',
      amount: 299900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    // Later failure on same subscription
    const res = await request(app).post('/api/events').send({
      eventId: 'evt_sub_22_b',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_22_same',
      amount: 299900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    expect(res.body.recoveryCase.id).toBe(1);
    expect(res.body.recoveryCase.riskStatus).toBe('RECOVERABLE');
  });

  // Test 23: stopping reason is auditable
  it('23. stopping reasons are recorded in audit trail', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_23_term',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_23_term',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    await request(app).post('/api/events').send({
      eventId: 'evt_sub_23_cancel',
      eventType: 'subscription.cancelled',
      paymentId: 'sub_23_term',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const audits = await repository.getAllAudits ? await repository.getAllAudits() : repository.audits;
    const terminalAudit = audits.find((a) => a.eventType === 'CASE_UPDATED' && a.metadata?.outcome === 'CANCELLED');
    expect(terminalAudit).toBeDefined();
  });

  // Test 24: analytics identify subscription recovery correctly
  it('24. analytics identify subscription recovery correctly without inflating revenue', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_24_an',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_24_an',
      amount: 350000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'SCHEDULE_RETRY_WINDOW'
    }).expect(201);

    const analytics = await getOverallOutcomeAnalytics(repository);
    expect(analytics.strategyPerformance.SCHEDULE_RETRY_WINDOW.executed).toBe(1);
    expect(analytics.strategyPerformance.SCHEDULE_RETRY_WINDOW.verifiedRecoveries).toBe(0);
    expect(analytics.strategyPerformance.SCHEDULE_RETRY_WINDOW.recoveredAmountPaise).toBe(0);
  });

  // Test 25: batch simulation supports subscription scenarios
  it('25. batch simulation supports subscription scenarios and selects SCHEDULE_RETRY_WINDOW', () => {
    const batchInput = [
      {
        caseId: 101,
        paymentId: 'sub_batch_101',
        amount: 499900,
        currency: 'INR',
        riskLevel: 'MEDIUM',
        failureReason: 'Recurring mandate auto-debit failed: card expired',
        playbook: 'failed_subscription'
      }
    ];

    const result = evaluateBatch(batchInput, { isTestMode: true });
    expect(result.totalCases).toBe(1);
    expect(result.itemEvaluations[0].strategy).toBe('SCHEDULE_RETRY_WINDOW');
    expect(result.itemEvaluations[0].executionMode).toBe('SIMULATED');
  });

  // Test 26: synthetic results remain SIMULATED_BATCH
  it('26. synthetic metrics remain SIMULATED_BATCH and do not inflate verified revenue', () => {
    const batchInput = [
      {
        caseId: 201,
        paymentId: 'sub_batch_201',
        amount: 500000,
        currency: 'INR',
        riskLevel: 'LOW',
        failureReason: 'subscription renewal failed',
        playbook: 'failed_subscription'
      }
    ];

    const result = evaluateBatch(batchInput, { isTestMode: true });
    expect(result.dataProvenance).toBe('SIMULATED_BATCH');
    expect(result.simulatedRecoveredRevenuePaise).toBe(0);
  });

  // Test 27: human approval cannot override BLOCK
  it('27. human approval cannot override BLOCK on cancelled subscription', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_sub_27_fail',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_27_block',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    await request(app).post('/api/events').send({
      eventId: 'evt_sub_27_cancel',
      eventType: 'subscription.cancelled',
      paymentId: 'sub_27_block',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    // Attempt human approval override
    const approveRes = await request(app).post('/api/cases/1/escalations/approve').send({
      approvedBy: 'ops_lead_01',
      notes: 'Attempting to override cancellation'
    });

    if (approveRes.status === 200) {
      const actionRes = await request(app).post('/api/cases/1/recovery-actions').send({
        action: 'SCHEDULE_RETRY_WINDOW'
      });
      expect(actionRes.status).toBe(422);
    } else {
      expect(approveRes.status).toBeGreaterThanOrEqual(400);
    }
  });

  // Test 28: stale approval fails final revalidation
  it('28. stale approval fails final revalidation when case becomes stale or cooled down', () => {
    const pastDate = new Date(Date.now() - 3600000);
    const detail = {
      recoveryCase: {
        id: 1,
        amount: 250000,
        currency: 'INR',
        riskStatus: 'RECOVERABLE',
        riskLevel: 'MEDIUM',
        paymentId: 'sub_28_stale',
        escalationStatus: 'APPROVED'
      },
      events: [{ eventType: 'subscription.renewal_failed', timestamp: pastDate.toISOString() }],
      existingActions: [
        { id: 1, status: 'EXECUTED', createdAt: new Date(Date.now() - 60000).toISOString() }
      ]
    };

    const policy = evaluatePolicy({
      recoveryCase: detail.recoveryCase,
      candidateAction: 'SCHEDULE_RETRY_WINDOW',
      events: detail.events,
      existingActions: detail.existingActions,
      cooldownMinutes: 60,
      allowSimulated: true
    });

    expect(policy.decision).toBe('REVIEW');
    expect(policy.reasons.some((r) => r.includes('Cooldown'))).toBe(true);
  });

  // Test 29: subscription-specific event provenance is preserved
  it('29. subscription-specific event provenance is preserved in rawPayload', async () => {
    const rawData = {
      subscriptionId: 'sub_prov_029',
      billingCycle: 'monthly',
      mandateStatus: 'ACTIVE',
      attemptNumber: 2
    };

    const res = await request(app).post('/api/events').send({
      eventId: 'evt_sub_29_prov',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_prov_029',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      rawPayload: rawData
    }).expect(201);

    expect(res.body.recoveryCase.paymentId).toBe('sub_prov_029');
    const storedEvents = await repository.getEventsForPayment('sub_prov_029');
    expect(storedEvents[0].rawPayload.billingCycle).toBe('monthly');
    expect(storedEvents[0].rawPayload.mandateStatus).toBe('ACTIVE');
  });

  // Test 30: V1 payment degradation behavior remains unchanged
  it('30. V1 payment degradation behavior remains completely unchanged', async () => {
    const failRes = await request(app).post('/api/events').send({
      eventId: 'evt_v1_regr_30',
      eventType: 'payment.failed',
      paymentId: 'pay_v1_regr_30',
      amount: 50000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    expect(failRes.body.recoveryCase.riskStatus).toBe('RECOVERABLE');
    expect(failRes.body.recoveryCase.riskLevel).toBe('MEDIUM');

    // Policy allows CREATE_PAYMENT_LINK
    const policyRes = await request(app).post('/api/cases/1/policy').send({
      action: 'CREATE_PAYMENT_LINK'
    }).expect(200);
    expect(policyRes.body.policy.decision).toBe('ALLOW');
  });
});
