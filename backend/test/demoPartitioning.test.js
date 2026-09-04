import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { InMemoryRecoveryRepository } from '../src/models/inMemoryRecoveryRepository';
import { createApp } from '../src/app';
import { buildAdaptiveModelInspection, extractAttributedOutcomes } from '../src/ai/adaptiveLearningEngine';

describe('Demo Recovery Portfolio Partitioning & Isolation', () => {
  let repository;
  let app;

  beforeEach(async () => {
    repository = new InMemoryRecoveryRepository();
    app = createApp(repository);

    // Seed production cases
    await repository.createCase({
      paymentId: 'pay_prod_01',
      orderId: 'order_prod_01',
      amount: 100000,
      currency: 'INR',
      customerReference: 'cust_prod_01',
      riskStatus: 'RESOLVED',
      riskReason: 'Recovered via link',
      riskLevel: 'LOW',
      autonomyStatus: 'COMPLETED',
      recoveredAmount: 100000,
      firstDetectedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString()
    });

    const prodCase2 = await repository.createCase({
      paymentId: 'pay_prod_02',
      orderId: 'order_prod_02',
      amount: 50000,
      currency: 'INR',
      customerReference: 'cust_prod_02',
      riskStatus: 'RECOVERABLE',
      riskReason: 'Payment gateway timeout',
      riskLevel: 'MEDIUM',
      autonomyStatus: 'QUEUED',
      firstDetectedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString()
    });

    const prodAction1 = await repository.createAction({
      recoveryCaseId: 1,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'OUTCOME_CONFIRMED',
      policyDecision: 'ALLOW',
      policyVersion: '1.0',
      idempotencyKey: 'idemp_prod_01',
      provider: 'razorpay',
      providerActionId: 'plink_prod_01',
      amount: 100000,
      currency: 'INR'
    });

    await repository.createOutcome({
      recoveryCaseId: 1,
      recoveryActionId: prodAction1.id,
      provider: 'razorpay',
      providerEventId: 'evt_prod_paid_01',
      providerPaymentLinkId: 'plink_prod_01',
      amountExpected: 100000,
      amountPaid: 100000,
      currency: 'INR',
      outcome: 'PAID',
      verified: true,
      verificationReason: 'Verified match'
    });

    await repository.createAction({
      recoveryCaseId: prodCase2.id,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'EXECUTED',
      policyDecision: 'ALLOW',
      policyVersion: '1.0',
      idempotencyKey: 'idemp_prod_02',
      provider: 'razorpay',
      providerActionId: 'plink_prod_02',
      amount: 50000,
      currency: 'INR'
    });

    // Seed demo cases with isDemo = true
    const demoCase1 = await repository.createCase({
      paymentId: 'pay_demo_01',
      orderId: 'order_demo_01',
      amount: 499900,
      currency: 'INR',
      customerReference: 'cust_demo_01',
      riskStatus: 'RESOLVED',
      riskReason: 'Demo recovery verified',
      riskLevel: 'LOW',
      autonomyStatus: 'INACTIVE',
      isDemo: true,
      recoveredAmount: 499900,
      firstDetectedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString()
    });

    const demoCase2 = await repository.createCase({
      paymentId: 'pay_demo_02',
      orderId: 'order_demo_02',
      amount: 349900,
      currency: 'INR',
      customerReference: 'cust_demo_02',
      riskStatus: 'RECOVERABLE',
      riskReason: 'Checkout drop-off',
      riskLevel: 'LOW',
      autonomyStatus: 'INACTIVE',
      isDemo: true,
      firstDetectedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString()
    });

    const demoAction1 = await repository.createAction({
      recoveryCaseId: demoCase1.id,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'OUTCOME_CONFIRMED',
      policyDecision: 'ALLOW',
      policyVersion: '1.0',
      idempotencyKey: 'idemp_demo_01',
      provider: 'razorpay',
      providerActionId: 'plink_demo_01',
      amount: 499900,
      currency: 'INR'
    });

    await repository.createOutcome({
      recoveryCaseId: demoCase1.id,
      recoveryActionId: demoAction1.id,
      provider: 'razorpay',
      providerEventId: 'evt_demo_paid_01',
      providerPaymentLinkId: 'plink_demo_01',
      amountExpected: 499900,
      amountPaid: 499900,
      currency: 'INR',
      outcome: 'PAID',
      verified: true,
      verificationReason: 'Verified match for demo'
    });

    await repository.createAction({
      recoveryCaseId: demoCase2.id,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'EXECUTED',
      policyDecision: 'ALLOW',
      policyVersion: '1.0',
      idempotencyKey: 'idemp_demo_02',
      provider: 'razorpay',
      providerActionId: 'plink_demo_02',
      amount: 349900,
      currency: 'INR'
    });
  });

  describe('Repository Partitioning', () => {
    it('defaults isDemo to false for standard case creation', async () => {
      const c = await repository.createCase({
        paymentId: 'pay_standard_default',
        amount: 25000,
        currency: 'INR',
        riskStatus: 'OPEN',
        riskReason: 'Test',
        riskLevel: 'LOW',
        firstDetectedAt: new Date().toISOString(),
        lastEventAt: new Date().toISOString()
      });
      expect(c.isDemo).toBe(false);
    });

    it('explicitly stores isDemo: true when provided', async () => {
      const c = await repository.createCase({
        paymentId: 'pay_demo_explicit',
        amount: 25000,
        currency: 'INR',
        riskStatus: 'OPEN',
        riskReason: 'Test',
        riskLevel: 'LOW',
        isDemo: true,
        firstDetectedAt: new Date().toISOString(),
        lastEventAt: new Date().toISOString()
      });
      expect(c.isDemo).toBe(true);
    });

    it('listCases() returns only production cases by default', async () => {
      const cases = await repository.listCases();
      expect(cases.length).toBe(2);
      expect(cases.every((c) => c.isDemo === false)).toBe(true);
      expect(cases.map((c) => c.paymentId)).toContain('pay_prod_01');
      expect(cases.map((c) => c.paymentId)).toContain('pay_prod_02');
    });

    it('listCases({ isDemo: true }) returns only demo cases', async () => {
      const demoCases = await repository.listCases({ isDemo: true });
      expect(demoCases.length).toBe(2);
      expect(demoCases.every((c) => c.isDemo === true)).toBe(true);
      expect(demoCases.map((c) => c.paymentId)).toContain('pay_demo_01');
      expect(demoCases.map((c) => c.paymentId)).toContain('pay_demo_02');
    });

    it('getRecoveryMetrics() calculates metrics strictly for production cases', async () => {
      const metrics = await repository.getRecoveryMetrics();
      expect(metrics.total_cases).toBe(2);
      expect(metrics.open_cases).toBe(1);
      expect(metrics.resolved_cases).toBe(1);
      expect(metrics.revenue_at_risk).toBe(50000);
      expect(metrics.revenue_recovered).toBe(100000);
      expect(metrics.confirmed_recoveries).toBe(1);
      expect(metrics.pending_recoveries).toBe(1);
    });

    it('getRecoveryMetrics({ isDemo: true }) calculates metrics strictly for demo cases', async () => {
      const metrics = await repository.getRecoveryMetrics({ isDemo: true });
      expect(metrics.total_cases).toBe(2);
      expect(metrics.open_cases).toBe(1);
      expect(metrics.resolved_cases).toBe(1);
      expect(metrics.revenue_at_risk).toBe(349900);
      expect(metrics.revenue_recovered).toBe(499900);
      expect(metrics.confirmed_recoveries).toBe(1);
      expect(metrics.pending_recoveries).toBe(1);
    });
  });

  describe('Adaptive Learning Model Isolation', () => {
    it('excludes demo outcomes from production model extraction', () => {
      const nonDemoCase = { id: 1, isDemo: false, riskStatus: 'RESOLVED', outcome: 'RECOVERED' };
      const demoCase = { id: 3, isDemo: true, riskStatus: 'RESOLVED', outcome: 'RECOVERED' };
      const nonDemoAction = { id: 10, recoveryCaseId: 1, actionType: 'CREATE_PAYMENT_LINK', status: 'OUTCOME_CONFIRMED' };
      const demoAction = { id: 30, recoveryCaseId: 3, actionType: 'CREATE_PAYMENT_LINK', status: 'OUTCOME_CONFIRMED' };
      const nonDemoOutcome = { id: 100, recoveryCaseId: 1, recoveryActionId: 10, verified: true, outcome: 'PAID' };
      const demoOutcome = { id: 300, recoveryCaseId: 3, recoveryActionId: 30, verified: true, outcome: 'PAID' };
      const diagnosis = { recoveryCaseId: 1, diagnosis: { failureFamily: 'GATEWAY_TECHNICAL_FAILURE' } };

      const { summary, statsByPair } = extractAttributedOutcomes({
        cases: [nonDemoCase, demoCase],
        actions: [nonDemoAction, demoAction],
        outcomes: [nonDemoOutcome, demoOutcome],
        diagnoses: [diagnosis]
      });

      expect(summary.totalCases).toBe(1);
      expect(summary.attributedSuccesses).toBe(1);
      const pairStats = statsByPair['CREATE_PAYMENT_LINK:GATEWAY_TECHNICAL_FAILURE'];
      expect(pairStats.successes).toBe(1);
    });

    it('buildAdaptiveModelInspection inspects repository without demo outcome pollution', async () => {
      const inspection = await buildAdaptiveModelInspection(repository);
      expect(inspection.summary.totalProductionCases).toBe(2);
      expect(inspection.summary.attributedSuccesses).toBe(1);
    });
  });

  describe('API Endpoints Partitioning', () => {
    it('GET /api/cases returns only production cases', async () => {
      const res = await request(app).get('/api/cases');
      expect(res.status).toBe(200);
      expect(res.body.cases.length).toBe(2);
      expect(res.body.cases.every((c) => c.isDemo === false)).toBe(true);
    });

    it('GET /api/cases?demo=true returns only demo cases', async () => {
      const res = await request(app).get('/api/cases?demo=true');
      expect(res.status).toBe(200);
      expect(res.body.cases.length).toBe(2);
      expect(res.body.cases.every((c) => c.isDemo === true)).toBe(true);
    });

    it('GET /api/recovery/metrics returns production metrics by default', async () => {
      const res = await request(app).get('/api/recovery/metrics');
      expect(res.status).toBe(200);
      expect(res.body.metrics.total_cases).toBe(2);
      expect(res.body.metrics.revenue_at_risk).toBe(50000);
      expect(res.body.metrics.revenue_recovered).toBe(100000);
    });

    it('GET /api/recovery/metrics?demo=true returns demo metrics', async () => {
      const res = await request(app).get('/api/recovery/metrics?demo=true');
      expect(res.status).toBe(200);
      expect(res.body.metrics.total_cases).toBe(2);
      expect(res.body.metrics.revenue_at_risk).toBe(349900);
      expect(res.body.metrics.revenue_recovered).toBe(499900);
    });

    it('GET /api/cases/metrics returns production metrics', async () => {
      const res = await request(app).get('/api/cases/metrics');
      expect(res.status).toBe(200);
      expect(res.body.metrics.total_cases).toBe(2);
      expect(res.body.metrics.revenue_recovered).toBe(100000);
    });

    it('GET /api/cases/metrics?demo=true returns demo metrics', async () => {
      const res = await request(app).get('/api/cases/metrics?demo=true');
      expect(res.status).toBe(200);
      expect(res.body.metrics.total_cases).toBe(2);
      expect(res.body.metrics.revenue_recovered).toBe(499900);
    });
  });
});
