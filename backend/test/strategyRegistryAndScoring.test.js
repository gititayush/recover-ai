const {
  EXECUTION_MODES,
  STRATEGY_DEFINITIONS,
  getStrategy,
  listStrategies,
  isLiveExecutable,
  getLiveExecutableStrategies,
  getStrategiesForCategory
} = require('../src/strategies/strategyRegistry');
const {
  HEURISTIC_VERSION,
  computeBaseProbability,
  calculateERV,
  getScoringAssumptions
} = require('../src/strategies/expectedRecoveryValue');
const { evaluateCandidates, rankCandidates } = require('../src/ai/interventionEvaluator');

describe('V2 Next-Best-Action — Strategy Registry', () => {
  it('defines the three mandatory execution modes: LIVE_PROVIDER, SIMULATED, CONTROL', () => {
    expect(EXECUTION_MODES).toEqual({
      LIVE_PROVIDER: 'LIVE_PROVIDER',
      SIMULATED: 'SIMULATED',
      CONTROL: 'CONTROL'
    });
  });

  it('restricts LIVE_PROVIDER execution mode SOLELY to CREATE_PAYMENT_LINK', () => {
    const liveStrategies = getLiveExecutableStrategies();
    expect(liveStrategies).toHaveLength(1);
    expect(liveStrategies[0].id).toBe('CREATE_PAYMENT_LINK');
    expect(liveStrategies[0].executionMode).toBe(EXECUTION_MODES.LIVE_PROVIDER);
    expect(liveStrategies[0].isLiveExecutable).toBe(true);
    expect(liveStrategies[0].provider).toBe('razorpay');
  });

  it('ensures all other candidate actions are strictly SIMULATED or CONTROL', () => {
    const strategies = listStrategies();
    for (const strategy of strategies) {
      if (strategy.id === 'CREATE_PAYMENT_LINK') {
        expect(strategy.executionMode).toBe(EXECUTION_MODES.LIVE_PROVIDER);
        expect(strategy.isLiveExecutable).toBe(true);
      } else if (['REQUEST_MANUAL_REVIEW', 'NO_ACTION'].includes(strategy.id)) {
        expect(strategy.executionMode).toBe(EXECUTION_MODES.CONTROL);
        expect(strategy.isLiveExecutable).toBe(false);
        expect(strategy.provider).toBeNull();
      } else {
        expect(strategy.executionMode).toBe(EXECUTION_MODES.SIMULATED);
        expect(strategy.isLiveExecutable).toBe(false);
        expect(strategy.provider).toBeNull();
      }
    }
  });

  it('returns null for unknown strategy lookups', () => {
    expect(getStrategy('UNKNOWN_STRATEGY')).toBeNull();
    expect(getStrategy(null)).toBeNull();
    expect(isLiveExecutable('NON_EXISTENT')).toBe(false);
  });

  it('filters strategies by applicable failure category', () => {
    const subStrategies = getStrategiesForCategory('FAILED_SUBSCRIPTION');
    const ids = subStrategies.map((s) => s.id);
    expect(ids).toContain('CREATE_PAYMENT_LINK');
    expect(ids).toContain('SCHEDULE_RETRY_WINDOW');
    expect(ids).toContain('REQUEST_MANUAL_REVIEW');

    const terminalStrategies = getStrategiesForCategory('TERMINAL_STATE');
    expect(terminalStrategies.map((s) => s.id)).toContain('NO_ACTION');
    expect(terminalStrategies.map((s) => s.id)).not.toContain('SCHEDULE_RETRY_WINDOW');
  });
});

describe('V2 Next-Best-Action — Expected Recovery Value (ERV) Scoring', () => {
  it('correctly calculates ERV according to the formula: (Amount * Prob) - Cost - Friction', () => {
    // 50,000 paise (₹500), 50% probability, 0 cost, 5% friction (2,500 paise)
    // ERV = (50,000 * 0.5) - 0 - 2,500 = 25,000 - 2,500 = 22,500
    const erv = calculateERV({
      amount: 50000,
      probability: 0.5,
      interventionCost: 0,
      frictionCost: 2500
    });
    expect(erv).toBe(22500);
  });

  it('subtracts operational intervention cost when specified', () => {
    // 50,000 paise, 60% probability (30,000 paise), 500 cost, 1,000 friction
    // ERV = 30,000 - 500 - 1,000 = 28,500
    const erv = calculateERV({
      amount: 50000,
      probability: 0.6,
      interventionCost: 500,
      frictionCost: 1000
    });
    expect(erv).toBe(28500);
  });

  it('handles negative or zero net economic values safely without crashing', () => {
    // Small amount where cost + friction exceeds expected gain
    const erv = calculateERV({
      amount: 1000,
      probability: 0.1, // 100 paise expected
      interventionCost: 2500, // 2,500 paise manual review cost
      frictionCost: 100
    });
    expect(erv).toBe(-2500);
  });

  it('computes contextual base probability grounded in risk and failure context', () => {
    // MEDIUM risk: 0.40 base
    const baseMed = computeBaseProbability({ riskLevel: 'MEDIUM' });
    expect(baseMed).toBe(0.40);

    // MEDIUM risk with timeout in failure reason: 0.40 + 0.10 = 0.50
    const timeoutProb = computeBaseProbability({
      riskLevel: 'MEDIUM',
      failureReason: 'Bank switch timeout during payment'
    });
    expect(timeoutProb).toBe(0.50);

    // HIGH risk with repeat attempts: 0.55 + 0.05 = 0.60
    const repeatProb = computeBaseProbability({
      riskLevel: 'HIGH',
      paymentAttemptCount: 3
    });
    expect(repeatProb).toBe(0.60);

    // Caps at 0.70 ceiling
    const cappedProb = computeBaseProbability({
      riskLevel: 'HIGH',
      failureReason: 'gateway timeout',
      paymentAttemptCount: 3
    });
    expect(cappedProb).toBe(0.70);
  });

  it('discloses transparent heuristic scoring assumptions (isLearnedModel: false)', () => {
    const assumptions = getScoringAssumptions();
    expect(assumptions.heuristicVersion).toBe(HEURISTIC_VERSION);
    expect(assumptions.isLearnedModel).toBe(false);
    expect(assumptions.modelType).toBe('deterministic_heuristic');
    expect(assumptions.note).toContain('not a learned or measured recovery probability');
  });
});

describe('V2 Next-Best-Action — Candidate Evaluation Integration', () => {
  const sampleContext = {
    amount: 100000, // ₹1,000
    riskLevel: 'MEDIUM',
    failureReason: 'Gateway timeout',
    paymentAttemptCount: 1
  };

  it('enriches evaluated candidates with explicit executionMode and isLiveExecutable metadata', () => {
    const candidates = evaluateCandidates(sampleContext, 'TRANSIENT_PAYMENT_FAILURE');
    expect(candidates.length).toBeGreaterThanOrEqual(2);

    const plink = candidates.find((c) => c.action === 'CREATE_PAYMENT_LINK');
    expect(plink).toBeDefined();
    expect(plink.executionMode).toBe(EXECUTION_MODES.LIVE_PROVIDER);
    expect(plink.isLiveExecutable).toBe(true);
    expect(plink.strategyDescription).toContain('Razorpay');

    const review = candidates.find((c) => c.action === 'REQUEST_MANUAL_REVIEW');
    expect(review).toBeDefined();
    expect(review.executionMode).toBe(EXECUTION_MODES.CONTROL);
    expect(review.isLiveExecutable).toBe(false);

    const noAction = candidates.find((c) => c.action === 'NO_ACTION');
    expect(noAction).toBeDefined();
    expect(noAction.executionMode).toBe(EXECUTION_MODES.CONTROL);
    expect(noAction.isLiveExecutable).toBe(false);
  });

  it('correctly sets executionMode for domain-specific simulated actions', () => {
    const subCandidates = evaluateCandidates({ ...sampleContext, playbook: 'failed_subscription' });
    const retry = subCandidates.find((c) => c.action === 'SCHEDULE_RETRY_WINDOW');
    expect(retry).toBeDefined();
    expect(retry.executionMode).toBe(EXECUTION_MODES.SIMULATED);
    expect(retry.isLiveExecutable).toBe(false);

    const vernacularCandidates = evaluateCandidates({ ...sampleContext, playbook: 'hinglish_voice_recovery' });
    const vernacular = vernacularCandidates.find((c) => c.action === 'DISPATCH_VERNACULAR_ASSIST');
    expect(vernacular).toBeDefined();
    expect(vernacular.executionMode).toBe(EXECUTION_MODES.SIMULATED);
    expect(vernacular.isLiveExecutable).toBe(false);

    const promiseCandidates = evaluateCandidates({ ...sampleContext, playbook: 'promise_to_pay' });
    const promise = promiseCandidates.find((c) => c.action === 'RECORD_PROMISE_TO_PAY');
    expect(promise).toBeDefined();
    expect(promise.executionMode).toBe(EXECUTION_MODES.SIMULATED);
    expect(promise.isLiveExecutable).toBe(false);
  });

  it('ranks candidate strategies strictly by Expected Recovery Value descending', () => {
    const candidates = evaluateCandidates(sampleContext, 'TRANSIENT_PAYMENT_FAILURE');
    const ranked = rankCandidates(candidates);
    for (let i = 0; i < ranked.length - 1; i++) {
      expect(ranked[i].estimatedRecoveryValue).toBeGreaterThanOrEqual(ranked[i + 1].estimatedRecoveryValue);
    }
  });
});
