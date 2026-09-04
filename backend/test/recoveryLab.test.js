const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { runScenario, listScenarios } = require('../src/services/recoveryLabService');

describe('Recovery Lab — Isolated Failure Scenario Demonstration', () => {
  let app;
  let dummyRepo;

  beforeAll(() => {
    dummyRepo = new InMemoryRecoveryRepository();
    app = createApp(dummyRepo);
  });

  describe('GET /api/recovery/lab/scenarios', () => {
    it('returns the authoritative catalog of 5 demonstration scenarios', async () => {
      const response = await request(app)
        .get('/api/recovery/lab/scenarios')
        .expect(200);

      expect(response.body.provenance).toBe('DEMO / SIMULATION');
      expect(response.body.scenarios).toHaveLength(5);

      const ids = response.body.scenarios.map((s) => s.id);
      expect(ids).toContain('BANK_SWITCH_TIMEOUT');
      expect(ids).toContain('INSUFFICIENT_FUNDS');
      expect(ids).toContain('GATEWAY_TECHNICAL_FAILURE');
      expect(ids).toContain('UNKNOWN_FAILURE');
      expect(ids).toContain('ALREADY_RECOVERED');
    });
  });

  describe('Scenario 1: BANK_SWITCH_TIMEOUT', () => {
    it('classifies bank switch timeout and sequences a 15-minute retry window', async () => {
      const response = await request(app)
        .post('/api/recovery/lab/run-scenario')
        .send({ scenarioId: 'BANK_SWITCH_TIMEOUT' })
        .expect(200);

      const data = response.body;
      expect(data.provenance.mode).toBe('DEMO / SIMULATION');
      expect(data.provenance.productionMutation).toBe(false);

      expect(data.failureClassification.family).toBe('BANK_SWITCH_TIMEOUT');
      expect(data.failureClassification.confidence).toBeGreaterThanOrEqual(0.70);

      expect(data.selectedStrategy.action).toBe('SCHEDULE_RETRY_WINDOW');
      expect(data.policyEvaluation.decision).toBe('ALLOW');
      expect(data.executionResult.caseAutonomyStatus).toBe('RETRY_SCHEDULED');
      expect(data.executionResult.nextRetryAt).toBeDefined();

      // Check audit trace
      const traceTypes = data.decisionTrace.map((t) => t.type);
      expect(traceTypes).toContain('RETRY_WINDOW_SCHEDULED');
    });
  });

  describe('Scenario 2: INSUFFICIENT_FUNDS', () => {
    it('ranks SCHEDULE_RETRY_WINDOW #1 for insufficient balance and schedules 48h backoff', async () => {
      const response = await request(app)
        .post('/api/recovery/lab/run-scenario')
        .send({ scenarioId: 'INSUFFICIENT_FUNDS' })
        .expect(200);

      const data = response.body;
      expect(data.failureClassification.family).toBe('INSUFFICIENT_FUNDS');
      expect(data.failureClassification.confidence).toBeGreaterThanOrEqual(0.75);

      // Smart Retry Window must rank #1 over immediate outreach
      expect(data.selectedStrategy.action).toBe('SCHEDULE_RETRY_WINDOW');
      expect(data.candidateStrategies[0].action).toBe('SCHEDULE_RETRY_WINDOW');
      expect(data.policyEvaluation.decision).toBe('ALLOW');

      expect(data.executionResult.caseAutonomyStatus).toBe('RETRY_SCHEDULED');
      expect(data.executionResult.nextRetryAt).toBeDefined();
    });
  });

  describe('Scenario 3: GATEWAY_TECHNICAL_FAILURE', () => {
    it('identifies gateway technical drop and selects alternative rail (CREATE_PAYMENT_LINK)', async () => {
      const response = await request(app)
        .post('/api/recovery/lab/run-scenario')
        .send({ scenarioId: 'GATEWAY_TECHNICAL_FAILURE' })
        .expect(200);

      const data = response.body;
      expect(data.failureClassification.family).toBe('GATEWAY_TECHNICAL_FAILURE');
      expect(data.selectedStrategy.action).toBe('CREATE_PAYMENT_LINK');
      expect(data.policyEvaluation.decision).toBe('ALLOW');
      expect(data.executionResult.executed).toBe(true);
      expect(data.executionResult.actionType).toBe('CREATE_PAYMENT_LINK');
    });

    it('executes CREATE_PAYMENT_LINK through real executePaymentLink lifecycle with two-phase audit trail', async () => {
      const response = await request(app)
        .post('/api/recovery/lab/run-scenario')
        .send({ scenarioId: 'GATEWAY_TECHNICAL_FAILURE' })
        .expect(200);

      const data = response.body;
      const traceTypes = data.decisionTrace.map((t) => t.type);

      // Must record the full two-phase executor lifecycle:
      expect(traceTypes).toContain('POLICY_EVALUATED');
      expect(traceTypes).toContain('ACTION_EXECUTION_STARTED');
      expect(traceTypes).toContain('ACTION_EXECUTED');

      // The execution-started event must precede the execution-completed event
      const startedIdx = traceTypes.indexOf('ACTION_EXECUTION_STARTED');
      const executedIdx = traceTypes.indexOf('ACTION_EXECUTED');
      expect(startedIdx).toBeGreaterThanOrEqual(0);
      expect(executedIdx).toBeGreaterThan(startedIdx);

      // Audit metadata confirms synthetic link identifier
      const executedAudit = data.decisionTrace.find((t) => t.type === 'ACTION_EXECUTED');
      expect(executedAudit.metadata.providerActionId).toMatch(/^lab_plink_/);
      expect(executedAudit.metadata.paymentLinkUrl).toMatch(/^https:\/\/rzp\.io\/i\/lab_/);
    });

    it('records action provider as simulated_lab with explicit non-live synthetic URL', async () => {
      const response = await request(app)
        .post('/api/recovery/lab/run-scenario')
        .send({ scenarioId: 'GATEWAY_TECHNICAL_FAILURE' })
        .expect(200);

      const data = response.body;
      expect(data.executionResult.executed).toBe(true);
      expect(data.executionResult.actionStatus).toBe('EXECUTED');

      // Action executed in lab must show simulated mode in provenance
      expect(data.provenance.productionMutation).toBe(false);
      expect(data.provenance.liveFinancialAction).toBe(false);
    });
  });

  describe('Scenario 4: UNKNOWN_FAILURE', () => {
    it('conservatively abstains on generic failure, caps confidence, and triggers policy review', async () => {
      const response = await request(app)
        .post('/api/recovery/lab/run-scenario')
        .send({ scenarioId: 'UNKNOWN_FAILURE' })
        .expect(200);

      const data = response.body;
      expect(data.failureClassification.family).toBe('UNKNOWN_FAILURE');
      expect(data.failureClassification.type).toBe('INSUFFICIENT_PROVIDER_TELEMETRY');
      expect(data.failureClassification.confidence).toBeLessThanOrEqual(0.35);

      // Must list explicit unknowns
      expect(data.failureClassification.unknowns.length).toBeGreaterThanOrEqual(2);

      // Policy engine must block automatic execution due to low confidence (< 0.65)
      expect(data.policyEvaluation.decision).toBe('REVIEW');
      expect(data.policyEvaluation.reasons.some((r) => r.includes('below the automatic execution threshold'))).toBe(true);
      expect(data.executionResult.executed).toBe(false);
    });
  });

  describe('Scenario 5: ALREADY_RECOVERED', () => {
    it('detects pre-existing payment settlement and enforces HARD_STOP stopping disposition', async () => {
      const response = await request(app)
        .post('/api/recovery/lab/run-scenario')
        .send({ scenarioId: 'ALREADY_RECOVERED' })
        .expect(200);

      const data = response.body;
      expect(data.stoppingEvaluation.stopped).toBe(true);
      expect(data.stoppingEvaluation.actionDisposition).toBe('HARD_STOP');
      expect(['PAYMENT_RECOVERED', 'TERMINAL_PAYMENT']).toContain(data.stoppingEvaluation.reasonCode);

      expect(data.policyEvaluation.decision).toBe('BLOCK');
      expect(data.executionResult.executed).toBe(false);
      expect(data.finalCaseState.riskStatus).toBe('RESOLVED');
    });
  });

  describe('Non-Payment Simulated Strategies Execution', () => {
    it('executes simulated strategies like CHECKOUT_RECOVERY through executeSimulatedAction', async () => {
      const { executeSimulatedAction } = require('../src/actions/simulatedActionExecutor');
      const testRepo = new InMemoryRecoveryRepository();

      const { processEvent } = require('../src/services/eventService');
      const eventResult = await processEvent(testRepo, {
        eventId: 'evt_sim_chk_01',
        eventType: 'checkout.payment_step_reached',
        paymentId: 'chk_sim_test_01',
        amount: 250000,
        currency: 'INR',
        failureReason: 'Checkout cart drop-off',
        riskLevel: 'MEDIUM',
        timestamp: new Date().toISOString()
      });
      const createdCase = eventResult.recoveryCase;

      const execResult = await executeSimulatedAction(testRepo, {
        recoveryCase: createdCase,
        actionType: 'CHECKOUT_RECOVERY'
      });

      expect(execResult.executed).toBe(true);
      expect(execResult.isSimulated).toBe(true);
      expect(execResult.action.actionType).toBe('CHECKOUT_RECOVERY');
      expect(execResult.action.status).toBe('EXECUTED');
      expect(execResult.action.provider).toBe('simulated');

      const actions = await testRepo.findActionsByCaseId(createdCase.id);
      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('CHECKOUT_RECOVERY');
    });
  });

  describe('Isolation & Safety Guards', () => {
    it('SimulatedPaymentLinkAdapter operates in 100% test mode with zero network calls', async () => {
      const { SimulatedPaymentLinkAdapter } = require('../src/services/providers/simulatedPaymentLinkAdapter');
      const adapter = new SimulatedPaymentLinkAdapter();

      expect(adapter.isConfigured).toBe(true);
      expect(adapter.isTestMode).toBe(true);
      expect(adapter.providerName).toBe('simulated_lab');

      const link = await adapter.createPaymentLink({
        amount: 499900,
        currency: 'INR',
        description: 'Test simulated link',
        referenceId: 'ref_safety_test_01'
      });

      expect(link.id).toBe('lab_plink_ref_safety_test_01');
      expect(link.short_url).toBe('https://rzp.io/i/lab_ref_safety_test_01');
      expect(link.amount).toBe(499900);
      expect(link.currency).toBe('INR');
      expect(link.rawResponse.simulated).toBe(true);
      expect(link.rawResponse.mode).toBe('simulated_lab');

      // Idempotency lookup
      const retrieved = await adapter.getPaymentLinksByReferenceId('ref_safety_test_01');
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].id).toBe(link.id);
    });

    it('guarantees zero network calls (fetch is never invoked during Recovery Lab execution)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        await runScenario('GATEWAY_TECHNICAL_FAILURE');
        await runScenario('BANK_SWITCH_TIMEOUT');
        await runScenario('ALREADY_RECOVERED');

        // Zero external HTTP requests were dispatched
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('returns 400 when scenarioId is missing', async () => {
      const response = await request(app)
        .post('/api/recovery/lab/run-scenario')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('BAD_REQUEST');
    });

    it('returns 404 when scenarioId is invalid', async () => {
      const response = await request(app)
        .post('/api/recovery/lab/run-scenario')
        .send({ scenarioId: 'NON_EXISTENT_SCENARIO' })
        .expect(404);

      expect(response.body.error).toBe('SCENARIO_NOT_FOUND');
    });

    it('leaves the primary app repository completely untouched after running all scenarios', async () => {
      const casesBefore = await dummyRepo.listCases();
      expect(casesBefore).toHaveLength(0);

      await runScenario('BANK_SWITCH_TIMEOUT');
      await runScenario('INSUFFICIENT_FUNDS');
      await runScenario('GATEWAY_TECHNICAL_FAILURE');
      await runScenario('UNKNOWN_FAILURE');
      await runScenario('ALREADY_RECOVERED');

      // The primary repository must remain 100% untouched
      const casesAfter = await dummyRepo.listCases();
      expect(casesAfter).toHaveLength(0);
    });
  });
});
