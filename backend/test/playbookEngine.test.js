const { PlaybookEngine, defaultEngine, playbookEngine } = require('../src/playbooks/playbookEngine');
const paymentDegradationPlaybook = require('../src/playbooks/modules/paymentDegradation');
const checkoutDropOffPlaybook = require('../src/playbooks/modules/checkoutDropOff');
const { STRATEGY_DEFINITIONS, EXECUTION_MODES, getStrategy } = require('../src/strategies/strategyRegistry');
const { evaluateCandidates } = require('../src/ai/interventionEvaluator');
const { evaluateStoppingCriteria } = require('../src/policy/stoppingEngine');
const { evaluatePolicy } = require('../src/policy/policyEngine');

describe('Revflow V2 — Playbook Engine Coordinator', () => {
  let engine;

  beforeEach(() => {
    engine = new PlaybookEngine();
  });

  // Test 1
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

  // Test 2
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

  // Test 3
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

  // Test 4
  it('4. correct playbook selected with custom registration and priority', () => {
    expect(engine.list().map((p) => p.id)).toContain('payment_degradation');
    expect(engine.list().map((p) => p.id)).toContain('checkout_drop_off');

    // Register a mock custom playbook
    const customPlaybook = {
      id: 'custom_domain_playbook',
      name: 'Custom Domain Playbook',
      matchesEvent: (e) => e?.eventType === 'custom.domain.event',
      assessRisk: () => ({ actionable: false })
    };
    engine.register(customPlaybook);

    const customEvent = { eventType: 'custom.domain.event', paymentId: 'cust_01' };
    expect(engine.identifyPlaybook(customEvent).id).toBe('custom_domain_playbook');

    // Fallback still works for generic payment
    expect(engine.identifyPlaybook({ eventType: 'payment.failed' }).id).toBe('payment_degradation');
  });

  // Test 5
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

  // Test 6
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

    // Ensure all returned candidate actions exist in STRATEGY_DEFINITIONS
    for (const action of candidateActions) {
      const strategy = getStrategy(action);
      expect(strategy).toBeDefined();
      expect(strategy.id).toBe(action);
    }
  });

  // Test 7
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

  // Test 8
  it('8. reuses common control plane without parallel policy or AI architecture', () => {
    // 1. Reuses shared intervention evaluator
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

    // 2. Reuses common stopping engine
    const stoppingCase = {
      riskStatus: 'RESOLVED',
      outcome: 'PAID',
      recoveredAmount: 250000
    };
    const stopping = evaluateStoppingCriteria({ recoveryCase: stoppingCase });
    expect(stopping.stopped).toBe(true);
    expect(stopping.actionDisposition).toBe('HARD_STOP');

    // 3. Reuses common policy engine
    const policyDecision = evaluatePolicy({
      recoveryCase: { id: 1, paymentId: 'pay_common_ctrl_001', amount: 250000, currency: 'INR', riskStatus: 'RECOVERABLE' },
      diagnosis: { diagnosis: { confidence: 0.85 } },
      candidateAction: 'CREATE_PAYMENT_LINK',
      isTestMode: true
    });
    expect(policyDecision.policyVersion).toBe('recoverai-policy-v1');
    expect(policyDecision.decision).toBe('ALLOW');
  });
});
