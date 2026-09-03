/**
 * Revflow V2 — Outcome Analytics Tests
 *
 * Verifies strategy intelligence, recovery velocity, portfolio funnels,
 * failure breakdowns, agent evaluation telemetry, and data provenance isolation.
 */

const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const {
  getOverallOutcomeAnalytics,
  computeStrategyPerformance,
  computeRecoveryVelocity,
  computeFailureAnalytics,
  computePortfolioFunnel,
  formatCurrency,
  formatDuration
} = require('../src/services/outcomeAnalyticsService');
const { reconcileOutcome } = require('../src/services/reconciliationService');

describe('Revflow V2 — Outcome Analytics Service', () => {
  const t0 = '2026-09-03T10:00:00.000Z'; // First detected
  const t1 = '2026-09-03T10:02:00.000Z'; // Action executed (2m later)
  const t2 = '2026-09-03T10:05:00.000Z'; // Webhook verified paid (3m later = 5m total)

  async function seedAnalyticsRepository() {
    const repository = new InMemoryRecoveryRepository();

    // Case 1: Recovered via CREATE_PAYMENT_LINK (₹1,000)
    const case1 = await repository.createCase({
      paymentId: 'pay_c1',
      orderId: 'order_c1',
      amount: 100000,
      currency: 'INR',
      riskLevel: 'HIGH',
      riskStatus: 'RESOLVED',
      riskReason: 'gateway_timeout',
      recoveredAmount: 100000,
      firstDetectedAt: t0,
      lastEventAt: t2
    });

    await repository.createDiagnosis({
      recoveryCaseId: case1.id,
      diagnosis: { cause: 'TRANSIENT_PAYMENT_FAILURE', confidence: 0.85, evidence: [{ field: 'payment.failureReason', value: 'gateway_timeout' }] },
      proposedAction: 'CREATE_PAYMENT_LINK',
      recommendation: { action: 'CREATE_PAYMENT_LINK', reason: 'High ERV' },
      candidateInterventions: [{ action: 'CREATE_PAYMENT_LINK', score: 0.85 }],
      provider: 'openai-compatible',
      model: 'gpt-4.1-mini',
      promptVersion: 'v1.2',
      source: 'live_ai'
    });

    const action1 = await repository.createAction({
      recoveryCaseId: case1.id,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'OUTCOME_CONFIRMED',
      policyDecision: 'ALLOW',
      policyVersion: 'v2.0',
      idempotencyKey: 'rc_1_pay_c1_v1',
      providerActionId: 'plink_c1',
      amount: 100000,
      currency: 'INR',
      createdAt: t1
    });

    await repository.createOutcome({
      recoveryCaseId: case1.id,
      recoveryActionId: action1.id,
      provider: 'razorpay',
      providerEventId: 'evt_out_1',
      providerPaymentLinkId: 'plink_c1',
      amountExpected: 100000,
      amountPaid: 100000,
      currency: 'INR',
      outcome: 'PAID',
      verified: true,
      verificationReason: 'Payment verified and confirmed',
      providerTimestamp: t2,
      receivedAt: t2
    });

    await repository.addAudit(case1.id, 'ACTION_EXECUTED', 'Payment Link executed', { actionId: action1.id });
    await repository.addAudit(case1.id, 'REVENUE_RECOVERED', 'Recovered ₹1,000', { amount: 100000 });

    // Case 2: Action executed but payment pending (₹2,500)
    const case2 = await repository.createCase({
      paymentId: 'pay_c2',
      orderId: 'order_c2',
      amount: 250000,
      currency: 'INR',
      riskLevel: 'MEDIUM',
      riskStatus: 'RECOVERABLE',
      riskReason: 'bank_server_error',
      firstDetectedAt: t0,
      lastEventAt: t1
    });

    await repository.createAction({
      recoveryCaseId: case2.id,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'EXECUTED',
      policyDecision: 'ALLOW',
      policyVersion: 'v2.0',
      idempotencyKey: 'rc_2_pay_c2_v1',
      providerActionId: 'plink_c2',
      amount: 250000,
      currency: 'INR',
      createdAt: t1
    });

    // Case 3: Blocked / Stopped case (₹500)
    const case3 = await repository.createCase({
      paymentId: 'pay_c3',
      orderId: 'order_c3',
      amount: 50000,
      currency: 'INR',
      riskLevel: 'LOW',
      riskStatus: 'OPEN',
      riskReason: 'customer_dropoff',
      firstDetectedAt: t0,
      lastEventAt: t0
    });

    const action3 = await repository.createAction({
      recoveryCaseId: case3.id,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'BLOCKED',
      policyDecision: 'BLOCK',
      policyVersion: 'v2.0',
      idempotencyKey: 'rc_3_pay_c3_v1',
      amount: 50000,
      currency: 'INR',
      failureReason: 'Terminal state block',
      createdAt: t0
    });

    await repository.addAudit(case3.id, 'ACTION_BLOCKED', 'Blocked by policy', {
      actionId: action3.id,
      stoppingReason: 'TERMINAL_PAYMENT'
    });

    // Case 4: Escalation Pending Approval (₹30,000 high value)
    const case4 = await repository.createCase({
      paymentId: 'pay_c4',
      orderId: 'order_c4',
      amount: 3000000,
      currency: 'INR',
      riskLevel: 'HIGH',
      riskStatus: 'OPEN',
      riskReason: 'high_value_escalation',
      escalationStatus: 'PENDING_APPROVAL',
      escalatedReason: 'HIGH_VALUE_THRESHOLD',
      firstDetectedAt: t0,
      lastEventAt: t0
    });

    await repository.addAudit(case4.id, 'ESCALATION_TRIGGERED', 'High value escalation triggered', {
      reason: 'HIGH_VALUE_THRESHOLD'
    });

    return repository;
  }

  describe('1. Summary & Metric Verification', () => {
    it('accurately derives total cases, revenue at risk, and recovered revenue', async () => {
      const repository = await seedAnalyticsRepository();
      const analytics = await getOverallOutcomeAnalytics(repository);

      expect(analytics.dataProvenance).toBe('TEST_MODE_VERIFIED');
      expect(analytics.isSimulated).toBe(false);

      const summary = analytics.summary;
      expect(summary.totalCases).toBe(4);
      expect(summary.resolvedCases).toBe(1);
      expect(summary.openCases).toBe(3);

      // Revenue recovered is ₹1,000 (100,000 paise)
      expect(summary.revenueRecoveredPaise).toBe(100000);
      expect(summary.revenueRecoveredFormatted).toBe('₹1,000');

      // Revenue at risk is open cases = 250000 + 50000 + 3000000 = 3,300,000 paise
      expect(summary.revenueAtRiskPaise).toBe(3300000);
      expect(summary.revenueAtRiskFormatted).toBe('₹33,000');

      // Actions
      expect(summary.actionCount).toBe(3);
      expect(summary.executedCount).toBe(2);
      expect(summary.verifiedRecoveries).toBe(1);
      expect(summary.pendingRecoveries).toBe(1);
      expect(summary.stopCount).toBe(1);
      expect(summary.escalationCount).toBe(1);
    });

    it('payment link creation without payment does NOT count as recovery', async () => {
      const repository = new InMemoryRecoveryRepository();
      const c = await repository.createCase({ paymentId: 'pay_unpaid', amount: 100000, currency: 'INR', riskStatus: 'RECOVERABLE' });
      await repository.createAction({ recoveryCaseId: c.id, actionType: 'CREATE_PAYMENT_LINK', status: 'EXECUTED', idempotencyKey: 'k_unpaid', amount: 100000, currency: 'INR' });

      const analytics = await getOverallOutcomeAnalytics(repository);
      expect(analytics.summary.revenueRecoveredPaise).toBe(0);
      expect(analytics.summary.verifiedRecoveries).toBe(0);
      expect(analytics.summary.pendingRecoveries).toBe(1);
    });

    it('partial payment is NOT counted as full verified recovery', async () => {
      const repository = new InMemoryRecoveryRepository();
      const c = await repository.createCase({ paymentId: 'pay_part', amount: 200000, currency: 'INR', riskStatus: 'RECOVERABLE' });
      const a = await repository.createAction({ recoveryCaseId: c.id, actionType: 'CREATE_PAYMENT_LINK', status: 'EXECUTED', idempotencyKey: 'k_part', amount: 200000, currency: 'INR' });

      // Partial payment outcome (verified: false)
      await repository.createOutcome({
        recoveryCaseId: c.id,
        recoveryActionId: a.id,
        provider: 'razorpay',
        providerEventId: 'evt_part',
        amountExpected: 200000,
        amountPaid: 50000,
        currency: 'INR',
        outcome: 'PARTIALLY_PAID',
        verified: false,
        verificationReason: 'Partial payment received'
      });

      const analytics = await getOverallOutcomeAnalytics(repository);
      expect(analytics.summary.revenueRecoveredPaise).toBe(0);
      expect(analytics.summary.verifiedRecoveries).toBe(0);
    });

    it('duplicate webhook delivery does not double count revenue', async () => {
      const repository = await seedAnalyticsRepository();

      // Duplicate delivery of evt_out_1
      const dupEvent = {
        eventId: 'evt_out_1',
        provider: 'razorpay',
        eventType: 'payment_link.paid',
        paymentLinkId: 'plink_c1',
        amount: 100000,
        amountPaid: 100000,
        currency: 'INR'
      };

      const res = await reconcileOutcome(repository, dupEvent);
      expect(res.duplicate).toBe(true);

      const analytics = await getOverallOutcomeAnalytics(repository);
      expect(analytics.summary.revenueRecoveredPaise).toBe(100000); // Still exactly 100,000!
      expect(analytics.summary.verifiedRecoveries).toBe(1);
    });
  });

  describe('2. Recovery Velocity & Timing Intelligence', () => {
    it('computes accurate recovery velocity from real timestamps', async () => {
      const repository = await seedAnalyticsRepository();
      const analytics = await getOverallOutcomeAnalytics(repository);

      const velocity = analytics.recoveryVelocity;
      expect(velocity.sampleSize).toBe(1);

      // t0 = 10:00:00, t2 = 10:05:00 -> 5 minutes = 300,000 ms
      expect(velocity.averageTimeToRecoveryMs).toBe(300000);
      expect(velocity.averageTimeToRecoveryFormatted).toBe('5m');
      expect(velocity.medianTimeToRecoveryMs).toBe(300000);
      expect(velocity.fastestRecoveryMs).toBe(300000);
      expect(velocity.slowestRecoveryMs).toBe(300000);
    });

    it('returns sampleSize: 0 and N/A when no recoveries exist', () => {
      const velocity = computeRecoveryVelocity([], [], []);
      expect(velocity.sampleSize).toBe(0);
      expect(velocity.averageTimeToRecoveryFormatted).toBe('N/A');
      expect(velocity.medianTimeToRecoveryFormatted).toBe('N/A');
    });
  });

  describe('3. Strategy Performance Breakdown', () => {
    it('aggregates per-strategy attempts, executed actions, recoveries, and conversion rate', async () => {
      const repository = await seedAnalyticsRepository();
      const analytics = await getOverallOutcomeAnalytics(repository);

      const stratPerf = analytics.strategyPerformance;
      expect(stratPerf['CREATE_PAYMENT_LINK']).toBeDefined();

      const plink = stratPerf['CREATE_PAYMENT_LINK'];
      expect(plink.attempts).toBe(3); // case 1, 2, 3
      expect(plink.executed).toBe(2); // case 1, 2
      expect(plink.verifiedRecoveries).toBe(1); // case 1
      expect(plink.recoveredAmountPaise).toBe(100000);
      expect(plink.recoveredAmountFormatted).toBe('₹1,000');
      expect(plink.recoveryRate).toBe(0.5); // 1 / 2 executed
      expect(plink.isLiveExecutable).toBe(true);

      // Non-executed strategies remain present with 0 attempts
      expect(stratPerf['SCHEDULE_RETRY_WINDOW']).toBeDefined();
      expect(stratPerf['SCHEDULE_RETRY_WINDOW'].attempts).toBe(0);
      expect(stratPerf['SCHEDULE_RETRY_WINDOW'].recoveryRate).toBe(0);
    });
  });

  describe('4. Failure Analytics & Portfolio Funnel', () => {
    it('breaks down recovery by failure reason and stop reasons', async () => {
      const repository = await seedAnalyticsRepository();
      const analytics = await getOverallOutcomeAnalytics(repository);

      const failures = analytics.failureAnalytics;

      // By failure reason
      expect(failures.recoveryByFailureReason['gateway_timeout']).toBeDefined();
      expect(failures.recoveryByFailureReason['gateway_timeout'].totalCases).toBe(1);
      expect(failures.recoveryByFailureReason['gateway_timeout'].recoveredPaise).toBe(100000);
      expect(failures.recoveryByFailureReason['gateway_timeout'].recoveryRate).toBe(1.0);

      // Stop reasons
      expect(failures.stopReasonDistribution['TERMINAL_PAYMENT']).toBe(1);

      // Escalation reasons
      expect(failures.escalationReasonDistribution['HIGH_VALUE_THRESHOLD']).toBe(1);
    });

    it('enforces portfolio funnel invariants', async () => {
      const repository = await seedAnalyticsRepository();
      const analytics = await getOverallOutcomeAnalytics(repository);

      const funnel = analytics.portfolioFunnel.funnel;
      const branches = analytics.portfolioFunnel.branches;

      expect(funnel.ingested).toBe(4);
      expect(funnel.strategySelected).toBe(3);
      expect(funnel.executed).toBe(2);
      expect(funnel.verified).toBe(1);

      // Invariants
      expect(funnel.verified).toBeLessThanOrEqual(funnel.executed);
      expect(funnel.recoveredRevenuePaise).toBeLessThanOrEqual(analytics.summary.revenueAtRiskPaise + analytics.summary.revenueRecoveredPaise);
      expect(branches.stopped).toBeGreaterThanOrEqual(1);
      expect(branches.escalated).toBeGreaterThanOrEqual(1);
    });
  });

  describe('5. Agent Evaluation Telemetry Integration', () => {
    it('derives agent evaluation metrics from stored diagnoses and actions', async () => {
      const repository = await seedAnalyticsRepository();
      const analytics = await getOverallOutcomeAnalytics(repository);

      const agentEval = analytics.agentEvaluation;
      expect(agentEval.totalEvaluations).toBe(1);
      expect(agentEval.schemaValidityRate).toBe(1.0);
      expect(agentEval.evidenceGroundingPassRate).toBe(1.0);
      expect(agentEval.policyAllowRate).toBe(1.0);
      expect(agentEval.verifiedRecoveryRate).toBe(1.0);
      expect(agentEval.evaluationMetadata.isGroundTruthBenchmark).toBe(false);
    });
  });

  describe('6. REST API Endpoints Integration', () => {
    it('GET /api/recovery/analytics returns complete outcome analytics with 200', async () => {
      const repository = await seedAnalyticsRepository();
      const app = createApp(repository);

      const res = await request(app)
        .get('/api/recovery/analytics')
        .expect(200);

      expect(res.body.dataProvenance).toBe('TEST_MODE_VERIFIED');
      expect(res.body.isSimulated).toBe(false);
      expect(res.body.summary.totalCases).toBe(4);
      expect(res.body.recoveryVelocity).toBeDefined();
      expect(res.body.strategyPerformance).toBeDefined();
      expect(res.body.portfolioFunnel).toBeDefined();
    });

    it('GET /api/recovery/analytics/strategies returns strategy performance breakdown', async () => {
      const repository = await seedAnalyticsRepository();
      const app = createApp(repository);

      const res = await request(app)
        .get('/api/recovery/analytics/strategies')
        .expect(200);

      expect(res.body.dataProvenance).toBe('TEST_MODE_VERIFIED');
      expect(res.body.strategies).toBeDefined();
      expect(res.body.strategies['CREATE_PAYMENT_LINK']).toBeDefined();
    });

    it('GET /api/recovery/analytics/failures returns failure and stop intelligence', async () => {
      const repository = await seedAnalyticsRepository();
      const app = createApp(repository);

      const res = await request(app)
        .get('/api/recovery/analytics/failures')
        .expect(200);

      expect(res.body.dataProvenance).toBe('TEST_MODE_VERIFIED');
      expect(res.body.failures).toBeDefined();
      expect(res.body.failures.recoveryByFailureReason).toBeDefined();
      expect(res.body.failures.stopReasonDistribution).toBeDefined();
    });

    it('GET /api/recovery/analytics/velocity returns recovery velocity metrics with 200', async () => {
      const repository = await seedAnalyticsRepository();
      const app = createApp(repository);

      const res = await request(app)
        .get('/api/recovery/analytics/velocity')
        .expect(200);

      expect(res.body.dataProvenance).toBe('TEST_MODE_VERIFIED');
      expect(res.body.recoveryVelocity).toBeDefined();
      expect(res.body.recoveryVelocity.sampleSize).toBe(1);
      expect(res.body.recoveryVelocity.averageTimeToRecoveryFormatted).toBe('5m');
    });

    it('asserts top-level safety invariants: recoveredRevenue <= revenueAtRisk and verifiedRecoveries <= executedActions', async () => {
      const repository = await seedAnalyticsRepository();
      const analytics = await getOverallOutcomeAnalytics(repository);

      expect(analytics.invariants).toBeDefined();
      expect(analytics.invariants.recoveredRevenueLERevenueAtRisk).toBe(true);
      expect(analytics.invariants.verifiedRecoveriesLEExecutedActions).toBe(true);
      expect(analytics.portfolioFunnel.invariants.revenueConsistent).toBe(true);
    });
  });
});
