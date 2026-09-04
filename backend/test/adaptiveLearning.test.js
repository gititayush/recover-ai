import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import {
  PRIOR_PSEUDO_COUNT,
  MIN_OBSERVATIONS_THRESHOLD,
  MAX_DELTA,
  MIN_PROBABILITY,
  MAX_PROBABILITY,
  PROVENANCE,
  MODEL_TYPES,
  calculateLearnedProbability,
  extractAttributedOutcomes,
  getProductionLearningModel,
  computeBenchmarkCorpusStatistics,
  buildAdaptiveModelInspection
} from '../src/ai/adaptiveLearningEngine';
import { evaluateCandidates, rankCandidates } from '../src/ai/interventionEvaluator';
import { evaluatePolicy } from '../src/policy/policyEngine';
import { evaluateStoppingCriteria } from '../src/policy/stoppingEngine';
import { InMemoryRecoveryRepository } from '../src/models/inMemoryRecoveryRepository';
import { createApp } from '../src/app';

describe('Adaptive Learning Engine — Bounded Empirical-Bayes', () => {
  // Requirement 1: cold-start returns exact heuristic prior under n < 5
  it('1. cold-start returns exact heuristic prior under n < 5 with COLD_START_HEURISTIC provenance', () => {
    const prior = 0.55;

    for (let n = 0; n < 5; n++) {
      const successes = Math.min(n, 3);
      const failures = n - successes;

      const result = calculateLearnedProbability({
        priorProbability: prior,
        successes,
        failures
      });

      expect(result.learnedProbability).toBe(prior);
      expect(result.priorProbability).toBe(prior);
      expect(result.sampleSize).toBe(n);
      expect(result.successes).toBe(successes);
      expect(result.failures).toBe(failures);
      expect(result.deltaApplied).toBe(0);
      expect(result.provenance).toBe(PROVENANCE.COLD_START_HEURISTIC);
      expect(result.isLearnedModel).toBe(false);
      expect(result.modelType).toBe(MODEL_TYPES.HEURISTIC);
    }
  });

  // Requirement 2: n = 5 activates learning
  it('2. n = 5 activates learning, setting isLearnedModel to true and provenance to PRODUCTION_OUTCOMES', () => {
    const result = calculateLearnedProbability({
      priorProbability: 0.50,
      successes: 4,
      failures: 1
    });

    expect(result.sampleSize).toBe(5);
    expect(result.isLearnedModel).toBe(true);
    expect(result.modelType).toBe(MODEL_TYPES.BOUNDED_BAYES);
    expect(result.provenance).toBe(PROVENANCE.PRODUCTION_OUTCOMES);
    expect(result.deltaApplied).not.toBe(0);
  });

  // Requirement 3: posterior math is correct
  it('3. posterior math matches ((priorCount * priorProbability) + successes) / (priorCount + observations)', () => {
    // prior = 0.50, priorCount = 10, successes = 8, failures = 2 (n = 10)
    // rawPosterior = ((10 * 0.50) + 8) / (10 + 10) = (5 + 8) / 20 = 13 / 20 = 0.65
    // delta = 0.65 - 0.50 = +0.15 (at max delta bound)
    const result = calculateLearnedProbability({
      priorProbability: 0.50,
      successes: 8,
      failures: 2,
      priorCount: 10
    });

    expect(result.learnedProbability).toBe(0.65);
    expect(result.deltaApplied).toBe(0.15);

    // Another exact case: prior = 0.40, priorCount = 10, successes = 5, failures = 5 (n = 10)
    // rawPosterior = ((10 * 0.40) + 5) / (10 + 10) = (4 + 5) / 20 = 9 / 20 = 0.45
    // delta = 0.45 - 0.40 = +0.05
    const result2 = calculateLearnedProbability({
      priorProbability: 0.40,
      successes: 5,
      failures: 5,
      priorCount: 10
    });

    expect(result2.learnedProbability).toBe(0.45);
    expect(result2.deltaApplied).toBe(0.05);
  });

  // Requirement 4: positive outcomes move probability upward
  it('4. positive outcomes move learned probability upward relative to prior', () => {
    const prior = 0.40;
    const result = calculateLearnedProbability({
      priorProbability: prior,
      successes: 8,
      failures: 0
    });

    expect(result.learnedProbability).toBeGreaterThan(prior);
    expect(result.deltaApplied).toBeGreaterThan(0);
  });

  // Requirement 5: negative outcomes move probability downward
  it('5. negative outcomes move learned probability downward relative to prior', () => {
    const prior = 0.60;
    const result = calculateLearnedProbability({
      priorProbability: prior,
      successes: 0,
      failures: 8
    });

    expect(result.learnedProbability).toBeLessThan(prior);
    expect(result.deltaApplied).toBeLessThan(0);
  });

  // Requirement 6: delta cannot exceed +0.15
  it('6. delta cannot exceed +0.15 regardless of extreme positive observations', () => {
    const prior = 0.20;
    // 100 successes would otherwise push probability towards 0.93
    const result = calculateLearnedProbability({
      priorProbability: prior,
      successes: 100,
      failures: 0
    });

    expect(result.deltaApplied).toBe(MAX_DELTA);
    expect(result.learnedProbability).toBe(0.35); // 0.20 + 0.15
  });

  // Requirement 7: delta cannot exceed -0.15
  it('7. delta cannot exceed -0.15 regardless of extreme negative observations', () => {
    const prior = 0.80;
    // 100 failures would otherwise push probability towards 0.07
    const result = calculateLearnedProbability({
      priorProbability: prior,
      successes: 0,
      failures: 100
    });

    expect(result.deltaApplied).toBe(-MAX_DELTA);
    expect(result.learnedProbability).toBe(0.65); // 0.80 - 0.15
  });

  // Requirement 8: probability cannot leave [0.05, 0.95]
  it('8. probability cannot leave absolute safety bounds [0.05, 0.95]', () => {
    // Upper bound test
    const highPriorResult = calculateLearnedProbability({
      priorProbability: 0.92,
      successes: 50,
      failures: 0
    });
    expect(highPriorResult.learnedProbability).toBeLessThanOrEqual(MAX_PROBABILITY);
    expect(highPriorResult.learnedProbability).toBe(0.95);

    // Lower bound test
    const lowPriorResult = calculateLearnedProbability({
      priorProbability: 0.08,
      successes: 0,
      failures: 50
    });
    expect(lowPriorResult.learnedProbability).toBeGreaterThanOrEqual(MIN_PROBABILITY);
    expect(lowPriorResult.learnedProbability).toBe(0.05);
  });

  // Requirement 9: benchmark corpus does not contaminate production model
  it('9. benchmark corpus statistics have explicit BENCHMARK_CORPUS provenance and do not contaminate production model', () => {
    const benchmarkStats = computeBenchmarkCorpusStatistics();
    expect(benchmarkStats.provenance).toBe(PROVENANCE.BENCHMARK_CORPUS);
    expect(benchmarkStats.totalBenchmarkCases).toBeGreaterThanOrEqual(0);

    // Production calculation remains isolated
    const repo = new InMemoryRecoveryRepository();
    const productionResult = calculateLearnedProbability({
      priorProbability: 0.50,
      successes: 6,
      failures: 2,
      source: PROVENANCE.PRODUCTION_OUTCOMES
    });

    expect(productionResult.provenance).toBe(PROVENANCE.PRODUCTION_OUTCOMES);
    expect(productionResult.provenance).not.toBe(PROVENANCE.BENCHMARK_CORPUS);
  });

  // Requirement 10: ambiguous/unattributed outcomes are excluded
  it('10. ambiguous, partial, mismatched, superseded, in-flight, and policy-blocked actions are excluded from successes', () => {
    const cases = [
      { id: 1, paymentId: 'pay_01', riskStatus: 'RESOLVED', outcome: 'RECOVERED', riskReason: 'Bank switch timeout' },
      { id: 2, paymentId: 'pay_02', riskStatus: 'OPEN', outcome: null, riskReason: 'Bank switch timeout' }
    ];

    const actions = [
      // 1. Valid verified execution
      { id: 'act_01', recoveryCaseId: 1, actionType: 'CREATE_PAYMENT_LINK', status: 'OUTCOME_CONFIRMED' },
      // 2. Superseded action (should count as failure, not success)
      { id: 'act_02', recoveryCaseId: 1, actionType: 'CREATE_PAYMENT_LINK', status: 'SUPERSEDED' },
      // 3. Failed provider action
      { id: 'act_03', recoveryCaseId: 1, actionType: 'CREATE_PAYMENT_LINK', status: 'FAILED' },
      // 4. In-flight action on open case (excluded from closed observations)
      { id: 'act_04', recoveryCaseId: 2, actionType: 'CREATE_PAYMENT_LINK', status: 'EXECUTED' },
      // 5. Policy blocked action (excluded from observations)
      { id: 'act_05', recoveryCaseId: 2, actionType: 'CREATE_PAYMENT_LINK', status: 'BLOCKED' }
    ];

    const outcomes = [
      // Valid verified recovery outcome for act_01
      { id: 1, recoveryCaseId: 1, recoveryActionId: 'act_01', verified: true, outcome: 'PAID', amountPaid: 50000 },
      // Superseded ignored outcome for act_02
      { id: 2, recoveryCaseId: 1, recoveryActionId: 'act_02', verified: false, outcome: 'SUPERSEDED_IGNORED', amountPaid: 50000 },
      // Partial payment (unverified full recovery)
      { id: 3, recoveryCaseId: 1, recoveryActionId: 'act_03', verified: false, outcome: 'PARTIALLY_PAID', amountPaid: 10000 },
      // Unmatched outcome (missing recoveryActionId)
      { id: 4, recoveryCaseId: 1, recoveryActionId: null, verified: false, outcome: 'PAID', amountPaid: 50000 }
    ];

    const extracted = extractAttributedOutcomes({ cases, actions, outcomes, diagnoses: [] });

    expect(extracted.summary.attributedSuccesses).toBe(1); // Only act_01
    expect(extracted.summary.attributedFailures).toBe(2); // act_02 (SUPERSEDED) and act_03 (FAILED)
    expect(extracted.summary.inFlightExcluded).toBe(1); // act_04 on OPEN case
    expect(extracted.summary.policyBlockedExcluded).toBe(1); // act_05
    expect(extracted.summary.unverifiedOutcomesCount.unmatched).toBe(1);
    expect(extracted.summary.unverifiedOutcomesCount.superseded).toBe(1);
    expect(extracted.summary.unverifiedOutcomesCount.partial).toBe(1);
  });

  // Requirement 11: policy veto remains unchanged despite learned probability
  it('11. policy veto remains authoritative and unchanged despite learned probability adjustments', () => {
    // Fabricate a model that strongly boosts CREATE_PAYMENT_LINK
    const boostedModel = {
      getProbabilityForPair: ({ action }) => {
        if (action === 'NO_ACTION') {
          return {
            priorProbability: 0,
            learnedProbability: 0,
            sampleSize: 0,
            successes: 0,
            failures: 0,
            deltaApplied: 0,
            provenance: PROVENANCE.COLD_START_HEURISTIC,
            isLearnedModel: false,
            modelType: MODEL_TYPES.HEURISTIC
          };
        }
        return {
          priorProbability: 0.55,
          learnedProbability: 0.70, // Max bounded boost +0.15
          sampleSize: 20,
          successes: 18,
          failures: 2,
          deltaApplied: 0.15,
          provenance: PROVENANCE.PRODUCTION_OUTCOMES,
          isLearnedModel: true,
          modelType: MODEL_TYPES.BOUNDED_BAYES
        };
      }
    };

    const context = {
      caseId: 1,
      amount: 100000,
      riskLevel: 'HIGH',
      failureReason: 'Customer account inactive',
      failureFamily: 'UNKNOWN_FAILURE',
      paymentAttemptCount: 1,
      timeSinceFailureMinutes: 10
    };

    // Candidates evaluated with learned model
    const candidates = evaluateCandidates(context, 'TRANSIENT_PAYMENT_FAILURE', 'UNKNOWN_FAILURE', {
      learningModel: boostedModel
    });

    const topCandidate = rankCandidates(candidates)[0];
    expect(topCandidate.action).toBe('CREATE_PAYMENT_LINK');
    expect(topCandidate.estimatedProbability).toBe(0.70);
    expect(topCandidate.assumptions.isLearnedModel).toBe(true);

    // But now test policy engine enforcement: e.g. Case is in terminal status RESOLVED
    const recoveryCase = {
      id: 1,
      paymentId: 'pay_veto_01',
      currency: 'INR',
      amount: 100000,
      riskLevel: 'HIGH',
      riskStatus: 'RESOLVED',
      actionStatus: 'RECOVERED',
      autonomyStatus: 'INACTIVE',
      lastEventAt: new Date().toISOString()
    };

    const policyResult = evaluatePolicy({
      recoveryCase,
      diagnosis: {
        diagnosis: {
          confidence: 0.90,
          failureFamily: 'UNKNOWN_FAILURE',
          evidence: []
        },
        proposedAction: topCandidate.action,
        recommendation: { action: topCandidate.action }
      },
      candidateAction: topCandidate.action,
      events: [],
      existingActions: [],
      now: () => new Date()
    });

    // Policy Rule 2 (CASE TERMINAL STATUS) MUST still block the action despite high learned probability
    expect(policyResult.decision).toBe('BLOCK');
    expect(policyResult.reasons.some((r) => r.toLowerCase().includes('terminal status resolved'))).toBe(true);
  });

  // Requirement 12: stopping behavior remains unchanged despite learned probability
  it('12. stopping engine behavior remains authoritative and halts execution regardless of learned ERV', () => {
    const recoveryCase = {
      id: 1,
      riskStatus: 'RESOLVED',
      outcome: 'RECOVERED',
      recoveredAmount: 100000
    };

    const stopping = evaluateStoppingCriteria({
      recoveryCase,
      candidateAction: 'CREATE_PAYMENT_LINK',
      events: [],
      existingActions: [],
      now: () => new Date()
    });

    expect(stopping.stopped).toBe(true);
    expect(stopping.reasonCode).toBe('PAYMENT_RECOVERED');
    expect(stopping.actionDisposition).toBe('HARD_STOP');
  });

  // Integration tests for GET /api/recovery/adaptive-model
  describe('Inspection Endpoint: GET /api/recovery/adaptive-model', () => {
    it('returns HTTP 200 with transparent cold-start status on initial baseline', async () => {
      const repository = new InMemoryRecoveryRepository();
      // Seed 3 verified cases (matching production baseline of 3 recoveries)
      await repository.createCase({ id: 1, paymentId: 'pay_01', riskStatus: 'RESOLVED', outcome: 'RECOVERED', amount: 50000 });
      await repository.createAction({ id: 'act_01', idempotencyKey: 'idem_base_01', recoveryCaseId: 1, actionType: 'CREATE_PAYMENT_LINK', status: 'OUTCOME_CONFIRMED', amount: 50000 });
      await repository.createOutcome({ provider: 'razorpay', providerEventId: 'evt_base_01', recoveryCaseId: 1, recoveryActionId: 'act_01', verified: true, outcome: 'PAID', amountPaid: 50000 });

      await repository.createCase({ id: 2, paymentId: 'pay_02', riskStatus: 'RESOLVED', outcome: 'RECOVERED', amount: 50000 });
      await repository.createAction({ id: 'act_02', idempotencyKey: 'idem_base_02', recoveryCaseId: 2, actionType: 'CREATE_PAYMENT_LINK', status: 'OUTCOME_CONFIRMED', amount: 50000 });
      await repository.createOutcome({ provider: 'razorpay', providerEventId: 'evt_base_02', recoveryCaseId: 2, recoveryActionId: 'act_02', verified: true, outcome: 'PAID', amountPaid: 50000 });

      await repository.createCase({ id: 3, paymentId: 'pay_03', riskStatus: 'RESOLVED', outcome: 'RECOVERED', amount: 75000 });
      await repository.createAction({ id: 'act_03', idempotencyKey: 'idem_base_03', recoveryCaseId: 3, actionType: 'CREATE_PAYMENT_LINK', status: 'OUTCOME_CONFIRMED', amount: 75000 });
      await repository.createOutcome({ provider: 'razorpay', providerEventId: 'evt_base_03', recoveryCaseId: 3, recoveryActionId: 'act_03', verified: true, outcome: 'PAID', amountPaid: 75000 });

      // Case 4 is open
      await repository.createCase({ id: 4, paymentId: 'pay_04', riskStatus: 'OPEN', amount: 50000 });
      await repository.createAction({ id: 'act_04', idempotencyKey: 'idem_base_04', recoveryCaseId: 4, actionType: 'CREATE_PAYMENT_LINK', status: 'EXECUTED', amount: 50000 });

      const app = createApp(repository);
      const res = await request(app).get('/api/recovery/adaptive-model');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.modelType).toBe(MODEL_TYPES.BOUNDED_BAYES);
      expect(res.body.summary.primaryProvenance).toBe(PROVENANCE.COLD_START_HEURISTIC);
      expect(res.body.summary.activeLearnedPairsCount).toBe(0);
      expect(res.body.safetyBounds.minObservationsThreshold).toBe(MIN_OBSERVATIONS_THRESHOLD);
      expect(res.body.safetyBounds.maxDelta).toBe(MAX_DELTA);
      expect(res.body.disclaimer).toContain('COLD_START_HEURISTIC');

      // Every pair in pairs array must reflect cold-start
      const paymentLinkPair = res.body.pairs.find(
        (p) => p.strategy === 'CREATE_PAYMENT_LINK' && p.failureFamily === 'UNKNOWN_FAILURE'
      );
      expect(paymentLinkPair).toBeDefined();
      expect(paymentLinkPair.isLearnedModel).toBe(false);
      expect(paymentLinkPair.status).toBe('COLD_START');
      expect(paymentLinkPair.deltaApplied).toBe(0);
    });

    it('activates learning dynamically when observation count reaches threshold of 5', async () => {
      const repository = new InMemoryRecoveryRepository();

      // Seed 5 verified outcomes for SCHEDULE_RETRY_WINDOW on INSUFFICIENT_FUNDS
      for (let i = 1; i <= 5; i++) {
        await repository.createCase({ id: i, paymentId: `pay_${i}`, riskStatus: 'RESOLVED', outcome: 'RECOVERED', riskReason: 'Insufficient account balance' });
        await repository.createAction({ id: `act_${i}`, idempotencyKey: `idem_dyn_${i}`, recoveryCaseId: i, actionType: 'SCHEDULE_RETRY_WINDOW', status: 'OUTCOME_CONFIRMED', amount: 200000 });
        await repository.createOutcome({ provider: 'razorpay', providerEventId: `evt_dyn_${i}`, recoveryCaseId: i, recoveryActionId: `act_${i}`, verified: true, outcome: 'PAID', amountPaid: 200000 });
      }

      const app = createApp(repository);
      const res = await request(app).get('/api/recovery/adaptive-model');

      expect(res.status).toBe(200);
      expect(res.body.summary.activeLearnedPairsCount).toBeGreaterThan(0);

      const retryPair = res.body.pairs.find(
        (p) => p.strategy === 'SCHEDULE_RETRY_WINDOW' && p.failureFamily === 'INSUFFICIENT_FUNDS'
      );

      expect(retryPair).toBeDefined();
      expect(retryPair.isLearnedModel).toBe(true);
      expect(retryPair.status).toBe('ACTIVE_LEARNING');
      expect(retryPair.sampleSize).toBe(5);
      expect(retryPair.successes).toBe(5);
      expect(retryPair.deltaApplied).toBeGreaterThan(0);
      expect(retryPair.provenance).toBe(PROVENANCE.PRODUCTION_OUTCOMES);
    });
  });
});
