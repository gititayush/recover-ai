/**
 * Revflow V2 — Adaptive Learning Engine
 *
 * Implements a bounded Empirical-Bayes learning framework for recovery strategy probabilities.
 *
 * Mathematical Formulation:
 * For each strategy / failure-family pair:
 *   - Prior: Existing deterministic heuristic probability (P_prior)
 *   - Prior pseudo-count: N_prior = 10
 *   - Observed verified outcomes: S (successes), F (failures), N_obs = S + F
 *   - Cold-start guard: If N_obs < 5, returns P_prior unchanged with provenance 'COLD_START_HEURISTIC'
 *   - Raw posterior: P_raw = ((N_prior * P_prior) + S) / (N_prior + N_obs)
 *   - Clamped delta: Delta = clamp(P_raw - P_prior, -0.15, +0.15)
 *   - Clamped probability: P_final = clamp(P_prior + Delta, 0.05, 0.95)
 *
 * Invariants:
 * 1. Policy & Stopping Engine Primacy: Learned probability affects candidate ranking and ERV only.
 *    Deterministic policy rules and stopping rules retain absolute veto authority.
 * 2. Strict Data Boundary: Production outcomes ('PRODUCTION_OUTCOMES') and benchmark corpus
 *    ('BENCHMARK_CORPUS') are completely isolated and never mixed automatically.
 * 3. Attribution Integrity: Only unambiguous, verified recovery outcomes linked to executed
 *    recovery actions are counted as successes. Ambiguous or superseded events are excluded.
 */

const fs = require('fs');
const path = require('path');
const { STRATEGY_DEFINITIONS } = require('../strategies/strategyRegistry');
const { FAILURE_FAMILIES } = require('./failureTaxonomy');

const PRIOR_PSEUDO_COUNT = 10;
const MIN_OBSERVATIONS_THRESHOLD = 5;
const MAX_DELTA = 0.15;
const MIN_PROBABILITY = 0.05;
const MAX_PROBABILITY = 0.95;

const PROVENANCE = Object.freeze({
  COLD_START_HEURISTIC: 'COLD_START_HEURISTIC',
  PRODUCTION_OUTCOMES: 'PRODUCTION_OUTCOMES',
  BENCHMARK_CORPUS: 'BENCHMARK_CORPUS'
});

const MODEL_TYPES = Object.freeze({
  HEURISTIC: 'deterministic_heuristic',
  BOUNDED_BAYES: 'bounded_empirical_bayes'
});

/**
 * Calculates bounded empirical-Bayes posterior probability.
 *
 * @param {object} params
 * @param {number} params.priorProbability - Heuristic prior in [0, 1]
 * @param {number} params.successes - Count of verified attributed successes
 * @param {number} params.failures - Count of terminal attributed failures
 * @param {number} [params.priorCount=10] - Pseudo-count weighting for prior
 * @param {number} [params.minObservations=5] - Minimum sample size before activating learning
 * @param {number} [params.maxDelta=0.15] - Maximum permitted probability shift
 * @param {string} [params.source='PRODUCTION_OUTCOMES'] - Provenance tag
 * @returns {object} Learned probability object
 */
function calculateLearnedProbability({
  priorProbability,
  successes = 0,
  failures = 0,
  priorCount = PRIOR_PSEUDO_COUNT,
  minObservations = MIN_OBSERVATIONS_THRESHOLD,
  maxDelta = MAX_DELTA,
  source = PROVENANCE.PRODUCTION_OUTCOMES
}) {
  const pPrior = Number(priorProbability);
  if (isNaN(pPrior) || pPrior <= 0) {
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

  const validSuccesses = Math.max(0, Math.floor(Number(successes) || 0));
  const validFailures = Math.max(0, Math.floor(Number(failures) || 0));
  const sampleSize = validSuccesses + validFailures;

  // COLD-START RULE: If observations < minObservations, preserve heuristic prior
  if (sampleSize < minObservations) {
    return {
      priorProbability: Math.round(pPrior * 10000) / 10000,
      learnedProbability: Math.round(pPrior * 10000) / 10000,
      sampleSize,
      successes: validSuccesses,
      failures: validFailures,
      deltaApplied: 0,
      provenance: PROVENANCE.COLD_START_HEURISTIC,
      isLearnedModel: false,
      modelType: MODEL_TYPES.HEURISTIC
    };
  }

  // BOUNDED EMPIRICAL-BAYES POSTERIOR
  // posterior = ((priorCount * priorProbability) + successes) / (priorCount + observations)
  const rawPosterior = ((priorCount * pPrior) + validSuccesses) / (priorCount + sampleSize);
  const rawDelta = rawPosterior - pPrior;

  // Clamp delta to [-maxDelta, +maxDelta]
  const clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, rawDelta));
  const boundedProb = pPrior + clampedDelta;

  // Clamp final probability to [MIN_PROBABILITY, MAX_PROBABILITY]
  const finalProb = Math.max(MIN_PROBABILITY, Math.min(MAX_PROBABILITY, boundedProb));
  const roundedProb = Math.round(finalProb * 10000) / 10000;
  const effectiveDelta = Math.round((roundedProb - pPrior) * 10000) / 10000;

  const provenance = source === PROVENANCE.BENCHMARK_CORPUS
    ? PROVENANCE.BENCHMARK_CORPUS
    : PROVENANCE.PRODUCTION_OUTCOMES;

  return {
    priorProbability: Math.round(pPrior * 10000) / 10000,
    learnedProbability: roundedProb,
    sampleSize,
    successes: validSuccesses,
    failures: validFailures,
    deltaApplied: effectiveDelta,
    provenance,
    isLearnedModel: true,
    modelType: MODEL_TYPES.BOUNDED_BAYES
  };
}

/**
 * Extracts verified and attributed outcomes from repository records.
 *
 * Strict Attribution Invariants:
 * 1. A payment alone is not automatically a strategy success.
 * 2. Only count as success when an outcome record has verified === true, outcome === 'PAID',
 *    and maps directly to an executed recovery action (action.id === outcome.recoveryActionId).
 * 3. Actions with status === 'FAILED' or 'SUPERSEDED' are attributed as failures.
 * 4. Actions currently in flight (status === 'EXECUTED' on an OPEN case) are excluded from closed samples.
 * 5. Actions that were BLOCKED by policy or PENDING review were never executed and are excluded.
 * 6. Unmatched outcomes (missing recoveryActionId) or unverified outcomes (partial, mismatch, superseded)
 *    are excluded from strategy success counts.
 */
function deriveFailureFamily(diagnosis, recoveryCase) {
  if (diagnosis?.diagnosis?.failureFamily) {
    return diagnosis.diagnosis.failureFamily;
  }
  const text = `${recoveryCase?.riskReason || ''} ${recoveryCase?.failureReason || ''}`.toLowerCase();
  if (text.includes('insufficient') || text.includes('balance') || text.includes('limit')) {
    return 'INSUFFICIENT_FUNDS';
  }
  if (text.includes('timeout') || text.includes('switch') || text.includes('bank')) {
    return 'BANK_SWITCH_TIMEOUT';
  }
  if (text.includes('gateway') || text.includes('server') || text.includes('internal')) {
    return 'GATEWAY_TECHNICAL_FAILURE';
  }
  if (text.includes('mandate') || text.includes('recurring') || text.includes('subscription')) {
    return 'MANDATE_FAILURE';
  }
  if (text.includes('otp') || text.includes('3ds') || text.includes('auth')) {
    return 'AUTHENTICATION_FAILURE';
  }
  return 'UNKNOWN_FAILURE';
}

function extractAttributedOutcomes({ cases = [], actions = [], outcomes = [], diagnoses = [] } = {}) {
  const caseMap = new Map(cases.map((c) => [c.id, c]));
  const diagnosisMap = new Map(diagnoses.map((d) => [d.recoveryCaseId, d]));

  // Build verified outcome map keyed by recoveryActionId
  const verifiedOutcomeByAction = new Map();
  const unverifiedOutcomesCount = {
    partial: 0,
    mismatch: 0,
    superseded: 0,
    unmatched: 0
  };

  for (const outcome of outcomes) {
    if (!outcome.recoveryActionId) {
      unverifiedOutcomesCount.unmatched++;
      continue;
    }
    if (outcome.verified && outcome.outcome === 'PAID') {
      verifiedOutcomeByAction.set(outcome.recoveryActionId, outcome);
    } else {
      if (outcome.outcome === 'PARTIALLY_PAID') unverifiedOutcomesCount.partial++;
      else if (outcome.outcome === 'FAILED_MISMATCH') unverifiedOutcomesCount.mismatch++;
      else if (outcome.outcome === 'SUPERSEDED_IGNORED') unverifiedOutcomesCount.superseded++;
    }
  }

  // Aggregate stats by `${actionType}:${failureFamily}`
  const statsByPair = {};
  let totalAttributedSuccesses = 0;
  let totalAttributedFailures = 0;
  let totalInFlightExcluded = 0;
  let totalPolicyBlockedExcluded = 0;

  for (const action of actions) {
    const actionType = action.actionType;
    if (!actionType || actionType === 'NO_ACTION' || actionType === 'REQUEST_MANUAL_REVIEW') {
      continue;
    }

    // Policy-blocked actions were never executed
    if (action.status === 'BLOCKED' || action.status === 'PENDING') {
      totalPolicyBlockedExcluded++;
      continue;
    }

    const recoveryCase = caseMap.get(action.recoveryCaseId);
    const diagnosis = diagnosisMap.get(action.recoveryCaseId);
    const failureFamily = deriveFailureFamily(diagnosis, recoveryCase);

    const pairKey = `${actionType}:${failureFamily}`;
    if (!statsByPair[pairKey]) {
      statsByPair[pairKey] = {
        actionType,
        failureFamily,
        successes: 0,
        failures: 0,
        sampleSize: 0
      };
    }

    const pairStats = statsByPair[pairKey];

    // Check if action was verified as recovered
    const verifiedOutcome = verifiedOutcomeByAction.get(action.id);
    if (verifiedOutcome && ['EXECUTED', 'OUTCOME_CONFIRMED'].includes(action.status)) {
      pairStats.successes++;
      pairStats.sampleSize++;
      totalAttributedSuccesses++;
      continue;
    }

    // Check if action is a terminal failure
    if (action.status === 'FAILED' || action.status === 'SUPERSEDED') {
      pairStats.failures++;
      pairStats.sampleSize++;
      totalAttributedFailures++;
      continue;
    }

    // If case concluded without recovery
    if (recoveryCase && recoveryCase.riskStatus === 'RESOLVED' && recoveryCase.outcome !== 'RECOVERED') {
      pairStats.failures++;
      pairStats.sampleSize++;
      totalAttributedFailures++;
      continue;
    }

    // In-flight action on an OPEN case (e.g., active payment link awaiting customer payment)
    if (action.status === 'EXECUTED' && (!recoveryCase || recoveryCase.riskStatus === 'OPEN')) {
      totalInFlightExcluded++;
      continue;
    }
  }

  return {
    statsByPair,
    summary: {
      totalCases: cases.length,
      totalActions: actions.length,
      totalOutcomes: outcomes.length,
      verifiedOutcomesCount: verifiedOutcomeByAction.size,
      attributedSuccesses: totalAttributedSuccesses,
      attributedFailures: totalAttributedFailures,
      inFlightExcluded: totalInFlightExcluded,
      policyBlockedExcluded: totalPolicyBlockedExcluded,
      unverifiedOutcomesCount
    }
  };
}

/**
 * Normalizes repository query results into memory arrays.
 */
async function fetchRepositoryData(repository) {
  const cases = repository.getAllCases ? await repository.getAllCases() : (repository.cases ? [...repository.cases] : await repository.listCases());
  const actions = repository.getAllActions ? await repository.getAllActions() : (repository.actions ? [...repository.actions] : []);
  const outcomes = repository.getAllOutcomes ? await repository.getAllOutcomes() : (repository.outcomes ? [...repository.outcomes] : []);
  const diagnoses = repository.getAllDiagnoses ? await repository.getAllDiagnoses() : (repository.diagnoses ? [...repository.diagnoses] : (repository.aiDiagnoses ? [...repository.aiDiagnoses] : []));

  return { cases, actions, outcomes, diagnoses };
}

/**
 * Builds the production learning model from a repository instance.
 *
 * @param {object} repository
 * @returns {Promise<object>} Model instance with getProbabilityForPair method
 */
async function getProductionLearningModel(repository) {
  const data = await fetchRepositoryData(repository);
  const { statsByPair, summary } = extractAttributedOutcomes(data);

  return {
    source: PROVENANCE.PRODUCTION_OUTCOMES,
    summary,
    statsByPair,

    /**
     * Resolves learned probability for a strategy and failure family.
     */
    getProbabilityForPair({ action, failureFamily, priorProbability }) {
      const pPrior = Number(priorProbability) || 0;
      const key = `${action}:${failureFamily || 'UNKNOWN_FAILURE'}`;
      const pairStats = statsByPair[key] || { successes: 0, failures: 0, sampleSize: 0 };

      return calculateLearnedProbability({
        priorProbability: pPrior,
        successes: pairStats.successes,
        failures: pairStats.failures,
        source: PROVENANCE.PRODUCTION_OUTCOMES
      });
    }
  };
}

/**
 * Computes benchmark statistics derived from the static evaluation corpus.
 * STRICTLY ISOLATED: Never mixes into production learning automatically.
 *
 * @param {object|string} [corpusDataOrPath] - Optional corpus object or file path
 * @returns {object} Benchmark statistics object with provenance BENCHMARK_CORPUS
 */
function computeBenchmarkCorpusStatistics(corpusDataOrPath = null) {
  let corpus = corpusDataOrPath;

  if (!corpus || typeof corpus === 'string') {
    const filePath = typeof corpusDataOrPath === 'string'
      ? corpusDataOrPath
      : path.join(__dirname, '..', '..', '..', 'evaluation', 'data', 'corpus_seed42_560.json');

    if (fs.existsSync(filePath)) {
      try {
        corpus = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        corpus = null;
      }
    }
  }

  const cases = corpus?.cases || (Array.isArray(corpus) ? corpus : []);
  const benchmarkStats = {
    provenance: PROVENANCE.BENCHMARK_CORPUS,
    totalBenchmarkCases: cases.length,
    byPlaybook: {},
    byPair: {}
  };

  for (const c of cases) {
    const playbook = c.playbook_id || 'general';
    benchmarkStats.byPlaybook[playbook] = (benchmarkStats.byPlaybook[playbook] || 0) + 1;
  }

  return benchmarkStats;
}

/**
 * Builds the read-only inspection payload for GET /api/recovery/adaptive-model.
 *
 * @param {object} repository
 * @returns {Promise<object>} Inspection payload
 */
async function buildAdaptiveModelInspection(repository) {
  const data = await fetchRepositoryData(repository);
  const { statsByPair, summary } = extractAttributedOutcomes(data);

  // Pre-seed representative strategy and failure-family combinations
  const representativeStrategies = [
    'CREATE_PAYMENT_LINK',
    'SCHEDULE_RETRY_WINDOW',
    'CUSTOMER_OUTREACH',
    'CHECKOUT_RECOVERY',
    'DISPATCH_VERNACULAR_ASSIST',
    'REQUEST_MANUAL_REVIEW'
  ];

  const representativeFamilies = [
    'INSUFFICIENT_FUNDS',
    'BANK_SWITCH_TIMEOUT',
    'GATEWAY_TECHNICAL_FAILURE',
    'MANDATE_FAILURE',
    'AUTHENTICATION_FAILURE',
    'UNKNOWN_FAILURE'
  ];

  const pairs = [];
  let activeLearnedPairsCount = 0;
  let coldStartPairsCount = 0;

  // Baseline priors lookup by strategy & family
  const getBaselinePrior = (strategy, family) => {
    if (strategy === 'CREATE_PAYMENT_LINK') return 0.55;
    if (strategy === 'SCHEDULE_RETRY_WINDOW') {
      if (family === 'INSUFFICIENT_FUNDS') return 0.65;
      if (family === 'BANK_SWITCH_TIMEOUT') return 0.70;
      if (family === 'MANDATE_FAILURE') return 0.65;
      return 0.55;
    }
    if (strategy === 'CHECKOUT_RECOVERY') return 0.50;
    if (strategy === 'CUSTOMER_OUTREACH') return 0.40;
    if (strategy === 'DISPATCH_VERNACULAR_ASSIST') return 0.60;
    if (strategy === 'REQUEST_MANUAL_REVIEW') return 0.25;
    return 0.30;
  };

  for (const strategy of representativeStrategies) {
    for (const family of representativeFamilies) {
      const key = `${strategy}:${family}`;
      const pairStats = statsByPair[key] || { successes: 0, failures: 0, sampleSize: 0 };
      const priorProb = getBaselinePrior(strategy, family);

      const learned = calculateLearnedProbability({
        priorProbability: priorProb,
        successes: pairStats.successes,
        failures: pairStats.failures,
        source: PROVENANCE.PRODUCTION_OUTCOMES
      });

      if (learned.isLearnedModel) {
        activeLearnedPairsCount++;
      } else {
        coldStartPairsCount++;
      }

      pairs.push({
        strategy,
        failureFamily: family,
        priorProbability: learned.priorProbability,
        learnedProbability: learned.learnedProbability,
        sampleSize: learned.sampleSize,
        successes: learned.successes,
        failures: learned.failures,
        deltaApplied: learned.deltaApplied,
        provenance: learned.provenance,
        isLearnedModel: learned.isLearnedModel,
        modelType: learned.modelType,
        status: learned.isLearnedModel ? 'ACTIVE_LEARNING' : 'COLD_START'
      });
    }
  }

  const primaryProvenance = activeLearnedPairsCount > 0
    ? PROVENANCE.PRODUCTION_OUTCOMES
    : PROVENANCE.COLD_START_HEURISTIC;

  return {
    status: 'ok',
    modelType: MODEL_TYPES.BOUNDED_BAYES,
    methodology: 'Bounded Empirical-Bayes with N_prior=10 pseudo-counts, min_observations=5, delta_clamp=[-0.15, +0.15], prob_clamp=[0.05, 0.95]',
    summary: {
      totalProductionCases: summary.totalCases,
      verifiedOutcomesCount: summary.verifiedOutcomesCount,
      attributedSuccesses: summary.attributedSuccesses,
      attributedFailures: summary.attributedFailures,
      inFlightExcluded: summary.inFlightExcluded,
      policyBlockedExcluded: summary.policyBlockedExcluded,
      activeLearnedPairsCount,
      coldStartPairsCount,
      primaryProvenance
    },
    safetyBounds: {
      priorPseudoCount: PRIOR_PSEUDO_COUNT,
      minObservationsThreshold: MIN_OBSERVATIONS_THRESHOLD,
      maxDelta: MAX_DELTA,
      probabilityBounds: [MIN_PROBABILITY, MAX_PROBABILITY]
    },
    productionAttribution: {
      totalCases: summary.totalCases,
      attributedSuccesses: summary.attributedSuccesses,
      attributedFailures: summary.attributedFailures,
      inFlightActionsAwaitingOutcome: summary.inFlightExcluded,
      unverifiedOutcomes: summary.unverifiedOutcomesCount
    },
    pairs,
    disclaimer: summary.attributedSuccesses + summary.attributedFailures < MIN_OBSERVATIONS_THRESHOLD
      ? `Production learning activates when at least ${MIN_OBSERVATIONS_THRESHOLD} verified outcomes exist for a strategy/failure pair. The current verified production sample is ${summary.verifiedOutcomesCount} recoveries, so Revflow operates transparently under COLD_START_HEURISTIC mode.`
      : 'Production learning is active for pairs meeting the minimum observation threshold.'
  };
}

module.exports = {
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
};
