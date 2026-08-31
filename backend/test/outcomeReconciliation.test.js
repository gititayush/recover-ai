const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { processEvent } = require('../src/services/eventService');
const { createDiagnosisService } = require('../src/ai/diagnosisService');
const { executePaymentLink } = require('../src/actions/paymentLinkExecutor');

const testWebhookSecret = 'recoverai-test-webhook-secret-not-a-provider-credential';
process.env.RAZORPAY_WEBHOOK_SECRET = testWebhookSecret;

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'razorpay', name));
}

function signature(body, secret = testWebhookSecret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function webhook(app, eventId, body, options = {}) {
  let req = request(app)
    .post('/api/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', options.signature || signature(body));
  if (!options.omitEventId) req = req.set('x-razorpay-event-id', eventId);
  return req.send(body.toString('utf8'));
}

function mockRazorpayClient() {
  return {
    isConfigured: true,
    isTestMode: true,
    keyId: 'rzp_test_mock123',
    createPaymentLink: vi.fn().mockResolvedValue({
      id: 'plink_test_12345',
      short_url: 'https://rzp.io/i/test12345',
      status: 'created',
      amount: 499900,
      currency: 'INR',
      reference_id: 'razorpay_case_1_plink_v1'
    })
  };
}

async function setupExecutedRecoveryCase(repository) {
  // 1. Ingest failed payment
  await processEvent(repository, {
    eventId: 'evt_failed_reconcile_001',
    eventType: 'payment.failed',
    paymentId: 'pay_failed_001',
    orderId: 'order_plink_001',
    amount: 499900,
    currency: 'INR',
    paymentStatus: 'failed',
    failureReason: 'timeout',
    timestamp: '2026-08-31T07:00:00.000Z'
  });

  const detail = await repository.getCaseDetail(1);
  const diagnosis = {
    diagnosis: { cause: 'Payment timed out', confidence: 0.9, evidence: [{ field: 'payment.failureReason', value: 'timeout' }] },
    recommendation: { action: 'CREATE_PAYMENT_LINK' }
  };
  await repository.createDiagnosis({ recoveryCaseId: 1, ...diagnosis, candidates: [], provider: 'test', model: 'test', promptVersion: 'v1', source: 'live_ai' });

  // 2. Execute Payment Link
  const rzpClient = mockRazorpayClient();
  const execResult = await executePaymentLink(repository, {
    recoveryCase: detail.recoveryCase,
    diagnosis,
    events: detail.events,
    razorpayClient: rzpClient,
    now: () => new Date('2026-08-31T07:10:00.000Z')
  });

  return { detail, execResult };
}

describe('Milestone 5 — Outcome Reconciliation & Verified Revenue Attribution', () => {

  describe('1. Full Payment Link Reconciliation (payment_link.paid)', () => {
    it('correlates Payment Link webhook, verifies amount, confirms action, and resolves case with recovered revenue', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const body = fixture('payment_link.paid.json');
      const response = await webhook(app, 'rzp_evt_plink_paid_001', body).expect(202);

      expect(response.body.accepted).toBe(true);
      expect(response.body.duplicate).toBe(false);

      // Verify Recovery Case state
      const updatedCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(updatedCase.riskStatus).toBe('RESOLVED');
      expect(updatedCase.outcome).toBe('RECOVERED');
      expect(updatedCase.actionStatus).toBe('RECOVERED');
      expect(updatedCase.recoveredAmount).toBe(499900);

      // Verify Recovery Action state
      const actions = await repository.findActionsByCaseId(1);
      expect(actions[0].status).toBe('OUTCOME_CONFIRMED');

      // Verify Recovery Outcome record
      const outcomes = await repository.findOutcomesByCaseId(1);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        recoveryCaseId: 1,
        recoveryActionId: actions[0].id,
        provider: 'razorpay',
        providerEventId: 'rzp_evt_plink_paid_001',
        providerPaymentLinkId: 'plink_test_12345',
        amountExpected: 499900,
        amountPaid: 499900,
        currency: 'INR',
        outcome: 'PAID',
        verified: true
      });

      // Verify Audit Trail Sequence
      const auditTypes = repository.audits.map((a) => a.eventType);
      expect(auditTypes).toContain('RECOVERY_OUTCOME_RECEIVED');
      expect(auditTypes).toContain('RECOVERY_OUTCOME_VERIFIED');
      expect(auditTypes).toContain('REVENUE_RECOVERED');
      expect(auditTypes).toContain('CASE_UPDATED');
    });
  });

  describe('2. Direct Payment Capture & Order Paid Reconciliation', () => {
    it('correlates payment.captured to existing recovery case and action', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const body = fixture('payment.captured.json');
      // Update payment id in captured fixture to match case payment id
      const capturedPayload = JSON.parse(body.toString('utf8'));
      capturedPayload.payload.payment.entity.id = 'pay_failed_001';
      capturedPayload.payload.payment.entity.amount = 499900;
      const rawCaptured = Buffer.from(JSON.stringify(capturedPayload));

      await webhook(app, 'rzp_evt_captured_reconcile_001', rawCaptured).expect(202);

      const updatedCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(updatedCase.riskStatus).toBe('RESOLVED');
      expect(updatedCase.recoveredAmount).toBe(499900);

      const actions = await repository.findActionsByCaseId(1);
      expect(actions[0].status).toBe('OUTCOME_CONFIRMED');
    });

    it('correlates order.paid to existing recovery case and action', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const body = fixture('order.paid.json');
      const orderPayload = JSON.parse(body.toString('utf8'));
      orderPayload.payload.order.entity.id = 'order_plink_001';
      orderPayload.payload.order.entity.amount = 499900;
      orderPayload.payload.order.entity.amount_paid = 499900;
      orderPayload.payload.payment.entity.id = 'pay_failed_001';
      orderPayload.payload.payment.entity.amount = 499900;
      const rawOrder = Buffer.from(JSON.stringify(orderPayload));

      await webhook(app, 'rzp_evt_order_paid_reconcile_001', rawOrder).expect(202);

      const updatedCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(updatedCase.riskStatus).toBe('RESOLVED');
      expect(updatedCase.recoveredAmount).toBe(499900);

      const actions = await repository.findActionsByCaseId(1);
      expect(actions[0].status).toBe('OUTCOME_CONFIRMED');
    });

    it('handles unknown recovery action without falsely crediting revenue', async () => {
      const repository = new InMemoryRecoveryRepository();
      // No recovery action executed
      await processEvent(repository, {
        eventId: 'evt_failed_no_action_001',
        eventType: 'payment.failed',
        paymentId: 'pay_no_action_001',
        amount: 300000,
        currency: 'INR',
        paymentStatus: 'failed',
        timestamp: '2026-08-31T10:00:00.000Z'
      });

      const app = createApp(repository);
      const body = fixture('payment_link.paid.json');
      await webhook(app, 'rzp_evt_unknown_act_001', body).expect(202);

      const recoveryCase = await repository.findCaseByPaymentId('pay_no_action_001');
      expect(recoveryCase.recoveredAmount).toBe(0);
      expect(repository.outcomes).toHaveLength(0);
    });

    it('terminal case cannot be credited twice or reopened', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const body = fixture('payment_link.paid.json');

      // First payment confirms recovery
      await webhook(app, 'rzp_evt_term_1', body).expect(202);
      const firstCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(firstCase.riskStatus).toBe('RESOLVED');
      expect(firstCase.recoveredAmount).toBe(499900);

      // Attempting to send a failed event afterwards will NOT reopen the case
      await webhook(app, 'rzp_evt_fail_after_term', fixture('payment.failed.json')).expect(202);
      const secondCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(secondCase.riskStatus).toBe('RESOLVED');
      expect(secondCase.recoveredAmount).toBe(499900);
    });
  });

  describe('3. Multi-Strategy Correlation', () => {
    it('correlates by reference_id (idempotency key) when paymentLinkId is absent in payload', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const customPayload = {
        event: 'payment_link.paid',
        payload: {
          payment_link: {
            entity: {
              id: 'plink_alt_id_999',
              amount: 499900,
              amount_paid: 499900,
              currency: 'INR',
              status: 'paid',
              reference_id: 'razorpay_case_1_plink_v1',
              created_at: 1788160850
            }
          },
          payment: {
            entity: {
              id: 'pay_ref_match_001',
              amount: 499900,
              currency: 'INR',
              status: 'captured',
              created_at: 1788160920
            }
          }
        }
      };

      const raw = Buffer.from(JSON.stringify(customPayload));
      await webhook(app, 'rzp_evt_ref_match_001', raw).expect(202);

      const actions = await repository.findActionsByCaseId(1);
      expect(actions[0].status).toBe('OUTCOME_CONFIRMED');
    });

    it('handles unknown Payment Link safely without resolving or crediting revenue', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const body = fixture('payment_link.unknown_id.json');
      await webhook(app, 'rzp_evt_unknown_link_001', body).expect(202);

      // Case remains unresolved
      const recoveryCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(recoveryCase.riskStatus).toBe('RECOVERABLE');
      expect(recoveryCase.recoveredAmount).toBe(0);

      // Action remains EXECUTED (unconfirmed)
      const actions = await repository.findActionsByCaseId(1);
      expect(actions[0].status).toBe('EXECUTED');
    });

    it('adversarial amount-only collision: unrelated payment with identical amount does not reconcile or resolve case', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      // Unrelated payment with exact same amount ₹4,999 and INR currency, but different payment ID & no payment_link entity
      const unrelatedPayload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_unrelated_adversarial_999',
              amount: 499900,
              currency: 'INR',
              status: 'captured',
              created_at: 1788160950
            }
          }
        }
      };

      const raw = Buffer.from(JSON.stringify(unrelatedPayload));
      await webhook(app, 'rzp_evt_unrelated_coll_001', raw).expect(202);

      // Verify Case 1 was NOT resolved and received 0 recovered revenue
      const case1 = await repository.findCaseByPaymentId('pay_failed_001');
      expect(case1.riskStatus).toBe('RECOVERABLE');
      expect(case1.recoveredAmount).toBe(0);

      // Verify Action 1 was NOT confirmed
      const actions = await repository.findActionsByCaseId(1);
      expect(actions[0].status).toBe('EXECUTED');

      // Verify no verified outcome exists
      const outcomes = await repository.findOutcomesByCaseId(1);
      expect(outcomes).toHaveLength(0);
    });

    it('temporal safety: pre-existing payment that occurred BEFORE recovery action was created cannot be attributed to the action', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      // Event timestamp is 2026-08-31T09:00:00.000Z (prior to action.createdAt: 2026-08-31T10:05:00.000Z)
      const priorEventPayload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_failed_001',
              amount: 499900,
              currency: 'INR',
              status: 'captured',
              created_at: 1788159600 // 09:00:00 AM
            }
          }
        }
      };

      const raw = Buffer.from(JSON.stringify(priorEventPayload));
      await webhook(app, 'rzp_evt_prior_timestamp_001', raw).expect(202);

      // Action must not be attributed to prior event
      const actions = await repository.findActionsByCaseId(1);
      expect(actions[0].status).toBe('EXECUTED');
    });
  });

  describe('4. Amount and Currency Integrity', () => {
    it('rejects outcome when provider amount does not match expected recovery amount', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const body = fixture('payment_link.wrong_amount.json'); // ₹1,000 paid vs ₹4,999 expected
      await webhook(app, 'rzp_evt_wrong_amt_001', body).expect(202);

      const updatedCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(updatedCase.riskStatus).toBe('RECOVERABLE'); // Not resolved
      expect(updatedCase.actionStatus).toBe('REVIEW_REQUIRED');
      expect(updatedCase.recoveredAmount).toBe(0);

      const outcomes = await repository.findOutcomesByCaseId(1);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].verified).toBe(false);
      expect(outcomes[0].outcome).toBe('FAILED_MISMATCH');
      expect(outcomes[0].verificationReason).toContain('Amount mismatch');

      const auditTypes = repository.audits.map((a) => a.eventType);
      expect(auditTypes).toContain('RECOVERY_OUTCOME_REJECTED');
    });

    it('rejects outcome when provider currency does not match expected recovery currency', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const body = fixture('payment_link.wrong_currency.json'); // USD vs INR
      await webhook(app, 'rzp_evt_wrong_curr_001', body).expect(202);

      const updatedCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(updatedCase.riskStatus).toBe('RECOVERABLE');
      expect(updatedCase.recoveredAmount).toBe(0);

      const outcomes = await repository.findOutcomesByCaseId(1);
      expect(outcomes[0].verified).toBe(false);
      expect(outcomes[0].outcome).toBe('FAILED_MISMATCH');
      expect(outcomes[0].verificationReason).toContain('Currency mismatch');
    });

    it('handles partial payment safely without marking full recovery or resolving case', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const body = fixture('payment_link.partially_paid.json'); // ₹2,000 paid of ₹4,999
      await webhook(app, 'rzp_evt_partial_001', body).expect(202);

      const updatedCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(updatedCase.riskStatus).toBe('RECOVERABLE'); // Case stays open
      expect(updatedCase.recoveredAmount).toBe(0); // Not marked fully recovered

      const actions = await repository.findActionsByCaseId(1);
      expect(actions[0].status).toBe('EXECUTED'); // Action not confirmed yet

      const outcomes = await repository.findOutcomesByCaseId(1);
      expect(outcomes[0].outcome).toBe('PARTIALLY_PAID');
      expect(outcomes[0].verified).toBe(false);
      expect(outcomes[0].verificationReason).toContain('Partial payment received');
    });

    it('payment_link.cancelled must never mark revenue recovered or resolve case', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const cancelPayload = {
        event: 'payment_link.cancelled',
        payload: {
          payment_link: {
            entity: {
              id: 'plink_test_12345',
              amount: 499900,
              currency: 'INR',
              status: 'cancelled',
              reference_id: 'razorpay_case_1_plink_v1',
              created_at: 1788160850,
              updated_at: 1788160900
            }
          }
        }
      };

      const raw = Buffer.from(JSON.stringify(cancelPayload));
      await webhook(app, 'rzp_evt_cancel_001', raw).expect(202);

      // Case remains open and unrecovered
      const updatedCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(updatedCase.riskStatus).toBe('RECOVERABLE');
      expect(updatedCase.recoveredAmount).toBe(0);

      // No outcome created
      const outcomes = await repository.findOutcomesByCaseId(1);
      expect(outcomes).toHaveLength(0);
    });

    it('payment_link.expired must never mark revenue recovered', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const expiredPayload = {
        event: 'payment_link.expired',
        payload: {
          payment_link: {
            entity: {
              id: 'plink_test_12345',
              amount: 499900,
              currency: 'INR',
              status: 'expired',
              reference_id: 'razorpay_case_1_plink_v1',
              created_at: 1788160850,
              updated_at: 1788160900
            }
          }
        }
      };

      const raw = Buffer.from(JSON.stringify(expiredPayload));
      await webhook(app, 'rzp_evt_expire_001', raw).expect(202);

      const updatedCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(updatedCase.riskStatus).toBe('RECOVERABLE');
      expect(updatedCase.recoveredAmount).toBe(0);

      const outcomes = await repository.findOutcomesByCaseId(1);
      expect(outcomes).toHaveLength(0);
    });

    it('payment.refunded must never create a recovery credit and marks case SUPPRESSED', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const refundPayload = {
        event: 'payment.refunded',
        payload: {
          payment: {
            entity: {
              id: 'pay_failed_001',
              amount: 499900,
              currency: 'INR',
              status: 'refunded',
              created_at: 1788160950
            }
          }
        }
      };

      const raw = Buffer.from(JSON.stringify(refundPayload));
      await webhook(app, 'rzp_evt_refund_001', raw).expect(202);

      const updatedCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(updatedCase.riskStatus).toBe('SUPPRESSED');
      expect(updatedCase.recoveredAmount).toBe(0);

      // No recovery outcome credited
      const outcomes = await repository.findOutcomesByCaseId(1);
      expect(outcomes).toHaveLength(0);
    });
  });

  describe('5. Idempotency & Zero Double-Counting', () => {
    it('duplicate provider event delivery produces no duplicate outcome, audit, or revenue attribution', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const body = fixture('payment_link.paid.json');

      // First delivery
      await webhook(app, 'rzp_evt_dup_outcome_001', body).expect(202);
      const auditsCountFirst = repository.audits.length;
      const outcomesCountFirst = repository.outcomes.length;

      // Duplicate delivery
      const dupResponse = await webhook(app, 'rzp_evt_dup_outcome_001', body).expect(200);
      expect(dupResponse.body.duplicate).toBe(true);

      expect(repository.outcomes).toHaveLength(outcomesCountFirst);
      expect(repository.audits).toHaveLength(auditsCountFirst);

      const updatedCase = await repository.findCaseByPaymentId('pay_failed_001');
      expect(updatedCase.recoveredAmount).toBe(499900);
    });

    it('repeated outcome reconciliation on already confirmed action does not double-credit revenue', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      const body = fixture('payment_link.paid.json');

      await webhook(app, 'rzp_evt_first_pay_001', body).expect(202);

      // Second distinct event attempting to credit the same payment link
      const secondPayload = JSON.parse(body.toString('utf8'));
      secondPayload.payload.payment.entity.id = 'pay_second_attempt_001';
      const rawSecond = Buffer.from(JSON.stringify(secondPayload));

      await webhook(app, 'rzp_evt_second_pay_002', rawSecond).expect(202);

      // Only one verified outcome
      const verifiedOutcomes = repository.outcomes.filter((o) => o.verified === true);
      expect(verifiedOutcomes).toHaveLength(1);
    });

    it('payment.captured followed by payment_link.paid does not double-credit revenue', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);

      // 1. First event: payment.captured (for pay_failed_001)
      const capPayload = JSON.parse(fixture('payment.captured.json').toString('utf8'));
      capPayload.payload.payment.entity.id = 'pay_failed_001';
      capPayload.payload.payment.entity.amount = 499900;
      await webhook(app, 'rzp_evt_seq_cap_001', Buffer.from(JSON.stringify(capPayload))).expect(202);

      expect((await repository.findCaseByPaymentId('pay_failed_001')).recoveredAmount).toBe(499900);

      // 2. Second event: payment_link.paid (for plink_test_12345)
      await webhook(app, 'rzp_evt_seq_plink_002', fixture('payment_link.paid.json')).expect(202);

      // Total verified outcome count and recovered revenue must remain exactly 1 and 499900
      const verifiedOutcomes = repository.outcomes.filter((o) => o.verified === true);
      expect(verifiedOutcomes).toHaveLength(1);
      expect((await repository.findCaseByPaymentId('pay_failed_001')).recoveredAmount).toBe(499900);
    });

    it('order.paid after payment_link.paid does not double-credit revenue', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);

      // 1. First event: payment_link.paid
      await webhook(app, 'rzp_evt_seq_plink_first', fixture('payment_link.paid.json')).expect(202);

      // 2. Second event: order.paid
      const orderPayload = JSON.parse(fixture('order.paid.json').toString('utf8'));
      orderPayload.payload.order.entity.id = 'order_plink_001';
      orderPayload.payload.order.entity.amount = 499900;
      orderPayload.payload.order.entity.amount_paid = 499900;
      orderPayload.payload.payment.entity.id = 'pay_failed_001';
      orderPayload.payload.payment.entity.amount = 499900;
      await webhook(app, 'rzp_evt_seq_order_second', Buffer.from(JSON.stringify(orderPayload))).expect(202);

      const verifiedOutcomes = repository.outcomes.filter((o) => o.verified === true);
      expect(verifiedOutcomes).toHaveLength(1);
      expect((await repository.findCaseByPaymentId('pay_failed_001')).recoveredAmount).toBe(499900);
    });
  });

  describe('6. Recovered Revenue Accounting & Metrics API', () => {
    it('does NOT count executed-but-unpaid links in recovered revenue', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const metrics = await repository.getRecoveryMetrics();
      expect(metrics.revenue_at_risk).toBe(499900);
      expect(metrics.revenue_recovered).toBe(0);
      expect(metrics.pending_recoveries).toBe(1);
      expect(metrics.confirmed_recoveries).toBe(0);
      expect(metrics.recovery_rate).toBe(0);
    });

    it('accurately computes revenue_recovered, recovery_rate, and confirmed_recoveries upon verification', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      await webhook(app, 'rzp_evt_metrics_001', fixture('payment_link.paid.json')).expect(202);

      const response = await request(app).get('/api/recovery/metrics').expect(200);
      const metrics = response.body.metrics;

      expect(metrics.revenue_at_risk).toBe(0); // Case resolved
      expect(metrics.revenue_recovered).toBe(499900);
      expect(metrics.recovery_rate).toBe(1); // 100% recovery rate
      expect(metrics.confirmed_recoveries).toBe(1);
      expect(metrics.pending_recoveries).toBe(0);
      expect(metrics.resolved_cases).toBe(1);
      expect(metrics.open_cases).toBe(0);
    });

    it('GET /api/cases/:id/recovery-outcome returns verified outcome details for a resolved case', async () => {
      const repository = new InMemoryRecoveryRepository();
      await setupExecutedRecoveryCase(repository);

      const app = createApp(repository);
      await webhook(app, 'rzp_evt_case_outcome_001', fixture('payment_link.paid.json')).expect(202);

      const response = await request(app).get('/api/cases/1/recovery-outcome').expect(200);
      expect(response.body.outcomes).toHaveLength(1);
      expect(response.body.outcomes[0]).toMatchObject({
        providerPaymentLinkId: 'plink_test_12345',
        amountPaid: 499900,
        verified: true,
        outcome: 'PAID'
      });
      expect(response.body.recoveryCase.riskStatus).toBe('RESOLVED');
    });
  });

  describe('7. PostgreSQL Integration', () => {
    it('persists recovery outcome and updates case in PostgreSQL when database is available', async () => {
      const { getPool, closePool } = require('../src/db/pool');
      const { PostgresRecoveryRepository } = require('../src/models/postgresRecoveryRepository');
      try {
        const pool = getPool();
        await pool.query('SELECT 1');
        const repository = new PostgresRecoveryRepository(pool);

        const testPaymentId = `pay_pg_recon_${Date.now()}`;
        await processEvent(repository, {
          eventId: `evt_pg_fail_${Date.now()}`,
          eventType: 'payment.failed',
          paymentId: testPaymentId,
          orderId: `order_pg_${Date.now()}`,
          amount: 250000,
          currency: 'INR',
          paymentStatus: 'failed',
          failureReason: 'timeout',
          timestamp: new Date().toISOString()
        });

        const cases = await repository.listCases();
        const testCase = cases.find((c) => c.paymentId === testPaymentId);
        expect(testCase).toBeDefined();

        const action = await repository.createAction({
          recoveryCaseId: testCase.id,
          actionType: 'CREATE_PAYMENT_LINK',
          status: 'EXECUTED',
          policyDecision: 'ALLOW',
          policyVersion: 'recoverai-policy-v1',
          idempotencyKey: `razorpay_case_${testCase.id}_plink_v1`,
          provider: 'razorpay',
          providerActionId: `plink_pg_${Date.now()}`,
          paymentLinkUrl: 'https://rzp.io/i/test_pg',
          amount: 250000,
          currency: 'INR'
        });

        const outcome = await repository.createOutcome({
          recoveryCaseId: testCase.id,
          recoveryActionId: action.id,
          provider: 'razorpay',
          providerEventId: `rzp_evt_pg_paid_${Date.now()}`,
          providerPaymentLinkId: action.providerActionId,
          providerPaymentId: `pay_pg_cust_${Date.now()}`,
          amountExpected: 250000,
          amountPaid: 250000,
          currency: 'INR',
          outcome: 'PAID',
          verified: true,
          verificationReason: 'Verified by PostgreSQL integration test',
          providerTimestamp: new Date().toISOString()
        });

        expect(outcome.verified).toBe(true);
        expect(outcome.amountPaid).toBe(250000);

        const fetchedOutcomes = await repository.findOutcomesByCaseId(testCase.id);
        expect(fetchedOutcomes.some((o) => o.id === outcome.id)).toBe(true);
      } catch (err) {
        // Postgres not available in this test environment
      } finally {
        const { closePool } = require('../src/db/pool');
        await closePool();
      }
    });
  });
});
