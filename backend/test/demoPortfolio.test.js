import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { InMemoryRecoveryRepository } from '../src/models/inMemoryRecoveryRepository';
import { createApp } from '../src/app';
import { DEMO_FIXTURES, seedDemoPortfolio } from '../src/db/seedDemoPortfolio';
import { buildAdaptiveModelInspection } from '../src/ai/adaptiveLearningEngine';

describe('Demo Recovery Portfolio (Checkpoint 2)', () => {
  let repository;
  let app;

  beforeEach(async () => {
    repository = new InMemoryRecoveryRepository();
    app = createApp(repository);

    // Seed 4 production cases matching frozen production profile
    await repository.createCase({
      paymentId: 'pay_prod_01',
      orderId: 'order_prod_01',
      amount: 49900, // ₹499
      currency: 'INR',
      customerReference: 'cust_prod_01',
      riskStatus: 'RESOLVED',
      riskReason: 'Payment settled',
      riskLevel: 'LOW',
      autonomyStatus: 'COMPLETED',
      recoveredAmount: 49900,
      firstDetectedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString()
    });

    await repository.createCase({
      paymentId: 'pay_prod_02',
      orderId: 'order_prod_02',
      amount: 75100, // ₹751
      currency: 'INR',
      customerReference: 'cust_prod_02',
      riskStatus: 'RESOLVED',
      riskReason: 'Payment settled',
      riskLevel: 'LOW',
      autonomyStatus: 'COMPLETED',
      recoveredAmount: 75100,
      firstDetectedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString()
    });

    await repository.createCase({
      paymentId: 'pay_prod_03',
      orderId: 'order_prod_03',
      amount: 50000, // ₹500
      currency: 'INR',
      customerReference: 'cust_prod_03',
      riskStatus: 'RESOLVED',
      riskReason: 'Payment settled',
      riskLevel: 'LOW',
      autonomyStatus: 'COMPLETED',
      recoveredAmount: 50000,
      firstDetectedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString()
    });

    await repository.createCase({
      paymentId: 'pay_prod_04',
      orderId: 'order_prod_04',
      amount: 50000, // ₹500
      currency: 'INR',
      customerReference: '+919876543210',
      riskStatus: 'RECOVERABLE',
      riskReason: 'Payment method failure',
      riskLevel: 'MEDIUM',
      autonomyStatus: 'ACTING',
      firstDetectedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString()
    });

    const a1 = await repository.createAction({
      recoveryCaseId: 1,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'OUTCOME_CONFIRMED',
      policyDecision: 'ALLOW',
      policyVersion: '1.0',
      idempotencyKey: 'idemp_prod_01',
      provider: 'razorpay',
      amount: 49900,
      currency: 'INR'
    });
    await repository.createOutcome({
      recoveryCaseId: 1,
      recoveryActionId: a1.id,
      amountPaid: 49900,
      verified: true,
      outcome: 'PAID',
      provider: 'razorpay',
      providerEventId: 'evt_recon_01'
    });

    const a2 = await repository.createAction({
      recoveryCaseId: 2,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'OUTCOME_CONFIRMED',
      policyDecision: 'ALLOW',
      policyVersion: '1.0',
      idempotencyKey: 'idemp_prod_02',
      provider: 'razorpay',
      amount: 75100,
      currency: 'INR'
    });
    await repository.createOutcome({
      recoveryCaseId: 2,
      recoveryActionId: a2.id,
      amountPaid: 75100,
      verified: true,
      outcome: 'PAID',
      provider: 'razorpay',
      providerEventId: 'evt_recon_02'
    });

    const a3 = await repository.createAction({
      recoveryCaseId: 3,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'OUTCOME_CONFIRMED',
      policyDecision: 'ALLOW',
      policyVersion: '1.0',
      idempotencyKey: 'idemp_prod_03',
      provider: 'razorpay',
      amount: 50000,
      currency: 'INR'
    });
    await repository.createOutcome({
      recoveryCaseId: 3,
      recoveryActionId: a3.id,
      amountPaid: 50000,
      verified: true,
      outcome: 'PAID',
      provider: 'razorpay',
      providerEventId: 'evt_recon_03'
    });
  });

  describe('Deterministic Seeding & Idempotency', () => {
    it('seeds exactly 8 demo fixtures with isDemo=true', async () => {
      const result = await seedDemoPortfolio(repository);
      expect(result.createdCount).toBe(8);
      expect(result.skippedCount).toBe(0);
      expect(result.totalDemoCases).toBe(8);

      const demoCases = await repository.listCases({ isDemo: true });
      expect(demoCases).toHaveLength(8);
      for (const c of demoCases) {
        expect(c.isDemo).toBe(true);
        expect(c.riskStatus).toBe('RECOVERABLE');
        expect(c.recoveredAmount).toBe(0);
      }
    });

    it('re-running seedDemoPortfolio is strictly idempotent', async () => {
      const firstRun = await seedDemoPortfolio(repository);
      expect(firstRun.createdCount).toBe(8);

      const secondRun = await seedDemoPortfolio(repository);
      expect(secondRun.createdCount).toBe(0);
      expect(secondRun.skippedCount).toBe(8);
      expect(secondRun.totalDemoCases).toBe(8);

      const demoCases = await repository.listCases({ isDemo: true });
      expect(demoCases).toHaveLength(8);
    });

    it('demo fixtures match the exact 8 planned amounts and have ₹38,247 total exposure', async () => {
      await seedDemoPortfolio(repository);
      const demoCases = await repository.listCases({ isDemo: true });

      const expectedAmounts = [
        499900, // ₹4,999
        349900, // ₹3,499
        899900, // ₹8,999
        699900, // ₹6,999
        250000, // ₹2,500
        125000, // ₹1,250
        250000, // ₹2,500
        750000  // ₹7,500
      ];

      const actualAmounts = demoCases.map((c) => c.amount);
      for (const amt of expectedAmounts) {
        expect(actualAmounts).toContain(amt);
      }

      const totalExposure = actualAmounts.reduce((sum, a) => sum + a, 0);
      expect(totalExposure).toBe(3824600); // ₹38,246
    });

    it('creates zero outcomes and zero recovery actions during seeding', async () => {
      await seedDemoPortfolio(repository);
      const demoCases = await repository.listCases({ isDemo: true });

      for (const c of demoCases) {
        const detail = await repository.getCaseDetail(c.id);
        expect(detail.actions).toHaveLength(0);
        const outcomes = await repository.findOutcomesByCaseId(c.id);
        expect(outcomes).toHaveLength(0);
      }
    });
  });

  describe('Production Invariant Verification', () => {
    it('production cases remain exactly 4 and are never altered by demo seeding', async () => {
      const prodBefore = await repository.listCases({ isDemo: false });
      expect(prodBefore).toHaveLength(4);

      await seedDemoPortfolio(repository);

      const prodAfter = await repository.listCases({ isDemo: false });
      expect(prodAfter).toHaveLength(4);
      expect(prodAfter.map((c) => c.paymentId).sort()).toEqual([
        'pay_prod_01',
        'pay_prod_02',
        'pay_prod_03',
        'pay_prod_04'
      ]);
    });

    it('GET /api/cases returns only the 4 production cases', async () => {
      await seedDemoPortfolio(repository);

      const res = await request(app).get('/api/cases');
      expect(res.status).toBe(200);
      expect(res.body.cases).toHaveLength(4);
      for (const c of res.body.cases) {
        expect(c.isDemo).toBe(false);
      }
    });

    it('GET /api/recovery/metrics returns only production metrics', async () => {
      await seedDemoPortfolio(repository);

      const res = await request(app).get('/api/recovery/metrics');
      expect(res.status).toBe(200);
      expect(res.body.metrics.total_cases).toBe(4);
      expect(res.body.metrics.revenue_recovered).toBe(175000); // ₹1,750
      expect(res.body.metrics.revenue_at_risk).toBe(50000); // ₹500
      expect(res.body.metrics.resolved_cases).toBe(3);
    });

    it('adaptive learning engine excludes demo cases from dataset summary', async () => {
      await seedDemoPortfolio(repository);

      const inspection = await buildAdaptiveModelInspection(repository);
      expect(inspection.summary.totalProductionCases).toBe(4);
    });
  });

  describe('Dedicated Demo API Endpoints', () => {
    beforeEach(async () => {
      await seedDemoPortfolio(repository);
    });

    it('GET /api/demo/cases returns exactly 8 augmented demo cases', async () => {
      const res = await request(app).get('/api/demo/cases');
      expect(res.status).toBe(200);
      expect(res.body.provenance).toBe('DEMO / RAZORPAY TEST MODE');
      expect(res.body.isDemo).toBe(true);
      expect(res.body.totalCases).toBe(8);
      expect(res.body.cases).toHaveLength(8);

      for (const c of res.body.cases) {
        expect(c.isDemo).toBe(true);
        expect(c.failureFamily).toBeTruthy();
        expect(c.recommendedStrategy).toBeTruthy();
        expect(c.strategyName).toBeTruthy();
        expect(c.executionMode).toBeTruthy();
        expect(['ALLOW', 'REVIEW', 'BLOCK']).toContain(c.policyDecision);
        expect(['CONTINUE', 'ESCALATE', 'HARD_STOP', 'WAIT']).toContain(c.stoppingDisposition);
        expect(c.actionsCount).toBe(0);
        expect(c.activePaymentLink).toBeNull();
      }
    });

    it('GET /api/demo/metrics returns isolated demo metrics', async () => {
      const res = await request(app).get('/api/demo/metrics');
      expect(res.status).toBe(200);
      expect(res.body.provenance).toBe('DEMO / RAZORPAY TEST MODE');
      expect(res.body.isDemo).toBe(true);
      expect(res.body.metrics.total_cases).toBe(8);
      expect(res.body.metrics.revenue_at_risk).toBe(3824600); // ₹38,246
      expect(res.body.metrics.revenue_recovered).toBe(0);
      expect(res.body.metrics.resolved_cases).toBe(0);
    });

    it('GET /api/demo/cases/:id returns full detail for a demo case', async () => {
      const listRes = await request(app).get('/api/demo/cases');
      const firstCase = listRes.body.cases[0];

      const res = await request(app).get(`/api/demo/cases/${firstCase.id}`);
      expect(res.status).toBe(200);
      expect(res.body.isDemo).toBe(true);
      expect(res.body.recoveryCase.id).toBe(firstCase.id);
      expect(res.body.diagnosis).toBeTruthy();
      expect(res.body.policyEvaluation).toBeTruthy();
      expect(res.body.stoppingEvaluation).toBeTruthy();
    });

    it('GET /api/demo/cases/:id returns 404 for a production case', async () => {
      // Case 1 is a production case
      const res = await request(app).get('/api/demo/cases/1');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('DEMO_CASE_NOT_FOUND');
    });

    it('POST /api/demo/seed is idempotent over HTTP', async () => {
      const res = await request(app).post('/api/demo/seed');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.skippedCount).toBe(8);
      expect(res.body.createdCount).toBe(0);
      expect(res.body.totalDemoCases).toBe(8);
    });
  });

  describe('Authoritative Engine Decisions for the 8 Demo Fixtures (Option A)', () => {
    beforeEach(async () => {
      await seedDemoPortfolio(repository);
    });

    it('evaluates each Option A fixture according to the real Revflow engine without forced overrides', async () => {
      const res = await request(app).get('/api/demo/cases');
      const cases = res.body.cases;
      expect(cases).toHaveLength(8);

      // 1. Gateway Technical Failure (pay_demo_gw_01)
      const c1 = cases.find((c) => c.paymentId === 'pay_demo_gw_01');
      expect(c1.amount).toBe(499900);
      expect(c1.failureFamily).toBe('GATEWAY_TECHNICAL_FAILURE');
      expect(c1.recommendedStrategy).toBe('CREATE_PAYMENT_LINK');
      expect(c1.executionMode).toBe('LIVE_PROVIDER');
      expect(c1.policyDecision).toBe('ALLOW');
      expect(c1.stoppingDisposition).toBe('CONTINUE');
      expect(c1.expectedRecoveryValue).toBe(174965); // ₹1,749.65

      // 2. 3DS Authentication Failure (pay_demo_auth_02)
      const c2 = cases.find((c) => c.paymentId === 'pay_demo_auth_02');
      expect(c2.amount).toBe(349900);
      expect(c2.failureFamily).toBe('AUTHENTICATION_FAILURE');
      expect(c2.recommendedStrategy).toBe('CREATE_PAYMENT_LINK');
      expect(c2.executionMode).toBe('LIVE_PROVIDER');
      expect(c2.policyDecision).toBe('ALLOW');
      expect(c2.stoppingDisposition).toBe('CONTINUE');
      expect(c2.expectedRecoveryValue).toBe(122465); // ₹1,224.65

      // 3. Payment Method Expired (pay_demo_exp_03)
      const c3 = cases.find((c) => c.paymentId === 'pay_demo_exp_03');
      expect(c3.amount).toBe(899900);
      expect(c3.failureFamily).toBe('AUTHENTICATION_FAILURE');
      expect(c3.recommendedStrategy).toBe('CREATE_PAYMENT_LINK');
      expect(c3.executionMode).toBe('LIVE_PROVIDER');
      expect(c3.policyDecision).toBe('ALLOW');
      expect(c3.stoppingDisposition).toBe('CONTINUE');
      expect(c3.expectedRecoveryValue).toBe(314965); // ₹3,149.65

      // 4. Issuer Bank Switch Timeout (pay_demo_bst_04)
      const c4 = cases.find((c) => c.paymentId === 'pay_demo_bst_04');
      expect(c4.amount).toBe(125000);
      expect(c4.failureFamily).toBe('BANK_SWITCH_TIMEOUT');
      expect(c4.recommendedStrategy).toBe('CREATE_PAYMENT_LINK');
      expect(c4.executionMode).toBe('LIVE_PROVIDER');
      expect(c4.policyDecision).toBe('ALLOW');
      expect(c4.stoppingDisposition).toBe('CONTINUE');
      expect(c4.expectedRecoveryValue).toBe(56250); // ₹562.50

      // 5. Netbanking Gateway Timeout (pay_demo_net_05)
      const c5 = cases.find((c) => c.paymentId === 'pay_demo_net_05');
      expect(c5.amount).toBe(699900);
      expect(c5.failureFamily).toBe('GATEWAY_TECHNICAL_FAILURE');
      expect(c5.recommendedStrategy).toBe('CREATE_PAYMENT_LINK');
      expect(c5.executionMode).toBe('LIVE_PROVIDER');
      expect(c5.policyDecision).toBe('ALLOW');
      expect(c5.stoppingDisposition).toBe('CONTINUE');
      expect(c5.expectedRecoveryValue).toBe(244965); // ₹2,449.65

      // 6. UPI Switch Timeout (pay_demo_upi_06)
      const c6 = cases.find((c) => c.paymentId === 'pay_demo_upi_06');
      expect(c6.amount).toBe(250000);
      expect(c6.failureFamily).toBe('BANK_SWITCH_TIMEOUT');
      expect(c6.recommendedStrategy).toBe('CREATE_PAYMENT_LINK');
      expect(c6.executionMode).toBe('LIVE_PROVIDER');
      expect(c6.policyDecision).toBe('ALLOW');
      expect(c6.stoppingDisposition).toBe('CONTINUE');
      expect(c6.expectedRecoveryValue).toBe(112500); // ₹1,125.00

      // 7. Acquirer Rail Degradation (pay_demo_acq_07)
      const c7 = cases.find((c) => c.paymentId === 'pay_demo_acq_07');
      expect(c7.amount).toBe(250000);
      expect(c7.failureFamily).toBe('GATEWAY_TECHNICAL_FAILURE');
      expect(c7.recommendedStrategy).toBe('CREATE_PAYMENT_LINK');
      expect(c7.executionMode).toBe('LIVE_PROVIDER');
      expect(c7.policyDecision).toBe('ALLOW');
      expect(c7.stoppingDisposition).toBe('CONTINUE');
      expect(c7.expectedRecoveryValue).toBe(87500); // ₹875.00

      // 8. Card Security Authorization Failure (pay_demo_dec_08)
      const c8 = cases.find((c) => c.paymentId === 'pay_demo_dec_08');
      expect(c8.amount).toBe(750000);
      expect(c8.failureFamily).toBe('AUTHENTICATION_FAILURE');
      expect(c8.recommendedStrategy).toBe('CREATE_PAYMENT_LINK');
      expect(c8.executionMode).toBe('LIVE_PROVIDER');
      expect(c8.policyDecision).toBe('ALLOW');
      expect(c8.stoppingDisposition).toBe('CONTINUE');
      expect(c8.expectedRecoveryValue).toBe(262500); // ₹2,625.00
    });
  });

  describe('Task B — Boundary Hardening Regression Tests', () => {
    it('rejects external POST /api/events containing isDemo with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/events')
        .send({
          eventId: 'evt_unauthorized_demo_attempt',
          eventType: 'payment.failed',
          paymentId: 'pay_unauth_01',
          amount: 50000,
          currency: 'INR',
          timestamp: new Date().toISOString(),
          isDemo: true
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body.details)).toContain('isDemo');
    });

    it('creates isDemo=false case from valid POST /api/events', async () => {
      const res = await request(app)
        .post('/api/events')
        .send({
          eventId: 'evt_valid_public_01',
          eventType: 'payment.failed',
          paymentId: 'pay_valid_pub_01',
          amount: 50000,
          currency: 'INR',
          timestamp: new Date().toISOString()
        });
      expect(res.status).toBe(201);
      expect(res.body.recoveryCase.isDemo).toBe(false);

      const created = await repository.findCaseByPaymentId('pay_valid_pub_01');
      expect(created.isDemo).toBe(false);
    });

    it('prohibits targeting production cases via /api/demo routes', async () => {
      for (const prodId of [1, 2, 3, 4]) {
        const res = await request(app).get(`/api/demo/cases/${prodId}`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('DEMO_CASE_NOT_FOUND');
      }
    });

    it('prohibits autonomous recovery worker from claiming demo cases', async () => {
      await seedDemoPortfolio(repository);
      const demoCases = await repository.listCases({ isDemo: true });
      expect(demoCases).toHaveLength(8);

      const candidate = await repository.claimNextJob({
        workerId: 'worker_safety_check',
        leaseDurationSeconds: 60
      });
      if (candidate) {
        expect(candidate.isDemo).toBe(false);
      }
    });
  });
});
