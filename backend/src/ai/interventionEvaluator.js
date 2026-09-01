const HEURISTIC_VERSION = 'recovery-heuristic-v1';

const CATEGORY_ALLOWED_ACTIONS = {
  TRANSIENT_PAYMENT_FAILURE: ['CREATE_PAYMENT_LINK', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'],
  CHECKOUT_DROPOFF: ['CREATE_PAYMENT_LINK', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'],
  FAILED_SUBSCRIPTION: ['SCHEDULE_RETRY_WINDOW', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'],
  B2B_APPROVAL_DELAY: ['REQUEST_MANUAL_REVIEW', 'NO_ACTION'],
  MANDATE_TIMING: ['SCHEDULE_RETRY_WINDOW', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'],
  LANGUAGE_ASSISTANCE: ['DISPATCH_VERNACULAR_ASSIST', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'],
  PROMISE_TO_PAY: ['RECORD_PROMISE_TO_PAY', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'],
  TERMINAL_STATE: ['NO_ACTION'],
  AMBIGUOUS: ['REQUEST_MANUAL_REVIEW', 'NO_ACTION']
};

function baseProbability(context) {
  const byRisk = { HIGH: 0.55, MEDIUM: 0.4, LOW: 0.25 };
  let probability = byRisk[context.riskLevel] || 0.25;
  if (context.failureReason?.toLowerCase().includes('timeout')) probability += 0.1;
  if (context.paymentAttemptCount > 1) probability += 0.05;
  return Math.min(probability, 0.7);
}

function getActionDefinition(action, context, baseProb) {
  switch (action) {
    case 'CREATE_PAYMENT_LINK':
      return {
        action: 'CREATE_PAYMENT_LINK',
        estimatedProbability: baseProb,
        interventionCost: 0,
        estimatedFriction: Math.round(context.amount * 0.05)
      };
    case 'SCHEDULE_RETRY_WINDOW':
      return {
        action: 'SCHEDULE_RETRY_WINDOW',
        estimatedProbability: Math.min(0.65, baseProb + 0.05),
        interventionCost: 500,
        estimatedFriction: Math.round(context.amount * 0.02)
      };
    case 'DISPATCH_VERNACULAR_ASSIST':
      return {
        action: 'DISPATCH_VERNACULAR_ASSIST',
        estimatedProbability: Math.min(0.68, baseProb + 0.08),
        interventionCost: 1000,
        estimatedFriction: Math.round(context.amount * 0.03)
      };
    case 'RECORD_PROMISE_TO_PAY':
      return {
        action: 'RECORD_PROMISE_TO_PAY',
        estimatedProbability: Math.min(0.70, baseProb + 0.10),
        interventionCost: 0,
        estimatedFriction: 0
      };
    case 'REQUEST_MANUAL_REVIEW':
      return {
        action: 'REQUEST_MANUAL_REVIEW',
        estimatedProbability: Math.max(0, baseProb - 0.1),
        interventionCost: 2500,
        estimatedFriction: Math.round(context.amount * 0.1)
      };
    case 'NO_ACTION':
    default:
      return {
        action: 'NO_ACTION',
        estimatedProbability: 0,
        interventionCost: 0,
        estimatedFriction: 0
      };
  }
}

function evaluateCandidates(context, category = null) {
  const probability = baseProbability(context);

  let allowedActions;
  if (category && CATEGORY_ALLOWED_ACTIONS[category]) {
    allowedActions = CATEGORY_ALLOWED_ACTIONS[category];
  } else if (context.playbook === 'failed_subscription' || context.playbook === 'mandate_retry') {
    allowedActions = ['SCHEDULE_RETRY_WINDOW', 'CREATE_PAYMENT_LINK', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'];
  } else if (context.playbook === 'hinglish_voice_recovery') {
    allowedActions = ['DISPATCH_VERNACULAR_ASSIST', 'CREATE_PAYMENT_LINK', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'];
  } else if (context.playbook === 'promise_to_pay') {
    allowedActions = ['RECORD_PROMISE_TO_PAY', 'CREATE_PAYMENT_LINK', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'];
  } else if (context.playbook === 'b2b_receivables') {
    allowedActions = ['REQUEST_MANUAL_REVIEW', 'NO_ACTION'];
  } else {
    allowedActions = ['CREATE_PAYMENT_LINK', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'];
  }

  const definitions = allowedActions.map((action) => getActionDefinition(action, context, probability));

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

module.exports = { HEURISTIC_VERSION, CATEGORY_ALLOWED_ACTIONS, evaluateCandidates, rankCandidates };
