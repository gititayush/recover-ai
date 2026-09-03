/**
 * Revflow V2 — Expected Recovery Value (ERV) & Heuristic Scoring Engine
 *
 * Computes the Expected Recovery Value for candidate recovery strategies:
 *   ERV = round((Amount * P_recovery) - InterventionCost - FrictionCost)
 *
 * IMPORTANT METHODOLOGY DISCLOSURE:
 * Revflow uses explicit, deterministic heuristic assumptions grounded in
 * observable telemetry (risk level, failure reason, retry count, time elapsed).
 * These probabilities are NOT claimed to be trained machine-learned weights
 * until a real continuous outcome evaluation model is deployed.
 */

const HEURISTIC_VERSION = 'recovery-heuristic-v1';

/**
 * Computes the base recovery probability grounded in observable payment context.
 *
 * @param {object} context
 * @returns {number} probability float in [0.05, 0.70]
 */
function computeBaseProbability(context = {}) {
  const byRisk = { HIGH: 0.55, MEDIUM: 0.40, LOW: 0.25 };
  let probability = byRisk[context.riskLevel] || 0.25;

  const failureReasonLower = (context.failureReason || '').toLowerCase();
  if (failureReasonLower.includes('timeout') || failureReasonLower.includes('switch') || failureReasonLower.includes('bank')) {
    probability += 0.10;
  }

  if (context.paymentAttemptCount && context.paymentAttemptCount > 1) {
    probability += 0.05;
  }

  if (context.timeSinceFailureMinutes && context.timeSinceFailureMinutes > 1440) {
    probability -= 0.05;
  }

  const rounded = Math.round(probability * 100) / 100;
  return Math.min(Math.max(rounded, 0.05), 0.70);
}

/**
 * Calculates Expected Recovery Value (ERV) in integer paise.
 *
 * @param {object} params
 * @param {number} params.amount - Transaction amount in paise
 * @param {number} params.probability - Estimated recovery probability in [0, 1]
 * @param {number} params.interventionCost - Monetary operational/API cost in paise
 * @param {number} params.frictionCost - Monetary customer friction penalty in paise
 * @returns {number} Expected recovery value in paise
 */
function calculateERV({ amount = 0, probability = 0, interventionCost = 0, frictionCost = 0 }) {
  const validAmount = Math.max(0, Number(amount) || 0);
  const validProb = Math.min(Math.max(0, Number(probability) || 0), 1);
  const validCost = Math.max(0, Number(interventionCost) || 0);
  const validFriction = Math.max(0, Number(frictionCost) || 0);

  const rawErv = (validProb * validAmount) - validCost - validFriction;
  return Math.round(rawErv);
}

/**
 * Generates transparent assumption metadata for audit and UI display.
 */
function getScoringAssumptions(overrides = {}) {
  return {
    heuristicVersion: HEURISTIC_VERSION,
    isLearnedModel: false,
    modelType: 'deterministic_heuristic',
    note: 'Heuristic estimate only; not a learned or measured recovery probability.',
    ...overrides
  };
}

module.exports = {
  HEURISTIC_VERSION,
  computeBaseProbability,
  calculateERV,
  getScoringAssumptions
};
