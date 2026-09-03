const { environment } = require('../config/env');
const {
  evaluateStoppingCriteria,
  STOP_REASON_CODES,
  ACTION_DISPOSITIONS
} = require('./stoppingEngine');
const { STRATEGY_DEFINITIONS } = require('../strategies/strategyRegistry');
const { playbookEngine } = require('../playbooks/playbookEngine');

const POLICY_VERSION = 'recoverai-policy-v1';
const ALLOWED_ACTIONS = ['CREATE_PAYMENT_LINK'];
const SIMULATED_ACTIONS = ['CHECKOUT_RECOVERY', 'CUSTOMER_OUTREACH'];

function evaluatePolicy({
  recoveryCase,
  diagnosis = null,
  candidateAction = null,
  events = [],
  existingActions = [],
  confidenceThreshold = environment.AI_CONFIDENCE_THRESHOLD,
  maxAutomatedAttempts = environment.RAZORPAY_MAX_AUTOMATED_ATTEMPTS,
  highValueThresholdPaise = environment.RAZORPAY_HIGH_VALUE_THRESHOLD_PAISE,
  cooldownMinutes = environment.RAZORPAY_ACTION_COOLDOWN_MINUTES,
  candidateReference = null,
  isTestMode = true,
  humanApproval = null,
  allowSimulated = false,
  now = () => new Date()
} = {}) {
  const targetAction = candidateAction
    || diagnosis?.recommendation?.action
    || diagnosis?.proposedAction
    || 'CREATE_PAYMENT_LINK';

  const currentTime = now();
  const rulesEvaluated = [];
  const blockReasons = [];
  const reviewReasons = [];

  function recordRule(rule, status, message = null) {
    rulesEvaluated.push({ rule, status, message });
    if (status === 'BLOCK' && message) blockReasons.push(message);
    if (status === 'REVIEW' && message) reviewReasons.push(message);
  }

  // EXPLICIT HUMAN REJECTION CHECK
  if (recoveryCase && recoveryCase.escalationStatus === 'REJECTED') {
    recordRule('escalation_rejected', 'BLOCK', 'Case recovery was explicitly rejected by human operations. No recovery action permitted.');
  }

  // RULE 10 — MISSING / INVALID CONTEXT
  if (!recoveryCase || !recoveryCase.paymentId || typeof recoveryCase.amount !== 'number' || isNaN(recoveryCase.amount) || !recoveryCase.currency) {
    recordRule('context_integrity', 'BLOCK', 'Required case context fields (paymentId, amount, currency) are missing or invalid.');
  } else {
    recordRule('context_integrity', 'PASS');
  }

  // RULE 7 — PAYMENT AMOUNT INTEGRITY
  if (recoveryCase && (recoveryCase.amount <= 0 || !Number.isInteger(recoveryCase.amount) || isNaN(recoveryCase.amount))) {
    recordRule('amount_integrity', 'BLOCK', `Invalid recovery amount (${recoveryCase?.amount}). Must be a positive integer in paise.`);
  } else {
    recordRule('amount_integrity', 'PASS');
  }

  // RULE 8 — CURRENCY INTEGRITY
  if (recoveryCase && recoveryCase.currency && recoveryCase.currency.toUpperCase() !== 'INR') {
    recordRule('currency_integrity', 'BLOCK', `Unsupported or mismatched recovery currency '${recoveryCase.currency}'. Only INR is supported.`);
  } else {
    recordRule('currency_integrity', 'PASS');
  }

  // RULE 11 — TEST MODE VERIFICATION
  const isLiveAction = targetAction === 'CREATE_PAYMENT_LINK';
  if (isLiveAction && !isTestMode) {
    recordRule('test_mode_verification', 'BLOCK', 'Execution is blocked because application is not configured for Razorpay Test Mode.');
  } else {
    recordRule('test_mode_verification', 'PASS');
  }

  // RULE 1 — TERMINAL PAYMENT
  const lastEvent = events.at(-1);
  const isTerminalPayment = ['captured', 'paid', 'refunded'].includes(lastEvent?.paymentStatus)
    || events.some((event) => event.eventType === 'order.paid' || ['captured', 'paid', 'refunded'].includes(event.paymentStatus));

  if (isTerminalPayment) {
    recordRule('terminal_payment', 'BLOCK', 'Payment is already terminal (captured, paid, or refunded). No recovery action allowed.');
  } else {
    recordRule('terminal_payment', 'PASS');
  }

  // RULE 2 — CASE TERMINAL STATUS
  if (recoveryCase && ['RESOLVED', 'SUPPRESSED'].includes(recoveryCase.riskStatus)) {
    recordRule('case_status', 'BLOCK', `Case is in terminal status ${recoveryCase.riskStatus}. No recovery action allowed.`);
  } else {
    recordRule('case_status', 'PASS');
  }

  // RULE 12 — STOP ON RESOLVED OUTCOME
  if (recoveryCase && recoveryCase.outcome && ['PAID', 'REFUNDED', 'RESOLVED'].includes(recoveryCase.outcome.toUpperCase())) {
    recordRule('resolved_outcome_check', 'BLOCK', `Recovery case outcome is already ${recoveryCase.outcome}. Execution stopped.`);
  } else {
    recordRule('resolved_outcome_check', 'PASS');
  }

  // RULE 3 — ACTION ALLOWLIST
  if (targetAction === 'NO_ACTION') {
    recordRule('action_allowlist', 'BLOCK', 'Proposed action is NO_ACTION; no recovery intervention requested.');
  } else if (targetAction === 'REQUEST_MANUAL_REVIEW') {
    recordRule('action_allowlist', 'REVIEW', 'AI proposed manual review.');
  } else if (allowSimulated && SIMULATED_ACTIONS.includes(targetAction)) {
    recordRule('action_allowlist', 'PASS');
  } else if (!ALLOWED_ACTIONS.includes(targetAction)) {
    recordRule('action_allowlist', 'BLOCK', `Action '${targetAction}' is not in the authorized action allowlist.`);
  } else {
    recordRule('action_allowlist', 'PASS');
  }

  // RULE 4 — CONFIDENCE
  if (diagnosis && typeof diagnosis.diagnosis?.confidence === 'number') {
    if (diagnosis.diagnosis.confidence < confidenceThreshold) {
      recordRule('confidence_threshold', 'REVIEW', `AI confidence ${diagnosis.diagnosis.confidence} is below the automatic execution threshold ${confidenceThreshold}.`);
    } else {
      recordRule('confidence_threshold', 'PASS');
    }
  } else if (!diagnosis) {
    recordRule('confidence_threshold', 'REVIEW', 'No AI diagnosis proposal present for case.');
  } else {
    recordRule('confidence_threshold', 'PASS');
  }

  // RULE 5 — MAXIMUM AUTOMATED RECOVERY ATTEMPTS
  const priorBusinessActions = existingActions.filter((a) => {
    if (a.status === 'SUPERSEDED') return false;
    if (candidateReference && a.idempotencyKey === candidateReference) return false;
    return true;
  });
  const attemptCount = new Set(priorBusinessActions.map((a) => a.idempotencyKey || a.id)).size;
  if (attemptCount >= maxAutomatedAttempts) {
    recordRule('max_attempts', 'REVIEW', `Maximum automated recovery attempts (${maxAutomatedAttempts}) reached for this case.`);
  } else {
    recordRule('max_attempts', 'PASS');
  }

  // RULE 6 — DUPLICATE ACTION
  const activeDuplicate = existingActions.find(
    (a) => a.actionType === targetAction && ['EXECUTED', 'EXECUTING', 'APPROVED', 'PENDING'].includes(a.status)
  );
  if (activeDuplicate) {
    recordRule('duplicate_action', 'BLOCK', `An active or executed recovery action (${activeDuplicate.providerActionId || activeDuplicate.id}) already exists for this case.`);
  } else {
    recordRule('duplicate_action', 'PASS');
  }

  // RULE 8 — HIGH-VALUE ESCALATION
  if (recoveryCase && recoveryCase.amount > highValueThresholdPaise) {
    const formattedAmount = (recoveryCase.amount / 100).toLocaleString('en-IN');
    const formattedLimit = (highValueThresholdPaise / 100).toLocaleString('en-IN');
    recordRule('high_value_escalation', 'REVIEW', `Case amount ₹${formattedAmount} exceeds automatic execution limit of ₹${formattedLimit}.`);
  } else {
    recordRule('high_value_escalation', 'PASS');
  }

  // RULE 9 — COOLDOWN
  const recentAction = existingActions
    .filter((a) => {
      if (a.status === 'SUPERSEDED') return false;
      if (candidateReference && a.idempotencyKey === candidateReference) return false;
      return true;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  if (recentAction && cooldownMinutes > 0) {
    const actionTime = new Date(recentAction.createdAt).getTime();
    const elapsedMinutes = (currentTime.getTime() - actionTime) / 60000;
    if (elapsedMinutes < cooldownMinutes) {
      const remaining = Math.ceil(cooldownMinutes - elapsedMinutes);
      recordRule('cooldown_period', 'REVIEW', `Cooldown period of ${cooldownMinutes} minutes has not elapsed since previous recovery attempt (${remaining} minute(s) remaining).`);
    } else {
      recordRule('cooldown_period', 'PASS');
    }
  } else {
    recordRule('cooldown_period', 'PASS');
  }

  // PLAYBOOK-SPECIFIC DOMAIN POLICY CONSTRAINTS
  const customPolicy = playbookEngine.evaluateCustomPolicy(
    { recoveryCase, events, existingActions },
    targetAction,
    now
  );
  if (customPolicy && customPolicy.stop) {
    const isHardStop = customPolicy.actionDisposition === 'HARD_STOP';
    recordRule('playbook_custom_policy', isHardStop ? 'BLOCK' : 'REVIEW', customPolicy.humanReadableReason);
  } else {
    recordRule('playbook_custom_policy', 'PASS');
  }

  // EVALUATE EXPLICIT STOPPING CRITERIA
  const stopping = evaluateStoppingCriteria({
    recoveryCase,
    diagnosis,
    candidateAction: targetAction,
    events,
    existingActions,
    confidenceThreshold,
    maxAutomatedAttempts,
    highValueThresholdPaise,
    cooldownMinutes,
    candidateReference,
    now
  });

  // If stopping engine flagged a block or review condition not already captured by basic rules
  if (stopping.stopped) {
    if (stopping.actionDisposition === ACTION_DISPOSITIONS.HARD_STOP) {
      if (blockReasons.length === 0) {
        blockReasons.push(stopping.humanReadableReason);
      }
    } else if (stopping.actionDisposition === ACTION_DISPOSITIONS.WAIT || stopping.actionDisposition === ACTION_DISPOSITIONS.ESCALATE) {
      if (reviewReasons.length === 0 && blockReasons.length === 0) {
        reviewReasons.push(stopping.humanReadableReason);
      }
    }
  }

  let decision = 'ALLOW';
  const reasons = [];
  let humanOverride = null;

  if (blockReasons.length > 0) {
    // Non-overridable HARD BLOCK — human approval CANNOT override this
    decision = 'BLOCK';
    reasons.push(...blockReasons);
    if (humanApproval && humanApproval.approvedBy) {
      humanOverride = {
        applied: false,
        reason: 'Human approval cannot override hard BLOCK conditions.',
        approvedBy: humanApproval.approvedBy,
        blockReasons: [...blockReasons]
      };
    }
  } else if (reviewReasons.length > 0) {
    if (humanApproval && humanApproval.approvedBy) {
      // Human approval successfully resolves explicit REVIEW conditions
      decision = 'ALLOW';
      humanOverride = {
        applied: true,
        approvedBy: humanApproval.approvedBy,
        approvedAt: humanApproval.approvedAt || currentTime.toISOString(),
        notes: humanApproval.notes || null,
        overriddenReviewReasons: [...reviewReasons]
      };
    } else {
      decision = 'REVIEW';
      reasons.push(...reviewReasons);
    }
  }

  return {
    decision,
    action: targetAction,
    reasons,
    rulesEvaluated,
    policyVersion: POLICY_VERSION,
    stopping,
    humanOverride
  };
}

module.exports = {
  POLICY_VERSION,
  ALLOWED_ACTIONS,
  STOP_REASON_CODES,
  ACTION_DISPOSITIONS,
  evaluatePolicy
};
