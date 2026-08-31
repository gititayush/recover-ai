const HEURISTIC_VERSION = 'recovery-heuristic-v1';

function baseProbability(context) {
  const byRisk = { HIGH: 0.55, MEDIUM: 0.4, LOW: 0.25 };
  let probability = byRisk[context.riskLevel] || 0.25;
  if (context.failureReason?.toLowerCase().includes('timeout')) probability += 0.1;
  if (context.paymentAttemptCount > 1) probability += 0.05;
  return Math.min(probability, 0.7);
}

function evaluateCandidates(context) {
  const probability = baseProbability(context);
  const definitions = [
    { action: 'CREATE_PAYMENT_LINK', estimatedProbability: probability, interventionCost: 0, estimatedFriction: Math.round(context.amount * 0.05) },
    { action: 'REQUEST_MANUAL_REVIEW', estimatedProbability: Math.max(0, probability - 0.1), interventionCost: 2500, estimatedFriction: Math.round(context.amount * 0.1) },
    { action: 'NO_ACTION', estimatedProbability: 0, interventionCost: 0, estimatedFriction: 0 }
  ];

  if (context.playbook === 'failed_subscription' || context.playbook === 'mandate_retry') {
    definitions.push({
      action: 'SCHEDULE_RETRY_WINDOW',
      estimatedProbability: Math.min(0.65, probability + 0.05),
      interventionCost: 500,
      estimatedFriction: Math.round(context.amount * 0.02)
    });
  }

  if (context.playbook === 'hinglish_voice_recovery') {
    definitions.push({
      action: 'DISPATCH_VERNACULAR_ASSIST',
      estimatedProbability: Math.min(0.68, probability + 0.08),
      interventionCost: 1000,
      estimatedFriction: Math.round(context.amount * 0.03)
    });
  }

  if (context.playbook === 'promise_to_pay') {
    definitions.push({
      action: 'RECORD_PROMISE_TO_PAY',
      estimatedProbability: Math.min(0.70, probability + 0.10),
      interventionCost: 0,
      estimatedFriction: 0
    });
  }

  return definitions.map((candidate) => ({
    ...candidate,
    recoverableAmount: context.amount,
    estimatedRecoveryValue: Math.round((candidate.estimatedProbability * context.amount) - candidate.interventionCost - candidate.estimatedFriction),
    assumptions: { heuristicVersion: HEURISTIC_VERSION, note: 'Heuristic estimate only; not a learned or measured recovery probability.' }
  }));
}

function rankCandidates(candidates) {
  return [...candidates].sort((left, right) => right.estimatedRecoveryValue - left.estimatedRecoveryValue || left.action.localeCompare(right.action));
}

module.exports = { HEURISTIC_VERSION, evaluateCandidates, rankCandidates };
