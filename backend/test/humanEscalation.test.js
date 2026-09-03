const request = require('supertest');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { processEvent } = require('../src/services/eventService');
const { createDiagnosisService } = require('../src/ai/diagnosisService');
const { createApp } = require('../src/app');
const { createRecoveryWorker } = require('../src/worker/recoveryWorker');
const { evaluatePolicy } = require('../src/policy/policyEngine');
const { environment } = require('../src/config/env');

const fixedNow = () => new Date('2026-08-31T12:00:00.000Z');

function createMockRazorpayClient(overrides = {}) {
  const existingLinks = new Map();
  return {
    isConfigured: true,
    isTestMode: true,
    keyId: 'rzp_test_mock123',
    createPaymentLink: vi.fn().mockImplementation(async (payload) => {
      const ref = payload.referenceId;
      if (existingLinks.has(ref)) {
        const error = new Error('A payment link with this reference_id already exists.');
        error.statusCode = 400;
        throw error;
      }
      const link = {
        id: `plink_test_${Math.random().toString(36).substring(2, 9)}`,
        short_url: 'https://rzp.io/i/test_link',
        status: 'created',
        amount: payload.amount,
        currency: payload.currency,
        reference_id: ref
      };
      existingLinks.set(ref, link);
      return link;
    }),
    getPaymentLinksByReferenceId: vi.fn().mockImplementation(async (ref) => {
      return existingLinks.has(ref) ? [existingLinks.get(ref)] : [];
    }),
    ...overrides
  };
}

function createMockDiagnosisService(overrides = {}) {
  return {
    diagnose: vi.fn().mockResolvedValue({
      diagnosis: {
        cause: 'High risk exposure requiring human sign-off.',
        confidence: 0.88,
        evidence: [{ field: 'case.amount', value: '5000000' }]
      },
      proposedAction: 'CREATE_PAYMENT_LINK',
      recommendation: {
        action: 'CREATE_PAYMENT_LINK',
        reason: 'Payment link is appropriate subject to operations approval.'
      },
      candidates: [{ action: 'CREATE_PAYMENT_LINK', score: 0.9 }],
      provider: 'test-ai',
      model: 'test-v1',
      promptVersion: 'v1',
      source: 'live_ai',
      ...overrides
    })
  };
}

async function seedCase(repository, overrides = {}) {
  await processEvent(repository, {
    eventId: `evt_esc_${Date.now()}_${Math.random()}`,
    eventType: 'payment.failed',
    paymentId: `pay_esc_${Math.random().toString(36).substring(2, 8)}`,
    orderId: 'order_esc_001',
    amount: 5000000, // ₹50,000 (> ₹25,000 threshold -> REVIEW)
    currency: 'INR',
    paymentStatus: 'failed',
    failureReason: 'timeout',
    timestamp: '2026-08-31T11:00:00.000Z',
    ...overrides
  });
  return repository.getCaseDetail(1);
}

describe('Revflow V2 — Milestone 3: Human Escalation Lifecycle', () => {
  beforeEach(() => {
    environment.AUTONOMOUS_RECOVERY_ENABLED = true;
  });

  // A. REVIEW case enters PENDING_APPROVAL
  it('A. worker transitions REVIEW case to PENDING_APPROVAL with audit event', async () => {
    const repository = new InMemoryRecoveryRepository();
    const detail = await seedCase(repository);
    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      now: fixedNow
    });

    const result = await worker.pollOnce();
    expect(result.processed).toBe(true);
    expect(result.status).toBe('REVIEW_REQUIRED');

    const updatedCase = await repository.findCaseByPaymentId(detail.recoveryCase.paymentId);
    expect(updatedCase.autonomyStatus).toBe('REVIEW_REQUIRED');
    expect(updatedCase.escalationStatus).toBe('PENDING_APPROVAL');
    expect(updatedCase.escalatedAt).toBeDefined();

    const escAudits = repository.audits.filter((a) => a.eventType === 'ESCALATION_TRIGGERED');
    expect(escAudits.length).toBe(1);
    expect(escAudits[0].message).toContain('PENDING_APPROVAL');
  });

  // B. GET /api/cases/escalations returns pending cases
  it('B. GET /api/cases/escalations returns cases waiting for approval', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository, { paymentId: 'pay_esc_pending_1' });
    await repository.updateCase(1, { escalationStatus: 'PENDING_APPROVAL', autonomyStatus: 'REVIEW_REQUIRED' });

    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const res = await request(app).get('/api/cases/escalations').expect(200);
    expect(res.body.escalations).toBeDefined();
    expect(res.body.escalations.length).toBe(1);
    expect(res.body.escalations[0].escalationStatus).toBe('PENDING_APPROVAL');
  });

  // C & E. Valid REVIEW case can be approved, recording reviewer + timestamp
  it('C & E. POST /api/cases/:id/escalations/approve approves valid REVIEW case with reviewer & timestamp', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository, { amount: 5000000 }); // ₹50,000 -> REVIEW
    await repository.updateCase(1, { escalationStatus: 'PENDING_APPROVAL', autonomyStatus: 'REVIEW_REQUIRED' });

    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const res = await request(app)
      .post('/api/cases/1/escalations/approve')
      .send({ reviewer: 'ops_lead_neha', notes: 'Approved high-value recovery after customer verification.' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.escalation.status).toBe('APPROVED');
    expect(res.body.escalation.approvedBy).toBe('ops_lead_neha');
    expect(res.body.escalation.notes).toContain('Approved high-value recovery');
    expect(res.body.executionEligible).toBe(true);

    const updatedCase = await repository.findCaseByPaymentId((await repository.getCaseDetail(1)).recoveryCase.paymentId);
    expect(updatedCase.escalationStatus).toBe('APPROVED');
    expect(updatedCase.approvedBy).toBe('ops_lead_neha');

    const approveAudits = repository.audits.filter((a) => a.eventType === 'ESCALATION_APPROVED');
    expect(approveAudits.length).toBe(1);
  });

  // D & F. Valid REVIEW case can be rejected, recording reviewer + reason
  it('D & F. POST /api/cases/:id/escalations/reject rejects case with reviewer & reason and blocks autonomy', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository);
    await repository.updateCase(1, { escalationStatus: 'PENDING_APPROVAL', autonomyStatus: 'REVIEW_REQUIRED' });

    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const res = await request(app)
      .post('/api/cases/1/escalations/reject')
      .send({ reviewer: 'risk_officer_amit', reason: 'High chargeback risk profile.' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.escalation.status).toBe('REJECTED');
    expect(res.body.escalation.rejectedBy).toBe('risk_officer_amit');
    expect(res.body.escalation.reason).toBe('High chargeback risk profile.');
    expect(res.body.executionEligible).toBe(false);

    const updatedCase = await repository.findCaseByPaymentId((await repository.getCaseDetail(1)).recoveryCase.paymentId);
    expect(updatedCase.escalationStatus).toBe('REJECTED');
    expect(updatedCase.autonomyStatus).toBe('BLOCKED');

    const rejectAudits = repository.audits.filter((a) => a.eventType === 'ESCALATION_REJECTED');
    expect(rejectAudits.length).toBe(1);
  });

  // G. Duplicate approval is handled idempotently
  it('G. duplicate approval is handled idempotently without error', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository);
    await repository.updateCase(1, {
      escalationStatus: 'APPROVED',
      approvedBy: 'ops_lead_neha',
      approvedAt: new Date().toISOString()
    });

    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const res = await request(app)
      .post('/api/cases/1/escalations/approve')
      .send({ reviewer: 'ops_lead_neha', notes: 'Re-approving' })
      .expect(200);

    expect(res.body.alreadyApproved).toBe(true);
  });

  // H, I, J, K, L. Approval of BLOCK cases is REJECTED (Human approval CANNOT override HARD BLOCK)
  it('H & K. human approval CANNOT override terminal payment BLOCK', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository);
    // Add captured event -> terminal_payment rule will trigger BLOCK
    await repository.createEvent({
      eventId: 'evt_captured_test',
      eventType: 'payment.captured',
      paymentId: (await repository.getCaseDetail(1)).recoveryCase.paymentId,
      amount: 5000000,
      currency: 'INR',
      paymentStatus: 'captured',
      timestamp: fixedNow().toISOString()
    });

    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const res = await request(app)
      .post('/api/cases/1/escalations/approve')
      .send({ reviewer: 'ops_lead', notes: 'Attempting to force recovery on captured payment' })
      .expect(422);

    expect(res.body.error).toBe('BLOCK_CANNOT_BE_APPROVED');
    expect(res.body.blockReasons[0]).toContain('terminal');
  });

  it('I. human approval CANNOT override invalid amount or currency BLOCK', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository);
    // Corrupt amount to -100
    await repository.updateCase(1, { amount: -100 });

    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const res = await request(app)
      .post('/api/cases/1/escalations/approve')
      .send({ reviewer: 'ops_lead', notes: 'Attempting override' })
      .expect(422);

    expect(res.body.error).toBe('BLOCK_CANNOT_BE_APPROVED');
  });

  it('J. human approval CANNOT override duplicate active action BLOCK', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository);
    // Insert an active executed action
    await repository.createAction({
      recoveryCaseId: 1,
      actionType: 'CREATE_PAYMENT_LINK',
      status: 'EXECUTED',
      policyDecision: 'ALLOW',
      policyVersion: 'recoverai-policy-v1',
      idempotencyKey: 'plink_dup_key_1',
      provider: 'razorpay',
      amount: 5000000,
      currency: 'INR'
    });

    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const res = await request(app)
      .post('/api/cases/1/escalations/approve')
      .send({ reviewer: 'ops_lead', notes: 'Attempting override on duplicate action' })
      .expect(422);

    expect(res.body.error).toBe('BLOCK_CANNOT_BE_APPROVED');
    expect(res.body.blockReasons[0]).toContain('already exists');
  });

  it('L. human approval CANNOT override already resolved or suppressed case', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository);
    await repository.updateCase(1, { riskStatus: 'RESOLVED', outcome: 'PAID', recoveredAmount: 5000000 });

    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const res = await request(app)
      .post('/api/cases/1/escalations/approve')
      .send({ reviewer: 'ops_lead', notes: 'Attempting override on resolved case' })
      .expect(422);

    expect(res.body.error).toBe('BLOCK_CANNOT_BE_APPROVED');
  });

  // M. Approval re-runs current policy/stopping checks
  it('M. approval endpoint re-runs policy and returns structured humanOverride in policyDecision', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository, { amount: 5000000 }); // High value -> REVIEW

    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    const res = await request(app)
      .post('/api/cases/1/escalations/approve')
      .send({ reviewer: 'ops_director', notes: 'Confirmed VIP customer identity.' })
      .expect(200);

    expect(res.body.policyDecision.decision).toBe('ALLOW');
    expect(res.body.policyDecision.humanOverride).toBeDefined();
    expect(res.body.policyDecision.humanOverride.applied).toBe(true);
    expect(res.body.policyDecision.humanOverride.approvedBy).toBe('ops_director');
  });

  // N. TOCTOU scenario: case is approved, state changes to BLOCK before execution, execution is prevented
  it('N. TOCTOU: approved case cannot execute if state changes to BLOCK before payment execution', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository, { amount: 5000000 });

    // Step 1: Human approves the case
    await repository.updateCase(1, {
      escalationStatus: 'APPROVED',
      approvedBy: 'ops_lead',
      approvedAt: fixedNow().toISOString()
    });

    // Step 2: Concurrently, customer pays externally before recovery execution runs!
    await repository.createEvent({
      eventId: 'evt_toctou_paid',
      eventType: 'payment.captured',
      paymentId: (await repository.getCaseDetail(1)).recoveryCase.paymentId,
      amount: 5000000,
      currency: 'INR',
      paymentStatus: 'captured',
      timestamp: fixedNow().toISOString()
    });

    const mockClient = createMockRazorpayClient();
    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: mockClient
    });

    // Step 3: Attempt execution on the approved case
    const res = await request(app).post('/api/cases/1/recovery-actions').expect(422);
    expect(res.body.message).toContain('terminal');

    // Razorpay client MUST NOT be called!
    expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
  });

  // O. Approved case executes successfully when final checks return ALLOW
  it('O. approved high-value case executes successfully when final checks return ALLOW', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository, { amount: 5000000 }); // ₹50,000 (would normally REVIEW)

    // Approve the case
    await repository.updateCase(1, {
      escalationStatus: 'APPROVED',
      approvedBy: 'ops_lead_neha',
      approvedAt: fixedNow().toISOString()
    });

    const mockClient = createMockRazorpayClient();
    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: mockClient
    });

    const res = await request(app).post('/api/cases/1/recovery-actions').expect(201);
    expect(res.body.executed).toBe(true);
    expect(mockClient.createPaymentLink).toHaveBeenCalledTimes(1);
  });

  // P & R. Rejected case never executes (API and Worker)
  it('P & R. rejected case is blocked by API and ignored by worker', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository);
    await repository.updateCase(1, {
      escalationStatus: 'REJECTED',
      rejectedBy: 'fraud_ops',
      rejectedAt: fixedNow().toISOString(),
      autonomyStatus: 'BLOCKED'
    });

    const mockClient = createMockRazorpayClient();
    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: mockClient
    });

    // API execution fails closed
    const res = await request(app).post('/api/cases/1/recovery-actions').expect(422);
    expect(res.body.message).toContain('rejected');
    expect(mockClient.createPaymentLink).not.toHaveBeenCalled();

    // Worker poll skips or immediately blocks
    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: mockClient,
      now: fixedNow
    });

    const workerResult = await worker.pollOnce();
    // Since autonomyStatus is BLOCKED, claimNextJob returns NO_JOBS
    expect(workerResult.processed).toBe(false);
    expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
  });

  // Q. Worker does not repeatedly execute PENDING_APPROVAL cases
  it('Q. worker does not claim or repeatedly execute PENDING_APPROVAL cases', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository);
    await repository.updateCase(1, {
      escalationStatus: 'PENDING_APPROVAL',
      autonomyStatus: 'REVIEW_REQUIRED'
    });

    const mockClient = createMockRazorpayClient();
    const worker = createRecoveryWorker({
      repository,
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: mockClient,
      now: fixedNow
    });

    const result = await worker.pollOnce();
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('NO_JOBS');
    expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
  });

  // S. Audit events generated exactly once per real transition
  it('S. audit events are generated cleanly per transition without spam', async () => {
    const repository = new InMemoryRecoveryRepository();
    await seedCase(repository);
    await repository.updateCase(1, { escalationStatus: 'PENDING_APPROVAL', autonomyStatus: 'REVIEW_REQUIRED' });

    const app = createApp(repository, {
      diagnosisService: createMockDiagnosisService(),
      razorpayClient: createMockRazorpayClient()
    });

    // Approve
    await request(app).post('/api/cases/1/escalations/approve').send({ reviewer: 'ops_lead' }).expect(200);

    const approveAudits1 = repository.audits.filter((a) => a.eventType === 'ESCALATION_APPROVED');
    expect(approveAudits1.length).toBe(1);

    // Second approve (idempotent)
    await request(app).post('/api/cases/1/escalations/approve').send({ reviewer: 'ops_lead' }).expect(200);

    const approveAudits2 = repository.audits.filter((a) => a.eventType === 'ESCALATION_APPROVED');
    expect(approveAudits2.length).toBe(1); // Still exactly 1
  });
});
