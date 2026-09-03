/**
 * Revflow V2 — Batch Recovery Evaluation Tests
 *
 * Verifies batch/portfolio evaluation, input sanitization, error boundaries,
 * heuristic ERV aggregation, strategy distribution, and data provenance isolation.
 */

const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { evaluateBatch, validateBatchInput, BatchValidationError } = require('../src/services/batchRecoveryService');

describe('Revflow V2 — Batch Recovery Evaluation Service', () => {
  const fixedNow = () => new Date('2026-09-03T12:00:00.000Z');

  describe('1. Batch Domain Logic & Sanitization', () => {
    it('handles empty batch array gracefully with zeroed metrics', () => {
      const result = evaluateBatch([], { now: fixedNow });

      expect(result.dataProvenance).toBe('SIMULATED_BATCH');
      expect(result.isSimulated).toBe(true);
      expect(result.totalCases).toBe(0);
      expect(result.totalRevenueAtRiskPaise).toBe(0);
      expect(result.totalRevenueAtRiskFormatted).toBe('₹0');
      expect(result.recoveryRate).toBe(0);
      expect(result.highestRiskCases).toEqual([]);
      expect(result.highestValueRecoveries).toEqual([]);
    });

    it('rejects non-array batch payload', () => {
      expect(() => validateBatchInput('not-an-array')).toThrow(BatchValidationError);
      expect(() => validateBatchInput(null)).toThrow(BatchValidationError);
    });

    it('rejects batch exceeding max batch size', () => {
      const items = Array.from({ length: 15 }, (_, i) => ({
        paymentId: `pay_${i}`,
        amount: 100000,
        currency: 'INR'
      }));

      expect(() => validateBatchInput(items, { maxBatchSize: 10 })).toThrow(BatchValidationError);
    });

    it('rejects duplicate paymentId within the same batch', () => {
      const batch = [
        { paymentId: 'pay_dup_1', amount: 100000, currency: 'INR' },
        { paymentId: 'pay_dup_1', amount: 200000, currency: 'INR' }
      ];

      expect(() => validateBatchInput(batch)).toThrow(BatchValidationError);
      expect(() => validateBatchInput(batch)).toThrow(/Duplicate paymentId/);
    });

    it('rejects invalid, negative, or decimal amounts', () => {
      expect(() => validateBatchInput([{ paymentId: 'pay_bad_amt', amount: -500, currency: 'INR' }])).toThrow(/invalid amount/);
      expect(() => validateBatchInput([{ paymentId: 'pay_bad_amt', amount: 0, currency: 'INR' }])).toThrow(/invalid amount/);
      expect(() => validateBatchInput([{ paymentId: 'pay_bad_amt', amount: 1250.75, currency: 'INR' }])).toThrow(/invalid amount/);
      expect(() => validateBatchInput([{ paymentId: 'pay_bad_amt', amount: 'NaN', currency: 'INR' }])).toThrow(/invalid amount/);
    });

    it('rejects non-INR currencies', () => {
      expect(() => validateBatchInput([{ paymentId: 'pay_usd', amount: 100000, currency: 'USD' }])).toThrow(/Only INR is supported/);
      expect(() => validateBatchInput([{ paymentId: 'pay_eur', amount: 100000, currency: 'EUR' }])).toThrow(/Only INR is supported/);
    });

    it('strips client-injected provider verification and execution authority', () => {
      const sanitized = validateBatchInput([{
        paymentId: 'pay_injected',
        amount: 100000,
        currency: 'INR',
        // Malicious injected fields
        recoveredAmount: 100000,
        verified: true,
        executeWithoutPolicy: true,
        providerPaymentId: 'pay_fraud_1'
      }]);

      expect(sanitized[0].recoveredAmount).toBeUndefined();
      expect(sanitized[0].executeWithoutPolicy).toBeUndefined();
      expect(sanitized[0].verified).toBeUndefined();
      expect(sanitized[0].providerPaymentId).toBeUndefined();
    });
  });

  describe('2. Portfolio Evaluation & Strategy Distribution', () => {
    it('accurately evaluates portfolio metrics across diverse case contexts', () => {
      const batch = [
        // Case 1: Standard recoverable transient failure (high confidence -> ALLOW)
        { paymentId: 'pay_std_1', amount: 100000, currency: 'INR', riskLevel: 'HIGH', failureReason: 'gateway_timeout', paymentAttemptCount: 2 },
        // Case 2: High-value case (> ₹25,000) -> escalated
        { paymentId: 'pay_hi_1', amount: 3000000, currency: 'INR', riskLevel: 'HIGH', failureReason: 'gateway_timeout' },
        // Case 3: Recurring mandate failure -> selects SCHEDULE_RETRY_WINDOW
        { paymentId: 'pay_rec_1', amount: 200000, currency: 'INR', riskLevel: 'LOW', failureReason: 'insufficient_funds' },
        // Case 4: Settled/terminal case -> stopped
        { paymentId: 'pay_term_1', amount: 50000, currency: 'INR', riskStatus: 'RESOLVED', failureReason: 'customer_dropoff' }
      ];

      const result = evaluateBatch(batch, { now: fixedNow });

      expect(result.dataProvenance).toBe('SIMULATED_BATCH');
      expect(result.isSimulated).toBe(true);
      expect(result.totalCases).toBe(4);
      expect(result.totalRevenueAtRiskPaise).toBe(3350000); // 100000 + 3000000 + 200000 + 50000
      expect(result.totalRevenueAtRiskFormatted).toBe('₹33,500');

      // Check strategy distribution
      expect(result.strategyDistribution['CREATE_PAYMENT_LINK']).toBeDefined();
      expect(result.strategyDistribution['SCHEDULE_RETRY_WINDOW']).toBeDefined();
      expect(result.strategyDistribution['REQUEST_MANUAL_REVIEW']).toBeDefined();

      // Check counts
      expect(result.executionEligibleCases).toBeGreaterThanOrEqual(1);
      expect(result.escalatedCases).toBeGreaterThanOrEqual(1);
      expect(result.stoppedCases).toBeGreaterThanOrEqual(1);

      // Check ERV calculations
      expect(result.totalExpectedRecoveryValuePaise).toBeGreaterThan(0);
      expect(result.averageExpectedRecoveryValuePaise).toBeGreaterThan(0);

      // Invariant: ERV <= Total Revenue
      expect(result.totalExpectedRecoveryValuePaise).toBeLessThanOrEqual(result.totalRevenueAtRiskPaise);
    });

    it('simulates recovery projections deterministically when requested', () => {
      const batch = [
        { paymentId: 'pay_sim_1', amount: 100000, currency: 'INR', riskLevel: 'HIGH', failureReason: 'gateway_timeout' },
        { paymentId: 'pay_sim_2', amount: 150000, currency: 'INR', riskLevel: 'HIGH', failureReason: 'bank_server_error' }
      ];

      const result = evaluateBatch(batch, { simulateRecoveries: true, now: fixedNow });

      expect(result.simulatedRecoveredCases).toBeGreaterThanOrEqual(1);
      expect(result.simulatedRecoveredRevenuePaise).toBeGreaterThan(0);
      expect(result.recoveryRate).toBeGreaterThan(0);
      expect(result.recoveryRate).toBeLessThanOrEqual(1);
      expect(result.simulatedRecoveredRevenuePaise).toBeLessThanOrEqual(result.totalRevenueAtRiskPaise);
    });

    it('identifies highest risk cases and highest ERV recoveries', () => {
      const batch = [
        { paymentId: 'pay_sm', amount: 50000, currency: 'INR', riskLevel: 'LOW' },
        { paymentId: 'pay_lg', amount: 2000000, currency: 'INR', riskLevel: 'HIGH' },
        { paymentId: 'pay_md', amount: 500000, currency: 'INR', riskLevel: 'MEDIUM' }
      ];

      const result = evaluateBatch(batch, { now: fixedNow });

      expect(result.highestRiskCases.length).toBeGreaterThanOrEqual(1);
      expect(result.highestRiskCases[0].paymentId).toBe('pay_lg');
      expect(result.highestValueRecoveries[0].paymentId).toBe('pay_lg');
    });
  });

  describe('3. POST /api/batch/evaluate API Integration', () => {
    it('returns 200 with valid batch payload and explicit SIMULATED_BATCH provenance', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const res = await request(app)
        .post('/api/batch/evaluate')
        .send({
          cases: [
            { paymentId: 'pay_api_1', amount: 100000, currency: 'INR', failureReason: 'gateway_timeout' },
            { paymentId: 'pay_api_2', amount: 250000, currency: 'INR', failureReason: 'bank_otp_timeout' }
          ]
        })
        .expect(200);

      expect(res.body.dataProvenance).toBe('SIMULATED_BATCH');
      expect(res.body.isSimulated).toBe(true);
      expect(res.body.totalCases).toBe(2);
      expect(res.body.totalRevenueAtRiskPaise).toBe(350000);
      expect(res.body.totalRevenueAtRiskFormatted).toBe('₹3,500');
    });

    it('returns 400 when cases array is missing', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const res = await request(app)
        .post('/api/batch/evaluate')
        .send({})
        .expect(400);

      expect(res.body.error).toBe('BAD_REQUEST');
    });

    it('returns 413 when batch size exceeds maximum limit', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const largeBatch = Array.from({ length: 600 }, (_, i) => ({
        paymentId: `pay_huge_${i}`,
        amount: 100000,
        currency: 'INR'
      }));

      const res = await request(app)
        .post('/api/batch/evaluate')
        .send({ cases: largeBatch })
        .expect(413);

      expect(res.body.error).toBe('BatchValidationError');
      expect(res.body.message).toContain('exceeds maximum limit');
    });

    it('returns 422 when batch contains duplicate payment IDs', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const res = await request(app)
        .post('/api/batch/evaluate')
        .send({
          cases: [
            { paymentId: 'pay_same', amount: 100000, currency: 'INR' },
            { paymentId: 'pay_same', amount: 100000, currency: 'INR' }
          ]
        })
        .expect(422);

      expect(res.body.error).toBe('BatchValidationError');
      expect(res.body.message).toContain('Duplicate paymentId');
    });

    it('returns 422 when batch item has invalid non-integer amount', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const res = await request(app)
        .post('/api/batch/evaluate')
        .send({
          cases: [
            { paymentId: 'pay_invalid_curr', amount: 1200.50, currency: 'INR' }
          ]
        })
        .expect(422);

      expect(res.body.error).toBe('BatchValidationError');
      expect(res.body.message).toContain('invalid amount');
    });

    it('returns 422 when batch item has unsupported currency', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const res = await request(app)
        .post('/api/batch/evaluate')
        .send({
          cases: [
            { paymentId: 'pay_usd_curr', amount: 100000, currency: 'USD' }
          ]
        })
        .expect(422);

      expect(res.body.error).toBe('BatchValidationError');
      expect(res.body.message).toContain('Only INR is supported');
    });

    it('returns 200 with zeroed metrics for empty array cases: []', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const res = await request(app)
        .post('/api/batch/evaluate')
        .send({ cases: [] })
        .expect(200);

      expect(res.body.dataProvenance).toBe('SIMULATED_BATCH');
      expect(res.body.isSimulated).toBe(true);
      expect(res.body.totalCases).toBe(0);
      expect(res.body.totalRevenueAtRiskPaise).toBe(0);
    });

    it('returns 400 when cases is not an array', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const res = await request(app)
        .post('/api/batch/evaluate')
        .send({ cases: 'invalid-string' })
        .expect(400);

      expect(res.body.error).toBe('BatchValidationError');
      expect(res.body.message).toContain('must contain a "cases" array');
    });

    it('returns 422 when paymentId exceeds 128 characters', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const longPaymentId = 'pay_' + 'x'.repeat(130);
      const res = await request(app)
        .post('/api/batch/evaluate')
        .send({
          cases: [{ paymentId: longPaymentId, amount: 100000, currency: 'INR' }]
        })
        .expect(422);

      expect(res.body.error).toBe('BatchValidationError');
      expect(res.body.message).toContain('exceeds maximum length of 128');
    });

    it('caps client-supplied maxBatchSize at MAX_BATCH_SIZE (500)', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const largeBatch = Array.from({ length: 501 }, (_, i) => ({
        paymentId: `pay_huge_${i}`,
        amount: 100000,
        currency: 'INR'
      }));

      // Even if client passes options.maxBatchSize = 999999, server still enforces 500 ceiling
      const res = await request(app)
        .post('/api/batch/evaluate')
        .send({ cases: largeBatch, options: { maxBatchSize: 999999 } })
        .expect(413);

      expect(res.body.error).toBe('BatchValidationError');
      expect(res.body.message).toContain('exceeds maximum limit of 500 items');
    });
  });
});

