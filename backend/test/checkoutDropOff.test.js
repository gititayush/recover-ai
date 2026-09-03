const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { processEvent } = require('../src/services/eventService');
const { createDiagnosisService } = require('../src/ai/diagnosisService');
const { evaluatePolicy } = require('../src/policy/policyEngine');
const { executePaymentLink } = require('../src/actions/paymentLinkExecutor');
const { executeSimulatedAction } = require('../src/actions/simulatedActionExecutor');
const { reconcileOutcome } = require('../src/services/reconciliationService');
const { getOverallOutcomeAnalytics } = require('../src/services/outcomeAnalyticsService');

function mockRazorpayClient(overrides = {}) {
  return {
    isConfigured: true,
    isTestMode: true,
    keyId: 'rzp_test_mock123',
    createPaymentLink: vi.fn().mockResolvedValue({
      id: 'plink_chk_mock_001',
      short_url: 'https://rzp.io/i/chk_mock_001',
      status: 'created',
      amount: 450000,
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

describe('Revflow V2 — Milestone 6A: Checkout Drop-Off Recovery', () => {
  let repository;
  let rzpClient;
  let app;

  beforeEach(() => {
    repository = new InMemoryRecoveryRepository();
    rzpClient = mockRazorpayClient();
    app = createApp(repository, { razorpayClient: rzpClient });
  });

  // Test 9: Valid checkout drop-off recognized
  it('9. valid checkout drop-off recognized and creates a recoverable case', async () => {
    const event = {
      eventId: 'evt_chk_valid_01',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_sess_valid_01',
      amount: 350000,
      currency: 'INR',
      customerReference: 'cart_cust_01',
      failureReason: 'abandoned at UPI payment screen',
      timestamp: new Date().toISOString(),
      rawPayload: {
        checkoutSessionId: 'chk_sess_valid_01',
        cartReference: 'cart_cust_01',
        checkoutStage: 'PAYMENT_STEP',
        abandonmentReason: 'abandoned at UPI payment screen'
      }
    };

    const res = await request(app).post('/api/events').send(event).expect(201);
    expect(res.body.accepted).toBe(true);
    expect(res.body.recoveryCase).toBeDefined();
    expect(res.body.recoveryCase.paymentId).toBe('chk_sess_valid_01');
    expect(res.body.recoveryCase.amount).toBe(350000);
    expect(res.body.recoveryCase.riskStatus).toBe('RECOVERABLE');
    expect(res.body.recoveryCase.riskReason).toContain('Checkout drop-off');
  });

  // Test 10: Incomplete checkout remains ineligible
  it('10. incomplete checkout remains ineligible before reaching payment step', async () => {
    const event = {
      eventId: 'evt_chk_early_01',
      eventType: 'checkout.started',
      paymentId: 'chk_sess_early_01',
      amount: 150000,
      currency: 'INR',
      customerReference: 'cart_cust_early',
      timestamp: new Date().toISOString(),
      rawPayload: {
        checkoutSessionId: 'chk_sess_early_01',
        checkoutStage: 'CART_VIEWED'
      }
    };

    const res = await request(app).post('/api/events').send(event).expect(201);
    expect(res.body.accepted).toBe(true);
    // Case is not created or marked recoverable because checkout has not reached payment stage
    expect(res.body.recoveryCase).toBeNull();
  });

  // Test 11: Completed checkout cannot be recovered
  it('11. completed checkout cannot be recovered (terminal paid state stops recovery)', async () => {
    // 1. Initial checkout drop-off
    await request(app).post('/api/events').send({
      eventId: 'evt_chk_drop_11',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_sess_11',
      amount: 200000,
      currency: 'INR',
      timestamp: new Date(Date.now() - 60000).toISOString()
    }).expect(201);

    // 2. Checkout completed event arrives
    const completionRes = await request(app).post('/api/events').send({
      eventId: 'evt_chk_done_11',
      eventType: 'checkout.completed',
      paymentId: 'chk_sess_11',
      amount: 200000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    expect(completionRes.body.recoveryCase.riskStatus).toBe('RESOLVED');
    expect(completionRes.body.recoveryCase.outcome).toBe('PAID');

    // 3. Any subsequent policy evaluation stops execution
    const policyRes = await request(app).post(`/api/cases/${completionRes.body.recoveryCase.id}/policy`).expect(200);
    expect(policyRes.body.policy.decision).toBe('BLOCK');
    expect(policyRes.body.policy.stopping.stopped).toBe(true);
  });

  // Test 12: Paid order cannot be recovered
  it('12. paid order cannot be recovered', async () => {
    // Create drop-off case
    const dropOffRes = await request(app).post('/api/events').send({
      eventId: 'evt_chk_drop_12',
      eventType: 'checkout.abandoned',
      paymentId: 'chk_sess_12',
      orderId: 'order_12',
      amount: 500000,
      currency: 'INR',
      timestamp: new Date(Date.now() - 30000).toISOString()
    }).expect(201);

    // Order paid event arrives
    await request(app).post('/api/events').send({
      eventId: 'evt_order_paid_12',
      eventType: 'order.paid',
      paymentId: 'chk_sess_12',
      orderId: 'order_12',
      amount: 500000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const caseDetail = await repository.getCaseDetail(dropOffRes.body.recoveryCase.id);
    expect(caseDetail.recoveryCase.riskStatus).toBe('RESOLVED');

    const policy = evaluatePolicy({
      recoveryCase: caseDetail.recoveryCase,
      events: caseDetail.events,
      candidateAction: 'CREATE_PAYMENT_LINK',
      isTestMode: true
    });
    expect(policy.decision).toBe('BLOCK');
    expect(policy.stopping.stopped).toBe(true);
  });

  // Test 13: Stale checkout stops (> 24 hours)
  it('13. stale checkout stops (> 24 hours since activity)', async () => {
    const staleTime = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const event = {
      eventId: 'evt_chk_stale_13',
      eventType: 'checkout.abandoned',
      paymentId: 'chk_sess_stale_13',
      amount: 250000,
      currency: 'INR',
      timestamp: staleTime
    };

    const res = await request(app).post('/api/events').send(event).expect(201);
    // Stale checkout should not be actionable
    expect(res.body.recoveryCase).toBeNull();
  });

  // Test 14: Duplicate checkout does not create duplicate recovery
  it('14. duplicate checkout event does not create duplicate recovery case', async () => {
    const event = {
      eventId: 'evt_chk_dup_14',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_sess_dup_14',
      amount: 300000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    };

    const res1 = await request(app).post('/api/events').send(event).expect(201);
    expect(res1.body.duplicate).toBe(false);

    // Resend exact same event
    const res2 = await request(app).post('/api/events').send(event).expect(200);
    expect(res2.body.duplicate).toBe(true);

    const cases = await repository.listCases();
    const matches = cases.filter((c) => c.paymentId === 'chk_sess_dup_14');
    expect(matches.length).toBe(1);
  });

  // Test 15: Missing optional fields remain unknown
  it('15. missing optional fields remain unknown and are never hallucinated', async () => {
    const event = {
      eventId: 'evt_chk_min_15',
      eventType: 'checkout.abandoned',
      paymentId: 'chk_sess_min_15',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    };

    const res = await request(app).post('/api/events').send(event).expect(201);
    expect(res.body.recoveryCase.customerReference).toBeNull();
    expect(res.body.recoveryCase.orderId).toBeNull();
  });

  // Test 16: Malformed checkout payload rejected safely
  it('16. malformed checkout payload rejected safely with 400 Bad Request', async () => {
    // Missing required paymentId
    await request(app).post('/api/events').send({
      eventId: 'evt_malformed_01',
      eventType: 'checkout.abandoned',
      amount: 100000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(400);

    // Negative amount
    await request(app).post('/api/events').send({
      eventId: 'evt_malformed_02',
      eventType: 'checkout.abandoned',
      paymentId: 'chk_malformed_02',
      amount: -500,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(400);
  });

  // Test 17: Amount integrity preserved
  it('17. amount integrity preserved across detection and case storage in paise', async () => {
    const event = {
      eventId: 'evt_chk_amt_17',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_sess_amt_17',
      amount: 874500, // ₹8,745.00
      currency: 'INR',
      timestamp: new Date().toISOString()
    };

    const res = await request(app).post('/api/events').send(event).expect(201);
    expect(res.body.recoveryCase.amount).toBe(874500);
    expect(Number.isSafeInteger(res.body.recoveryCase.amount)).toBe(true);
  });

  // Test 18: Currency integrity preserved
  it('18. currency integrity preserved (rejects non-INR currencies)', async () => {
    const nonInrEvent = {
      eventId: 'evt_chk_usd_18',
      eventType: 'checkout.abandoned',
      paymentId: 'chk_sess_usd_18',
      amount: 10000,
      currency: 'USD',
      timestamp: new Date().toISOString()
    };

    // Policy and risk assessment reject non-INR
    const res = await processEvent(repository, nonInrEvent);
    expect(res.recoveryCase).toBeNull();
  });

  // Test 19: High-value checkout escalates
  it('19. high-value checkout escalates for human approval (> ₹25,000 / 2,500,000 paise)', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_chk_high_19',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_sess_high_19',
      amount: 3000000, // ₹30,000 > ₹25,000 threshold
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const policyRes = await request(app).post('/api/cases/1/policy').expect(200);
    expect(policyRes.body.policy.decision).toBe('REVIEW');
    expect(policyRes.body.policy.rulesEvaluated.some((r) => r.rule === 'high_value_escalation' && r.status === 'REVIEW')).toBe(true);

    // Direct execution is blocked before escalation approval
    await request(app).post('/api/cases/1/recovery-actions').expect(422);
  });

  // Test 20: Low-confidence diagnosis escalates
  it('20. low-confidence diagnosis escalates to manual review', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_chk_low_20',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_sess_low_20',
      amount: 450000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const lowConfidenceProposal = {
      diagnosis: {
        category: 'CHECKOUT_DROPOFF',
        cause: 'Checkout drop-off: Checkout drop-off after payment step reached',
        confidence: 0.40, // Below 0.65 threshold
        evidence: [{ field: 'case.amount', value: '450000' }]
      },
      recommendation: {
        action: 'CREATE_PAYMENT_LINK'
      }
    };

    const diagService = createDiagnosisService({
      provider: mockAiProvider(lowConfidenceProposal),
      confidenceThreshold: 0.65
    });

    const testApp = createApp(repository, { diagnosisService: diagService, razorpayClient: rzpClient });
    const diagRes = await request(testApp).post('/api/cases/1/diagnosis').expect(201);
    expect(diagRes.body.diagnosis.recommendation.action).toBe('REQUEST_MANUAL_REVIEW');
    expect(diagRes.body.diagnosis.recommendation.reason).toContain('threshold');
  });

  // Test 21: Simulated CHECKOUT_RECOVERY never calls Razorpay
  it('21. simulated CHECKOUT_RECOVERY never calls Razorpay API', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_chk_sim_21',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_sess_sim_21',
      amount: 450000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const res = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'CHECKOUT_RECOVERY'
    }).expect(201);

    expect(res.body.executed).toBe(true);
    expect(res.body.isSimulated).toBe(true);
    expect(res.body.action.status).toBe('EXECUTED');
    expect(res.body.action.actionType).toBe('CHECKOUT_RECOVERY');
    expect(res.body.action.provider).toBe('simulated');
    expect(res.body.action.responseMetadata.externalApiCalled).toBe(false);

    // Razorpay mock was NEVER invoked
    expect(rzpClient.createPaymentLink).not.toHaveBeenCalled();
  });

  // Test 22: CREATE_PAYMENT_LINK uses existing bounded executor
  it('22. CREATE_PAYMENT_LINK uses existing bounded executor and calls Razorpay test mode', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_chk_plink_22',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_sess_plink_22',
      amount: 450000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const res = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'CREATE_PAYMENT_LINK'
    }).expect(201);

    expect(res.body.executed).toBe(true);
    expect(res.body.action.actionType).toBe('CREATE_PAYMENT_LINK');
    expect(res.body.action.status).toBe('EXECUTED');
    expect(res.body.action.providerActionId).toBe('plink_chk_mock_001');
    expect(rzpClient.createPaymentLink).toHaveBeenCalledTimes(1);
  });

  // Test 23: Simulated action does not increase recovered revenue
  it('23. simulated action execution does not increase recovered revenue', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_chk_rev_23',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_sess_rev_23',
      amount: 500000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'CHECKOUT_RECOVERY'
    }).expect(201);

    // Check case recovered_amount
    const detail = await repository.getCaseDetail(1);
    expect(Number(detail.recoveryCase.recoveredAmount)).toBe(0);

    // Check overall analytics
    const analytics = await getOverallOutcomeAnalytics(repository);
    expect(analytics.portfolioFunnel.funnel.recoveredRevenuePaise).toBe(0);
    expect(analytics.portfolioFunnel.funnel.verified).toBe(0);
  });

  // Test 24: Provider-paid Payment Link reconciles through existing mechanism
  it('24. provider-paid Payment Link reconciles through existing reconciliation service', async () => {
    // 1. Create drop-off case
    await request(app).post('/api/events').send({
      eventId: 'evt_chk_rec_24',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_sess_rec_24',
      amount: 450000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    // 2. Execute Payment Link
    const actionRes = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'CREATE_PAYMENT_LINK'
    }).expect(201);
    const paymentLinkId = actionRes.body.action.providerActionId;

    // 3. Webhook arrives for paid payment link
    const paidWebhook = {
      eventId: 'evt_wh_paid_24',
      eventType: 'payment_link.paid',
      paymentId: 'pay_rzp_real_999',
      paymentLinkId,
      referenceId: actionRes.body.action.idempotencyKey,
      amount: 450000,
      amountPaid: 450000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      rawPayload: {
        event: 'payment_link.paid',
        payload: {
          payment_link: {
            entity: {
              id: paymentLinkId,
              amount: 450000,
              currency: 'INR',
              reference_id: actionRes.body.action.idempotencyKey,
              status: 'paid'
            }
          },
          payment: {
            entity: {
              id: 'pay_rzp_real_999',
              amount: 450000,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      }
    };

    const reconciliation = await reconcileOutcome(repository, paidWebhook);
    expect(reconciliation.reconciled).toBe(true);
    expect(reconciliation.outcome.outcome).toBe('PAID');
    expect(reconciliation.outcome.amountPaid).toBe(450000);

    // Case is resolved with recovered revenue
    const finalDetail = await repository.getCaseDetail(1);
    expect(finalDetail.recoveryCase.riskStatus).toBe('RESOLVED');
    expect(Number(finalDetail.recoveryCase.recoveredAmount)).toBe(450000);
  });

  // Test 25: Repeated checkout events are idempotent
  it('25. repeated checkout events for same session update existing case idempotently', async () => {
    // First event: checkout started
    await request(app).post('/api/events').send({
      eventId: 'evt_seq_01',
      eventType: 'checkout.started',
      paymentId: 'chk_sess_seq_25',
      amount: 350000,
      currency: 'INR',
      timestamp: new Date(Date.now() - 120000).toISOString(),
      rawPayload: { checkoutStage: 'CART' }
    }).expect(201);

    // Second event: payment step reached
    const res2 = await request(app).post('/api/events').send({
      eventId: 'evt_seq_02',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_sess_seq_25',
      amount: 350000,
      currency: 'INR',
      timestamp: new Date(Date.now() - 60000).toISOString(),
      rawPayload: { checkoutStage: 'PAYMENT_STEP' }
    }).expect(201);

    expect(res2.body.recoveryCase.id).toBe(1);

    // Third event: checkout abandoned
    const res3 = await request(app).post('/api/events').send({
      eventId: 'evt_seq_03',
      eventType: 'checkout.abandoned',
      paymentId: 'chk_sess_seq_25',
      amount: 350000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      rawPayload: { checkoutStage: 'ABANDONED', abandonmentReason: 'user closed browser tab' }
    }).expect(201);

    // Same case updated, no duplicate created
    expect(res3.body.recoveryCase.id).toBe(1);
    const cases = await repository.listCases();
    expect(cases.length).toBe(1);
  });

  // Test 26: Existing payment.failed behavior remains unchanged
  it('26. existing payment.failed V1 behavior remains completely unchanged', async () => {
    const v1Event = {
      eventId: 'evt_v1_fail_26',
      eventType: 'payment.failed',
      paymentId: 'pay_v1_legacy_001',
      orderId: 'order_v1_001',
      amount: 499900,
      currency: 'INR',
      failureReason: 'gateway_timeout',
      timestamp: new Date().toISOString()
    };

    const res = await request(app).post('/api/events').send(v1Event).expect(201);
    expect(res.body.accepted).toBe(true);
    expect(res.body.recoveryCase).toBeDefined();
    expect(res.body.recoveryCase.paymentId).toBe('pay_v1_legacy_001');
    expect(res.body.recoveryCase.riskStatus).toBe('RECOVERABLE');

    // Diagnosis
    const diagRes = await request(app).post('/api/cases/1/diagnosis').expect(201);
    expect(diagRes.body.diagnosis).toBeDefined();

    // Policy
    const policyRes = await request(app).post('/api/cases/1/policy').expect(200);
    expect(policyRes.body.policy.decision).toBe('ALLOW');

    // Execution
    const execRes = await request(app).post('/api/cases/1/recovery-actions').expect(201);
    expect(execRes.body.executed).toBe(true);
    expect(execRes.body.action.actionType).toBe('CREATE_PAYMENT_LINK');
  });
});
