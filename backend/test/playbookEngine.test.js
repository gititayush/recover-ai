const { PlaybookEngine, PlaybookRegistrationError, defaultEngine, playbookEngine } = require('../src/playbooks/playbookEngine');
const paymentDegradationPlaybook = require('../src/playbooks/modules/paymentDegradation');
const checkoutDropOffPlaybook = require('../src/playbooks/modules/checkoutDropOff');
const failedSubscriptionPlaybook = require('../src/playbooks/modules/failedSubscription');
const b2bReceivablesPlaybook = require('../src/playbooks/modules/b2bReceivables');
const { STRATEGY_DEFINITIONS, EXECUTION_MODES, getStrategy } = require('../src/strategies/strategyRegistry');
const { evaluateCandidates } = require('../src/ai/interventionEvaluator');
const { evaluateStoppingCriteria } = require('../src/policy/stoppingEngine');
const { evaluatePolicy } = require('../src/policy/policyEngine');

describe('Revflow V2 — Playbook Engine Coordinator & Extensibility', () => {
  let engine;

  beforeEach(() => {
    engine = new PlaybookEngine();
  });

  // Test 1: payment.failed matches payment_degradation
  it('1. payment.failed matches payment_degradation', () => {
    const event = {
      eventId: 'evt_pay_fail_01',
      eventType: 'payment.failed',
      paymentId: 'pay_123456789',
      amount: 150000,
      currency: 'INR'
    };

    const playbook = engine.identifyPlaybook(event);
    expect(playbook.id).toBe('payment_degradation');
    expect(playbook.flagship).toBe(true);
  });

  // Test 2: checkout event matches checkout_drop_off
  it('2. checkout event matches checkout_drop_off', () => {
    const checkoutEvents = [
      { eventId: 'evt_chk_01', eventType: 'checkout.payment_step_reached', paymentId: 'chk_sess_01', amount: 250000, currency: 'INR' },
      { eventId: 'evt_chk_02', eventType: 'checkout.abandoned', paymentId: 'chk_sess_02', amount: 300000, currency: 'INR' },
      { eventId: 'evt_chk_03', eventType: 'CHECKOUT_DROP_OFF_DETECTED', paymentId: 'chk_sess_03', amount: 450000, currency: 'INR' },
      { eventId: 'evt_chk_04', eventType: 'checkout.started', rawPayload: { checkoutSessionId: 'sess_99' }, paymentId: 'chk_sess_04', amount: 100000, currency: 'INR' }
    ];

    for (const evt of checkoutEvents) {
      const playbook = engine.identifyPlaybook(evt);
      expect(playbook.id).toBe('checkout_drop_off');
    }
  });

  // Test 3: unknown event falls back safely to payment_degradation
  it('3. unknown event falls back safely to payment_degradation', () => {
    const unknownEvents = [
      null,
      undefined,
      {},
      { eventId: 'evt_unk_01', eventType: 'random.unrecognized.event', paymentId: 'p_99' },
      { eventId: 'evt_unk_02', eventType: 'custom_telemetry_ping', paymentId: 'p_100' }
    ];

    for (const evt of unknownEvents) {
      const playbook = engine.identifyPlaybook(evt);
      expect(playbook.id).toBe('payment_degradation');
    }
  });

  // Test 4: correct playbook selected with custom registration and priority
  it('4. correct playbook selected with custom registration and priority', () => {
    expect(engine.list().map((p) => p.id)).toContain('payment_degradation');
    expect(engine.list().map((p) => p.id)).toContain('checkout_drop_off');
    expect(engine.list().map((p) => p.id)).toContain('failed_subscription');
    expect(engine.list().map((p) => p.id)).toContain('b2b_receivables');

    // Register a valid custom playbook
    const customPlaybook = {
      id: 'custom_domain_playbook',
      name: 'Custom Domain Playbook',
      domain: 'Custom Telemetry Domain',
      matchesEvent: (e) => e?.eventType === 'custom.domain.event',
      assessRisk: () => ({ actionable: false }),
      extractContext: () => ({}),
      getCandidateActions: () => ['NO_ACTION'],
      priority: 200
    };
    engine.register(customPlaybook);

    const customEvent = { eventType: 'custom.domain.event', paymentId: 'cust_01' };
    expect(engine.identifyPlaybook(customEvent).id).toBe('custom_domain_playbook');

    // Fallback still works for generic payment
    expect(engine.identifyPlaybook({ eventType: 'payment.failed' }).id).toBe('payment_degradation');
  });

  // Test 5: context extraction un-hallucinated facts
  it('5. playbook context extraction returns strict, un-hallucinated facts', () => {
    const event = {
      eventId: 'evt_chk_ctx_01',
      eventType: 'checkout.payment_step_reached',
      paymentId: 'chk_session_alpha',
      orderId: 'order_test_999',
      amount: 450000,
      currency: 'INR',
      rawPayload: {
        checkoutSessionId: 'chk_session_alpha',
        cartReference: 'cart_ref_001',
        checkoutStage: 'PAYMENT_STEP',
        itemCount: 3,
        paymentMethodAttempt: 'upi',
        abandonmentReason: 'customer hesitated during OTP entry'
      }
    };

    const caseDetail = {
      recoveryCase: {
        id: 1,
        paymentId: 'chk_session_alpha',
        amount: 450000,
        currency: 'INR',
        customerReference: 'cart_ref_001'
      }
    };

    const context = engine.extractContext(event, caseDetail);
    expect(context.playbook).toBe('checkout_drop_off');
    expect(context.checkoutSessionId).toBe('chk_session_alpha');
    expect(context.orderId).toBe('order_test_999');
    expect(context.cartReference).toBe('cart_ref_001');
    expect(context.cartAmount).toBe(450000);
    expect(context.currency).toBe('INR');
    expect(context.checkoutStage).toBe('PAYMENT_STEP');
    expect(context.itemCount).toBe(3);
    expect(context.paymentMethodAttempt).toBe('upi');
    expect(context.abandonmentReason).toBe('customer hesitated during OTP entry');
  });

  // Test 6: candidate strategy generation integrates with Strategy Registry
  it('6. candidate strategy generation integrates with Strategy Registry', () => {
    const context = {
      playbook: 'checkout_drop_off',
      amount: 150000,
      currency: 'INR',
      riskLevel: 'MEDIUM'
    };

    const candidateActions = engine.getCandidateActions(context, 'CHECKOUT_DROPOFF');
    expect(candidateActions).toEqual([
      'CREATE_PAYMENT_LINK',
      'CHECKOUT_RECOVERY',
      'CUSTOMER_OUTREACH',
      'REQUEST_MANUAL_REVIEW',
      'NO_ACTION'
    ]);

    for (const action of candidateActions) {
      const strategy = getStrategy(action);
      expect(strategy).toBeDefined();
      expect(strategy.id).toBe(action);
    }
  });

  // Test 7: execution modes are strictly preserved
  it('7. execution modes are strictly preserved across candidate strategies', () => {
    const strategies = engine.getCandidateActions({ playbook: 'checkout_drop_off' });

    const expectedModes = {
      CREATE_PAYMENT_LINK: EXECUTION_MODES.LIVE_PROVIDER,
      CHECKOUT_RECOVERY: EXECUTION_MODES.SIMULATED,
      CUSTOMER_OUTREACH: EXECUTION_MODES.SIMULATED,
      REQUEST_MANUAL_REVIEW: EXECUTION_MODES.CONTROL,
      NO_ACTION: EXECUTION_MODES.CONTROL
    };

    for (const [actionName, expectedMode] of Object.entries(expectedModes)) {
      const strategy = getStrategy(actionName);
      expect(strategy.executionMode).toBe(expectedMode);
      if (expectedMode === EXECUTION_MODES.LIVE_PROVIDER) {
        expect(strategy.isLiveExecutable).toBe(true);
      } else {
        expect(strategy.isLiveExecutable).toBe(false);
      }
    }
  });

  // Test 8: reuses common control plane
  it('8. reuses common control plane without parallel policy or AI architecture', () => {
    const context = {
      amount: 250000,
      currency: 'INR',
      riskLevel: 'MEDIUM',
      paymentAttemptCount: 1,
      failureReason: 'checkout drop-off'
    };
    const evaluated = evaluateCandidates(context, 'CHECKOUT_DROPOFF');
    expect(evaluated.length).toBeGreaterThan(0);
    expect(evaluated.some((c) => c.action === 'CREATE_PAYMENT_LINK')).toBe(true);
    expect(evaluated.some((c) => c.action === 'CHECKOUT_RECOVERY')).toBe(true);

    const stoppingCase = {
      riskStatus: 'RESOLVED',
      outcome: 'PAID',
      recoveredAmount: 250000
    };
    const stopping = evaluateStoppingCriteria({ recoveryCase: stoppingCase });
    expect(stopping.stopped).toBe(true);
    expect(stopping.actionDisposition).toBe('HARD_STOP');

    const policyDecision = evaluatePolicy({
      recoveryCase: { id: 1, paymentId: 'pay_common_ctrl_001', amount: 250000, currency: 'INR', riskStatus: 'RECOVERABLE' },
      diagnosis: { diagnosis: { confidence: 0.85 } },
      candidateAction: 'CREATE_PAYMENT_LINK',
      isTestMode: true
    });
    expect(policyDecision.policyVersion).toBe('recoverai-policy-v1');
    expect(policyDecision.decision).toBe('ALLOW');
  });

  // Test 9: registration rejects non-object or null playbook
  it('9. registration rejects non-object or null playbook', () => {
    expect(() => engine.register(null)).toThrow(PlaybookRegistrationError);
    expect(() => engine.register(undefined)).toThrow(PlaybookRegistrationError);
    expect(() => engine.register('not-an-object')).toThrow(PlaybookRegistrationError);
  });

  // Test 10: registration rejects missing or empty ID
  it('10. registration rejects missing or empty playbook ID', () => {
    expect(() => engine.register({})).toThrow(PlaybookRegistrationError);
    expect(() => engine.register({ id: '' })).toThrow(PlaybookRegistrationError);
    expect(() => engine.register({ id: '   ' })).toThrow(PlaybookRegistrationError);
  });

  // Test 11: registration rejects duplicate playbook ID
  it('11. registration rejects duplicate playbook ID', () => {
    const duplicate = {
      id: 'checkout_drop_off',
      name: 'Duplicate Checkout',
      domain: 'E-commerce',
      matchesEvent: () => false,
      assessRisk: () => ({}),
      extractContext: () => ({}),
      getCandidateActions: () => ['NO_ACTION']
    };
    expect(() => engine.register(duplicate)).toThrow(PlaybookRegistrationError);
    expect(() => engine.register(duplicate)).toThrow(/Duplicate playbook ID/);
  });

  // Test 12: registration rejects missing metadata
  it('12. registration rejects missing name or domain metadata', () => {
    const base = {
      id: 'incomplete_meta',
      matchesEvent: () => false,
      assessRisk: () => ({}),
      extractContext: () => ({}),
      getCandidateActions: () => ['NO_ACTION']
    };
    expect(() => engine.register({ ...base, domain: 'Domain' })).toThrow(/missing a valid string "name"/);
    expect(() => engine.register({ ...base, name: 'Name' })).toThrow(/missing a valid string "domain"/);
  });

  // Test 13: registration rejects missing required interface methods
  it('13. registration rejects missing required interface methods', () => {
    const base = {
      id: 'missing_methods',
      name: 'Missing Methods Playbook',
      domain: 'Test Domain',
      matchesEvent: () => false,
      assessRisk: () => ({}),
      extractContext: () => ({}),
      getCandidateActions: () => ['NO_ACTION']
    };

    const methods = ['matchesEvent', 'assessRisk', 'extractContext', 'getCandidateActions'];
    for (const method of methods) {
      const copy = { ...base };
      delete copy[method];
      expect(() => engine.register(copy)).toThrow(new RegExp(`missing required interface method "${method}\\(\\)"`));
    }
  });

  // Test 14: registration rejects unknown candidate strategies
  it('14. registration rejects unknown candidate strategies', () => {
    const invalidStrategyPlaybook = {
      id: 'invalid_strategy_playbook',
      name: 'Invalid Strategy Playbook',
      domain: 'Test Domain',
      matchesEvent: () => false,
      assessRisk: () => ({}),
      extractContext: () => ({}),
      getCandidateActions: () => ['NON_EXISTENT_STRATEGY_XYZ']
    };
    expect(() => engine.register(invalidStrategyPlaybook)).toThrow(/references unknown strategy 'NON_EXISTENT_STRATEGY_XYZ'/);
  });

  // Test 15: registration enforces deterministic priority ordering
  it('15. deterministic priority ordering resolves specialized playbooks before fallbacks', () => {
    const highPriorityPlaybook = {
      id: 'high_priority_specialist',
      name: 'High Priority Specialist',
      domain: 'Specialist Domain',
      priority: 500,
      matchesEvent: (e) => e?.eventType === 'shared.event',
      assessRisk: () => ({ actionable: true }),
      extractContext: () => ({}),
      getCandidateActions: () => ['NO_ACTION']
    };

    const lowPriorityPlaybook = {
      id: 'low_priority_specialist',
      name: 'Low Priority Specialist',
      domain: 'Specialist Domain',
      priority: 200,
      matchesEvent: (e) => e?.eventType === 'shared.event',
      assessRisk: () => ({ actionable: true }),
      extractContext: () => ({}),
      getCandidateActions: () => ['NO_ACTION']
    };

    engine.register(lowPriorityPlaybook);
    engine.register(highPriorityPlaybook);

    const event = { eventType: 'shared.event', paymentId: 'p_shared' };
    const matched = engine.identifyPlaybook(event);
    expect(matched.id).toBe('high_priority_specialist');
  });

  // Test 16: all four standard playbooks satisfy registration interface invariants
  it('16. all four core playbooks satisfy complete registration interface invariants', () => {
    const playbooks = [
      paymentDegradationPlaybook,
      checkoutDropOffPlaybook,
      failedSubscriptionPlaybook,
      b2bReceivablesPlaybook
    ];

    for (const pb of playbooks) {
      expect(pb.id).toBeDefined();
      expect(typeof pb.name).toBe('string');
      expect(typeof pb.domain).toBe('string');
      expect(typeof pb.matchesEvent).toBe('function');
      expect(typeof pb.assessRisk).toBe('function');
      expect(typeof pb.extractContext).toBe('function');
      expect(typeof pb.getCandidateActions).toBe('function');

      const candidates = pb.getCandidateActions({});
      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates.length).toBeGreaterThan(0);
      for (const action of candidates) {
        const strategy = getStrategy(action);
        expect(strategy).toBeDefined();
      }
    }
  });
});
