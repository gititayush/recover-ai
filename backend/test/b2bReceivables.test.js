const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { playbookEngine } = require('../src/playbooks/playbookEngine');
const { processEvent } = require('../src/services/eventService');
const { createDiagnosisService } = require('../src/ai/diagnosisService');
const { evaluatePolicy } = require('../src/policy/policyEngine');
const { executeSimulatedAction } = require('../src/actions/simulatedActionExecutor');
const { reconcileOutcome } = require('../src/services/reconciliationService');
const { evaluateBatch } = require('../src/services/batchRecoveryService');
const { getOverallOutcomeAnalytics } = require('../src/services/outcomeAnalyticsService');

function mockRazorpayClient(overrides = {}) {
  return {
    isConfigured: true,
    isTestMode: true,
    keyId: 'rzp_test_mock_b2b',
    createPaymentLink: vi.fn().mockResolvedValue({
      id: 'plink_b2b_mock_001',
      short_url: 'https://rzp.io/i/b2b_mock_001',
      status: 'created',
      amount: 4500000,
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

describe('Revflow V2 — Milestone 6C: B2B Receivables & Unpaid Invoice Recovery', () => {
  let repository;
  let rzpClient;
  let app;

  beforeEach(() => {
    repository = new InMemoryRecoveryRepository();
    rzpClient = mockRazorpayClient();
    app = createApp(repository, { razorpayClient: rzpClient });
  });

  // Test 1: invoice.overdue selects b2b_receivables playbook
  it('1. invoice.overdue matches b2b_receivables playbook', () => {
    const event = {
      eventType: 'invoice.overdue',
      paymentId: 'inv_corp_001',
      amount: 5000000,
      currency: 'INR',
      daysOverdue: 15
    };
    const playbook = playbookEngine.identifyPlaybook(event);
    expect(playbook.id).toBe('b2b_receivables');
  });

  // Test 2: invoice.payment_failed matches b2b_receivables playbook
  it('2. invoice.payment_failed matches b2b_receivables playbook', () => {
    const event = {
      eventType: 'invoice.payment_failed',
      paymentId: 'inv_corp_002',
      amount: 1500000,
      currency: 'INR'
    };
    const playbook = playbookEngine.identifyPlaybook(event);
    expect(playbook.id).toBe('b2b_receivables');
  });

  // Test 3: paid invoice hard-stops recovery
  it('3. already-paid invoice hard-stops recovery', async () => {
    // 1. Overdue event
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_03_overdue',
      eventType: 'invoice.overdue',
      paymentId: 'inv_03_paid',
      amount: 2500000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 10
    }).expect(201);

    // 2. Invoice paid event arrives
    const paidRes = await request(app).post('/api/events').send({
      eventId: 'evt_inv_03_paid',
      eventType: 'invoice.paid',
      paymentId: 'inv_03_paid',
      amount: 2500000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    expect(paidRes.body.recoveryCase.riskStatus).toBe('RESOLVED');
    expect(paidRes.body.recoveryCase.outcome).toBe('PAID');

    // Policy recheck blocks further action
    const policyRes = await request(app).post('/api/cases/1/policy').send().expect(200);
    expect(policyRes.body.policy.decision).toBe('BLOCK');
  });

  // Test 4: cancelled invoice hard-stops recovery
  it('4. cancelled invoice is terminal and hard-stops recovery', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_04_fail',
      eventType: 'invoice.payment_failed',
      paymentId: 'inv_04_cancel',
      amount: 3000000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    // Cancel invoice
    const cancelRes = await request(app).post('/api/events').send({
      eventId: 'evt_inv_04_cancel',
      eventType: 'invoice.cancelled',
      paymentId: 'inv_04_cancel',
      amount: 3000000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    expect(cancelRes.body.recoveryCase.riskStatus).toBe('SUPPRESSED');
    expect(cancelRes.body.recoveryCase.outcome).toBe('CANCELLED');

    const policyRes = await request(app).post('/api/cases/1/policy').send().expect(200);
    expect(policyRes.body.policy.decision).toBe('BLOCK');
  });

  // Test 5: disputed invoice hard-stops recovery
  it('5. disputed invoice hard-stops automated recovery interventions', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_05_due',
      eventType: 'invoice.overdue',
      paymentId: 'inv_05_dispute',
      amount: 1200000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 20
    }).expect(201);

    // Ingest dispute
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_05_disputed',
      eventType: 'invoice.disputed',
      paymentId: 'inv_05_dispute',
      amount: 1200000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      rawPayload: { disputed: true, disputeReason: 'incorrect item quantity' }
    }).expect(201);

    const policyRes = await request(app).post('/api/cases/1/policy').send().expect(200);
    expect(policyRes.body.policy.decision).toBe('BLOCK');
    expect(policyRes.body.policy.reasons.some((r) => r.includes('dispute'))).toBe(true);
  });

  // Test 6: invoice before due date waits (B2B_TERMS_NOT_REACHED)
  it('6. invoice before due date follows WAIT semantics', async () => {
    const futureDueDate = new Date(Date.now() + 15 * 86400000).toISOString();

    const createdRes = await request(app).post('/api/events').send({
      eventId: 'evt_inv_06_created',
      eventType: 'invoice.created',
      paymentId: 'inv_06_terms',
      amount: 1500000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      dueDate: futureDueDate,
      daysOverdue: 0,
      rawPayload: { dueDate: futureDueDate, daysOverdue: 0, paymentTerms: 'NET_30' }
    }).expect(201);

    // Informational non-actionable event does not create a recoverable case
    expect(createdRes.body.recoveryCase).toBeNull();
  });

  // Test 7: expired collection window (> 180 days) escalates to human review
  it('7. expired collection window (> 180 days) escalates to human review', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_07_aged',
      eventType: 'invoice.overdue',
      paymentId: 'inv_07_aged',
      amount: 800000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 195,
      rawPayload: { daysOverdue: 195, invoiceStatus: 'DOUBTFUL_DEBT' }
    }).expect(201);

    const policyRes = await request(app).post('/api/cases/1/policy').send().expect(200);
    expect(policyRes.body.policy.decision).toBe('REVIEW');
    expect(policyRes.body.policy.reasons.some((r) => r.includes('180 days') || r.includes('window'))).toBe(true);
  });

  // Test 8: missing optional fields remain unknown and un-hallucinated
  it('8. missing optional fields remain unknown and un-hallucinated', () => {
    const event = {
      eventId: 'evt_inv_08_min',
      eventType: 'invoice.overdue',
      paymentId: 'inv_08_sparse',
      amount: 1000000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    };

    const playbook = playbookEngine.identifyPlaybook(event);
    const context = playbook.extractContext(event, { recoveryCase: { paymentId: 'inv_08_sparse', amount: 1000000, currency: 'INR' } });

    expect(context.issueDate).toBeNull();
    expect(context.dueDate).toBeNull();
    expect(context.paymentTerms).toBeNull();
    expect(context.lastPaymentAttempt).toBeNull();
    expect(context.daysOverdue).toBe(0);
    expect(context.disputeStatus).toBe('NONE');
    expect(context.customerIncome).toBeUndefined();
    expect(context.companyFinancialHealth).toBeUndefined();
  });

  // Test 9: malformed B2B input rejected safely with 400 Bad Request
  it('9. malformed B2B input rejected safely with 400 Bad Request', async () => {
    // Missing paymentId
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_09_bad',
      eventType: 'invoice.overdue',
      amount: 500000,
      currency: 'INR'
    }).expect(400);

    // Negative amount
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_09_neg',
      eventType: 'invoice.overdue',
      paymentId: 'inv_09_neg',
      amount: -5000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(400);
  });

  // Test 10: amount integrity preserved in paise
  it('10. amount integrity preserved in paise throughout B2B case lifecycle', async () => {
    const exactPaise = 18500000; // ₹1,85,000.00
    const res = await request(app).post('/api/events').send({
      eventId: 'evt_inv_10_amt',
      eventType: 'invoice.overdue',
      paymentId: 'inv_10_amt',
      amount: exactPaise,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 14
    }).expect(201);

    expect(res.body.recoveryCase.amount).toBe(exactPaise);
    const detail = await repository.getCaseDetail(1);
    expect(detail.recoveryCase.amount).toBe(exactPaise);
  });

  // Test 11: currency integrity (rejects non-INR)
  it('11. currency integrity preserved (rejects non-INR invoices from recovery)', async () => {
    const res = await request(app).post('/api/events').send({
      eventId: 'evt_inv_11_curr',
      eventType: 'invoice.overdue',
      paymentId: 'inv_11_curr',
      amount: 500000,
      currency: 'EUR',
      timestamp: new Date().toISOString(),
      daysOverdue: 10
    }).expect(201);

    expect(res.body.recoveryCase).toBeNull();
  });

  // Test 12: high-value escalation (> ₹25,000 / 2,500,000 paise)
  it('12. high-value B2B invoice escalates for human approval (> ₹25,000)', async () => {
    const highValuePaise = 5000000; // ₹50,000
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_12_hv',
      eventType: 'invoice.overdue',
      paymentId: 'inv_12_hv',
      amount: highValuePaise,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 12
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

  // Test 13: low-confidence AI proposal escalates
  it('13. low-confidence B2B proposal escalates to manual review', async () => {
    const customAi = mockAiProvider({
      diagnosis: {
        category: 'B2B_APPROVAL_DELAY',
        cause: 'Uncertain corporate delay reason',
        confidence: 0.35,
        evidence: [{ field: 'case.amount', value: '1500000' }]
      },
      recommendation: { action: 'INVOICE_REMINDER' }
    });
    const customApp = createApp(repository, {
      diagnosisService: createDiagnosisService({ provider: customAi }),
      razorpayClient: rzpClient
    });

    await request(customApp).post('/api/events').send({
      eventId: 'evt_inv_13_lc',
      eventType: 'invoice.overdue',
      paymentId: 'inv_13_lc',
      amount: 1500000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 5
    }).expect(201);

    const policyRes = await request(customApp).post('/api/cases/1/policy').send().expect(200);
    expect(policyRes.body.policy.decision).toBe('REVIEW');
    expect(policyRes.body.policy.reasons.some((r) => r.includes('confidence'))).toBe(true);
  });

  // Test 14: simulated invoice reminder does not call Razorpay
  it('14. simulated INVOICE_REMINDER does not call Razorpay API', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_14_rem',
      eventType: 'invoice.overdue',
      paymentId: 'inv_14_rem',
      amount: 1800000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 10
    }).expect(201);

    const actionRes = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'INVOICE_REMINDER'
    }).expect(201);

    expect(actionRes.body.action.status).toBe('EXECUTED');
    expect(actionRes.body.action.provider).toBe('simulated');
    expect(actionRes.body.action.actionType).toBe('INVOICE_REMINDER');
    expect(rzpClient.createPaymentLink).not.toHaveBeenCalled();
  });

  // Test 15: simulated outreach does not call Razorpay
  it('15. simulated CUSTOMER_OUTREACH does not call Razorpay API', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_15_out',
      eventType: 'invoice.overdue',
      paymentId: 'inv_15_out',
      amount: 1200000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 15
    }).expect(201);

    const actionRes = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'CUSTOMER_OUTREACH'
    }).expect(201);

    expect(actionRes.body.action.status).toBe('EXECUTED');
    expect(actionRes.body.action.provider).toBe('simulated');
    expect(rzpClient.createPaymentLink).not.toHaveBeenCalled();
  });

  // Test 16: simulated reminder does not increase recovered revenue
  it('16. simulated reminder does not increase verified recovered revenue', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_16_rev',
      eventType: 'invoice.overdue',
      paymentId: 'inv_16_rev',
      amount: 2000000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 8
    }).expect(201);

    await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'INVOICE_REMINDER'
    }).expect(201);

    const detail = await repository.getCaseDetail(1);
    expect(Number(detail.recoveryCase.recoveredAmount)).toBe(0);

    const analytics = await getOverallOutcomeAnalytics(repository);
    expect(analytics.portfolioFunnel.funnel.recoveredRevenuePaise).toBe(0);
    expect(analytics.portfolioFunnel.funnel.verified).toBe(0);
  });

  // Test 17: CREATE_PAYMENT_LINK uses existing bounded executor and calls Razorpay test mode
  it('17. CREATE_PAYMENT_LINK uses existing bounded executor and calls Razorpay test mode', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_17_link',
      eventType: 'invoice.overdue',
      paymentId: 'inv_17_link',
      amount: 1500000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 10
    }).expect(201);

    const actionRes = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'CREATE_PAYMENT_LINK'
    }).expect(201);

    expect(actionRes.body.action.status).toBe('EXECUTED');
    expect(actionRes.body.action.provider).toBe('razorpay');
    expect(rzpClient.createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({
      amount: 1500000,
      currency: 'INR'
    }));
  });

  // Test 18: Payment Link outcome reconciles through existing service
  it('18. B2B Payment Link outcome reconciles through existing reconciliation service', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_18_rec',
      eventType: 'invoice.overdue',
      paymentId: 'inv_18_rec',
      amount: 1500000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 5
    }).expect(201);

    const actionRes = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'CREATE_PAYMENT_LINK'
    }).expect(201);
    const paymentLinkId = actionRes.body.action.providerActionId;

    const paidWebhook = {
      eventId: 'evt_wh_b2b_paid_18',
      eventType: 'payment_link.paid',
      paymentId: 'pay_rzp_b2b_real_777',
      paymentLinkId,
      referenceId: actionRes.body.action.idempotencyKey,
      amount: 1500000,
      amountPaid: 1500000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      rawPayload: { event: 'payment_link.paid' }
    };

    const reconciliation = await reconcileOutcome(repository, paidWebhook);
    expect(reconciliation.reconciled).toBe(true);
    expect(reconciliation.outcome.outcome).toBe('PAID');
    expect(reconciliation.outcome.amountPaid).toBe(1500000);

    const finalDetail = await repository.getCaseDetail(1);
    expect(finalDetail.recoveryCase.riskStatus).toBe('RESOLVED');
    expect(Number(finalDetail.recoveryCase.recoveredAmount)).toBe(1500000);
  });

  // Test 19: duplicate invoice events are idempotent
  it('19. duplicate invoice events are idempotent', async () => {
    const eventPayload = {
      eventId: 'evt_inv_19_dup',
      eventType: 'invoice.overdue',
      paymentId: 'inv_19_dup',
      amount: 1000000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 14
    };

    const first = await request(app).post('/api/events').send(eventPayload).expect(201);
    expect(first.body.duplicate).toBe(false);

    const second = await request(app).post('/api/events').send(eventPayload).expect(200);
    expect(second.body.duplicate).toBe(true);
  });

  // Test 20: duplicate recovery action prevented
  it('20. duplicate recovery action prevented idempotently', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_20_act',
      eventType: 'invoice.overdue',
      paymentId: 'inv_20_act',
      amount: 1000000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 10
    }).expect(201);

    const first = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'INVOICE_REMINDER'
    }).expect(201);
    expect(first.body.executed).toBe(true);

    const second = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'INVOICE_REMINDER'
    }).expect(200);
    expect(second.body.duplicate).toBe(true);
  });

  // Test 21: audit logging preserves domain stopping reasons
  it('21. audit logging preserves domain stopping reasons', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_21_aud',
      eventType: 'invoice.overdue',
      paymentId: 'inv_21_aud',
      amount: 1500000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 12
    }).expect(201);

    await request(app).post('/api/events').send({
      eventId: 'evt_inv_21_cancel',
      eventType: 'invoice.cancelled',
      paymentId: 'inv_21_aud',
      amount: 1500000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    const audits = await repository.getAllAudits ? await repository.getAllAudits() : repository.audits;
    const terminalAudit = audits.find((a) => a.eventType === 'CASE_UPDATED' && a.metadata?.outcome === 'CANCELLED');
    expect(terminalAudit).toBeDefined();
  });

  // Test 22: batch simulation supports B2B scenarios and selects INVOICE_REMINDER
  it('22. batch simulation supports B2B scenarios and selects INVOICE_REMINDER', () => {
    const batchInput = [
      {
        caseId: 301,
        paymentId: 'inv_batch_301',
        amount: 2500000,
        currency: 'INR',
        riskLevel: 'MEDIUM',
        failureReason: 'Commercial invoice overdue by 30 days',
        playbook: 'b2b_receivables'
      }
    ];

    const result = evaluateBatch(batchInput, { isTestMode: true });
    expect(result.totalCases).toBe(1);
    expect(result.itemEvaluations[0].strategy).toBe('INVOICE_REMINDER');
    expect(result.itemEvaluations[0].executionMode).toBe('SIMULATED');
  });

  // Test 23: synthetic metrics remain SIMULATED_BATCH
  it('23. synthetic metrics remain SIMULATED_BATCH and do not inflate verified revenue', () => {
    const batchInput = [
      {
        caseId: 401,
        paymentId: 'inv_batch_401',
        amount: 5000000,
        currency: 'INR',
        riskLevel: 'HIGH',
        failureReason: 'B2B invoice overdue',
        playbook: 'b2b_receivables'
      }
    ];

    const result = evaluateBatch(batchInput, { isTestMode: true });
    expect(result.dataProvenance).toBe('SIMULATED_BATCH');
    expect(result.simulatedRecoveredRevenuePaise).toBe(0);
  });

  // Test 24: human approval cannot override BLOCK on disputed invoice
  it('24. human approval cannot override BLOCK on disputed invoice', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_24_dis',
      eventType: 'invoice.overdue',
      paymentId: 'inv_24_dis',
      amount: 1500000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 14
    }).expect(201);

    await request(app).post('/api/events').send({
      eventId: 'evt_inv_24_dispute',
      eventType: 'invoice.disputed',
      paymentId: 'inv_24_dis',
      amount: 1500000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      rawPayload: { disputed: true }
    }).expect(201);

    // Attempt human approval override
    const approveRes = await request(app).post('/api/cases/1/escalations/approve').send({
      approvedBy: 'b2b_ar_lead',
      notes: 'Attempting to override dispute block'
    });

    if (approveRes.status === 200) {
      const actionRes = await request(app).post('/api/cases/1/recovery-actions').send({
        action: 'INVOICE_REMINDER'
      });
      expect(actionRes.status).toBe(422);
    } else {
      expect(approveRes.status).toBeGreaterThanOrEqual(400);
    }
  });

  // Test 25: stale approval fails final revalidation
  it('25. stale approval fails final revalidation when case becomes cooled down', () => {
    const pastDate = new Date(Date.now() - 3600000);
    const detail = {
      recoveryCase: {
        id: 1,
        amount: 1500000,
        currency: 'INR',
        riskStatus: 'RECOVERABLE',
        riskLevel: 'MEDIUM',
        paymentId: 'inv_25_stale',
        escalationStatus: 'APPROVED'
      },
      events: [{ eventType: 'invoice.overdue', timestamp: pastDate.toISOString() }],
      existingActions: [
        { id: 1, status: 'EXECUTED', createdAt: new Date(Date.now() - 60000).toISOString() }
      ]
    };

    const policy = evaluatePolicy({
      recoveryCase: detail.recoveryCase,
      candidateAction: 'INVOICE_REMINDER',
      events: detail.events,
      existingActions: detail.existingActions,
      cooldownMinutes: 60,
      allowSimulated: true
    });

    expect(policy.decision).toBe('REVIEW');
    const cooldownRule = policy.rulesEvaluated.find((r) => r.rule === 'cooldown_period');
    expect(cooldownRule.status).toBe('REVIEW');
    expect(cooldownRule.message).toContain('Cooldown period');
  });

  // Test 26: analytics track B2B strategies correctly
  it('26. analytics track B2B strategies correctly without inflating revenue', async () => {
    await request(app).post('/api/events').send({
      eventId: 'evt_inv_26_an',
      eventType: 'invoice.overdue',
      paymentId: 'inv_26_an',
      amount: 1800000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      daysOverdue: 10
    }).expect(201);

    await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'INVOICE_REMINDER'
    }).expect(201);

    const analytics = await getOverallOutcomeAnalytics(repository);
    expect(analytics.strategyPerformance.INVOICE_REMINDER.executed).toBe(1);
    expect(analytics.strategyPerformance.INVOICE_REMINDER.verifiedRecoveries).toBe(0);
    expect(analytics.strategyPerformance.INVOICE_REMINDER.recoveredAmountPaise).toBe(0);
  });

  // Test 27: V1 payment degradation behavior remains completely unchanged
  it('27. V1 payment degradation behavior remains completely unchanged', async () => {
    const failRes = await request(app).post('/api/events').send({
      eventId: 'evt_v1_b2b_regr',
      eventType: 'payment.failed',
      paymentId: 'pay_v1_b2b_regr',
      amount: 50000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    expect(failRes.body.recoveryCase.riskStatus).toBe('RECOVERABLE');
    expect(failRes.body.recoveryCase.riskLevel).toBe('MEDIUM');

    const policyRes = await request(app).post('/api/cases/1/policy').send({
      action: 'CREATE_PAYMENT_LINK'
    }).expect(200);
    expect(policyRes.body.policy.decision).toBe('ALLOW');
  });

  // Test 28: 6A checkout drop-off behavior remains completely unchanged
  it('28. 6A checkout drop-off behavior remains completely unchanged', async () => {
    const chkRes = await request(app).post('/api/events').send({
      eventId: 'evt_chk_b2b_regr',
      eventType: 'checkout.abandoned',
      paymentId: 'chk_sess_b2b_regr',
      amount: 250000,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    expect(chkRes.body.recoveryCase.riskStatus).toBe('RECOVERABLE');
    const actRes = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'CHECKOUT_RECOVERY'
    }).expect(201);
    expect(actRes.body.action.actionType).toBe('CHECKOUT_RECOVERY');
    expect(actRes.body.action.provider).toBe('simulated');
  });

  // Test 29: 6B subscription recovery behavior remains completely unchanged
  it('29. 6B subscription recovery behavior remains completely unchanged', async () => {
    const subRes = await request(app).post('/api/events').send({
      eventId: 'evt_sub_b2b_regr',
      eventType: 'subscription.renewal_failed',
      paymentId: 'sub_b2b_regr',
      amount: 199900,
      currency: 'INR',
      timestamp: new Date().toISOString()
    }).expect(201);

    expect(subRes.body.recoveryCase.riskStatus).toBe('RECOVERABLE');
    const actRes = await request(app).post('/api/cases/1/recovery-actions').send({
      action: 'SCHEDULE_RETRY_WINDOW'
    }).expect(201);
    expect(actRes.body.action.actionType).toBe('SCHEDULE_RETRY_WINDOW');
    expect(actRes.body.action.provider).toBe('simulated');
  });

  // Test 30: B2B invoice event provenance is preserved in rawPayload
  it('30. B2B invoice event provenance is preserved in rawPayload', async () => {
    const rawData = {
      invoiceId: 'inv_prov_030',
      paymentTerms: 'NET_60',
      daysOverdue: 25,
      issueDate: '2026-08-01T00:00:00.000Z',
      dueDate: '2026-08-31T00:00:00.000Z'
    };

    const res = await request(app).post('/api/events').send({
      eventId: 'evt_inv_30_prov',
      eventType: 'invoice.overdue',
      paymentId: 'inv_prov_030',
      amount: 3500000,
      currency: 'INR',
      timestamp: new Date().toISOString(),
      rawPayload: rawData
    }).expect(201);

    expect(res.body.recoveryCase.paymentId).toBe('inv_prov_030');
    const storedEvents = await repository.getEventsForPayment('inv_prov_030');
    expect(storedEvents[0].rawPayload.paymentTerms).toBe('NET_60');
    expect(storedEvents[0].rawPayload.daysOverdue).toBe(25);
  });
});
