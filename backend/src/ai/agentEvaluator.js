/**
 * Revflow V2 — Agent Evaluation Foundation
 *
 * Lightweight, transparent evaluation and telemetry collector for AI diagnostic
 * proposals, policy gating, execution outcomes, and provider reliability.
 *
 * TRANSPARENCY NOTICE:
 * These metrics measure deterministic runtime reliability and operational distributions.
 * They do NOT claim machine-learning "accuracy" unless ground truth benchmark labels exist.
 */

/**
 * Validates and normalizes an evaluation record for an agent interaction.
 *
 * @param {object} params
 * @param {string|number} params.caseId - Case identifier
 * @param {boolean} params.schemaValid - Whether AI response conformed to strict Zod schema
 * @param {boolean} params.evidenceGrounded - Whether all evidence fields were verified in case facts
 * @param {string} params.recommendedAction - Strategy proposed by AI
 * @param {string} params.policyDecision - Deterministic policy outcome ('ALLOW', 'REVIEW', 'BLOCK')
 * @param {boolean} params.executionEligible - Whether action was eligible for execution
 * @param {number} params.latencyMs - Diagnosis generation latency in milliseconds
 * @param {boolean} [params.providerFailure=false] - Whether downstream provider call failed
 * @param {string|null} [params.finalOutcome=null] - Final reconciliation outcome ('RECOVERED', 'FAILED', 'SUPERSEDED', etc.)
 * @param {object} [params.metadata={}] - Additional context
 * @returns {object} Normalized evaluation record
 */
function createEvaluationRecord({
  caseId,
  schemaValid,
  evidenceGrounded,
  recommendedAction,
  policyDecision,
  executionEligible = false,
  latencyMs = 0,
  providerFailure = false,
  finalOutcome = null,
  metadata = {}
}) {
  return {
    caseId,
    schemaValid: Boolean(schemaValid),
    evidenceGrounded: Boolean(evidenceGrounded),
    recommendedAction: String(recommendedAction || 'UNKNOWN'),
    policyDecision: String(policyDecision || 'UNKNOWN'),
    executionEligible: Boolean(executionEligible),
    latencyMs: Number(latencyMs) >= 0 ? Number(latencyMs) : 0,
    providerFailure: Boolean(providerFailure),
    finalOutcome: finalOutcome ? String(finalOutcome) : null,
    metadata: { ...metadata },
    evaluatedAt: new Date().toISOString()
  };
}

/**
 * Computes transparent aggregate metrics from a batch of evaluation records.
 *
 * @param {Array<object>} records - Array of evaluation records
 * @returns {object} Calculated metrics summary
 */
function calculateAgentMetrics(records = []) {
  if (!Array.isArray(records) || records.length === 0) {
    return {
      totalEvaluations: 0,
      schemaValidityRate: 0,
      evidenceGroundingPassRate: 0,
      recommendationDistribution: {},
      policyDecisionDistribution: {},
      policyBlockRate: 0,
      policyReviewRate: 0,
      policyAllowRate: 0,
      executionEligibilityRate: 0,
      providerFailureRate: 0,
      verifiedRecoveryRate: 0,
      averageLatencyMs: 0,
      evaluationMetadata: {
        isGroundTruthBenchmark: false,
        groundTruthNote: 'Telemetry reflects operational distribution and safety rates over observed runtime trajectories. Not an offline ML accuracy measure.'
      }
    };
  }

  const total = records.length;
  let validSchemaCount = 0;
  let groundedEvidenceCount = 0;
  let blockCount = 0;
  let reviewCount = 0;
  let allowCount = 0;
  let eligibleCount = 0;
  let providerFailureCount = 0;
  let recoveredCount = 0;
  let totalLatency = 0;

  const recommendationDistribution = {};
  const policyDecisionDistribution = {};

  for (const r of records) {
    if (r.schemaValid) validSchemaCount++;
    if (r.evidenceGrounded) groundedEvidenceCount++;

    // Action distribution
    const action = r.recommendedAction || 'UNKNOWN';
    recommendationDistribution[action] = (recommendationDistribution[action] || 0) + 1;

    // Policy distribution
    const decision = r.policyDecision || 'UNKNOWN';
    policyDecisionDistribution[decision] = (policyDecisionDistribution[decision] || 0) + 1;
    if (decision === 'BLOCK') blockCount++;
    if (decision === 'REVIEW') reviewCount++;
    if (decision === 'ALLOW') allowCount++;

    if (r.executionEligible) eligibleCount++;
    if (r.providerFailure) providerFailureCount++;
    if (r.finalOutcome === 'RECOVERED' || r.finalOutcome === 'PAID' || r.finalOutcome === 'RESOLVED') {
      recoveredCount++;
    }

    totalLatency += Number(r.latencyMs) || 0;
  }

  const round4 = (val) => Math.round(val * 10000) / 10000;
  const round2 = (val) => Math.round(val * 100) / 100;

  return {
    totalEvaluations: total,
    schemaValidityRate: round4(validSchemaCount / total),
    evidenceGroundingPassRate: round4(groundedEvidenceCount / total),
    recommendationDistribution,
    policyDecisionDistribution,
    policyBlockRate: round4(blockCount / total),
    policyReviewRate: round4(reviewCount / total),
    policyAllowRate: round4(allowCount / total),
    executionEligibilityRate: round4(eligibleCount / total),
    providerFailureRate: round4(providerFailureCount / total),
    verifiedRecoveryRate: round4(recoveredCount / total),
    averageLatencyMs: round2(totalLatency / total),
    evaluationMetadata: {
      isGroundTruthBenchmark: false,
      groundTruthNote: 'Telemetry reflects operational distribution and safety rates over observed runtime trajectories. Not an offline ML accuracy measure.'
    }
  };
}

module.exports = {
  createEvaluationRecord,
  calculateAgentMetrics
};
