/**
 * Revflow V2 — Explicit Stopping Engine
 *
 * Evaluates machine-readable stopping criteria before any recovery action
 * or autonomous execution attempt.
 *
 * DISPOSITION TAXONOMY:
 * - HARD_STOP: Permanent condition preventing execution for this case/attempt (BLOCK)
 * - WAIT: Transient condition where case may become eligible later, e.g. cooldown (REVIEW / RETRY)
 * - ESCALATE: Condition requiring explicit human review and sign-off (REVIEW)
 * - CONTINUE: Case passes all stopping criteria and remains eligible for execution
 */

const { getStrategy } = require('../strategies/strategyRegistry');
const { calculateERV, computeBaseProbability } = require('../strategies/expectedRecoveryValue');

const STOP_REASON_CODES = Object.freeze({
  PAYMENT_RECOVERED: 'PAYMENT_RECOVERED',
  TERMINAL_PAYMENT: 'TERMINAL_PAYMENT',
  MAX_ATTEMPTS: 'MAX_ATTEMPTS',
  DUPLICATE_ACTION: 'DUPLICATE_ACTION',
  COOLDOWN_ACTIVE: 'COOLDOWN_ACTIVE',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  HIGH_RISK: 'HIGH_RISK',
  PROVIDER_INTEGRITY_FAILURE: 'PROVIDER_INTEGRITY_FAILURE',
  STALE_CASE: 'STALE_CASE',
  RECOVERY_UNECONOMIC: 'RECOVERY_UNECONOMIC',
  CUSTOMER_OPT_OUT: 'CUSTOMER_OPT_OUT',
  MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
  CHECKOUT_ALREADY_COMPLETED: 'CHECKOUT_ALREADY_COMPLETED',
  CHECKOUT_EXPIRED: 'CHECKOUT_EXPIRED',
  SUBSCRIPTION_CANCELLED: 'SUBSCRIPTION_CANCELLED',
  SUBSCRIPTION_PAUSED: 'SUBSCRIPTION_PAUSED',
  RENEWAL_ALREADY_PAID: 'RENEWAL_ALREADY_PAID',
  SUBSCRIPTION_EXPIRED: 'SUBSCRIPTION_EXPIRED',
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  INVOICE_ALREADY_PAID: 'INVOICE_ALREADY_PAID',
  INVOICE_CANCELLED: 'INVOICE_CANCELLED',
  INVOICE_DISPUTED: 'INVOICE_DISPUTED',
  B2B_TERMS_NOT_REACHED: 'B2B_TERMS_NOT_REACHED',
  COLLECTION_WINDOW_EXPIRED: 'COLLECTION_WINDOW_EXPIRED'
});

const ACTION_DISPOSITIONS = Object.freeze({
  HARD_STOP: 'HARD_STOP',
  WAIT: 'WAIT',
  ESCALATE: 'ESCALATE',
  CONTINUE: 'CONTINUE'
});

/**
 * Evaluates all stopping conditions against case facts.
 *
 * @param {object} params
 * @param {object} params.recoveryCase - Case record
 * @param {object} [params.diagnosis] - AI diagnosis proposal
 * @param {string} [params.candidateAction] - Targeted recovery action
 * @param {Array} [params.events] - Normalized event history
 * @param {Array} [params.existingActions] - Recorded recovery actions
 * @param {number} [params.confidenceThreshold=0.65] - AI confidence floor
 * @param {number} [params.maxAutomatedAttempts=2] - Max recovery attempts
 * @param {number} [params.highValueThresholdPaise=2500000] - High value threshold (₹25,000)
 * @param {number} [params.cooldownMinutes=30] - Mandatory quiet period
 * @param {number} [params.staleCaseThresholdMinutes=4320] - Max age in minutes (72h)
 * @param {string} [params.candidateReference] - Idempotency reference for candidate
 * @param {Function} [params.now] - Current time generator
 * @returns {object} Stopping evaluation result
 */
function evaluateStoppingCriteria({
  recoveryCase,
  diagnosis = null,
  candidateAction = null,
  events = [],
  existingActions = [],
  confidenceThreshold = 0.65,
  maxAutomatedAttempts = 2,
  highValueThresholdPaise = 2500000,
  cooldownMinutes = 30,
  staleCaseThresholdMinutes = 10080,
  candidateReference = null,
  now = () => new Date()
} = {}) {
  if (!recoveryCase) {
    return {
      stopped: true,
      actionDisposition: ACTION_DISPOSITIONS.HARD_STOP,
      reasonCode: STOP_REASON_CODES.PROVIDER_INTEGRITY_FAILURE,
      humanReadableReason: 'Recovery case context is missing.',
      supportingFacts: {}
    };
  }

  const currentTime = now();
  const targetAction = candidateAction
    || diagnosis?.recommendation?.action
    || diagnosis?.proposedAction
    || 'CREATE_PAYMENT_LINK';

  // 1. PAYMENT_RECOVERED (HARD_STOP)
  const isResolvedOutcome = recoveryCase.riskStatus === 'RESOLVED' ||
    (recoveryCase.outcome && ['PAID', 'RESOLVED'].includes(String(recoveryCase.outcome).toUpperCase())) ||
    (recoveryCase.recoveredAmount && Number(recoveryCase.recoveredAmount) > 0) ||
    existingActions.some((a) => a.status === 'OUTCOME_CONFIRMED');

  if (isResolvedOutcome) {
    return {
      stopped: true,
      actionDisposition: ACTION_DISPOSITIONS.HARD_STOP,
      reasonCode: STOP_REASON_CODES.PAYMENT_RECOVERED,
      humanReadableReason: 'Payment is already recovered and verified by provider outcome. No further action permitted.',
      supportingFacts: {
        riskStatus: recoveryCase.riskStatus,
        outcome: recoveryCase.outcome,
        recoveredAmount: recoveryCase.recoveredAmount
      }
    };
  }

  // 2. TERMINAL_PAYMENT (HARD_STOP)
  const lastEvent = events.at(-1);
  const isTerminalEvent = ['captured', 'paid', 'refunded'].includes(lastEvent?.paymentStatus) ||
    events.some((e) => e.eventType === 'order.paid' || e.eventType === 'payment.refunded' || ['captured', 'paid', 'refunded'].includes(e.paymentStatus));
  const isSuppressed = recoveryCase.riskStatus === 'SUPPRESSED' || recoveryCase.outcome === 'REFUNDED';

  if (isTerminalEvent || isSuppressed) {
    return {
      stopped: true,
      actionDisposition: ACTION_DISPOSITIONS.HARD_STOP,
      reasonCode: STOP_REASON_CODES.TERMINAL_PAYMENT,
      humanReadableReason: 'Payment is in a terminal state (captured, settled, or refunded) outside recovery workflow.',
      supportingFacts: {
        riskStatus: recoveryCase.riskStatus,
        outcome: recoveryCase.outcome,
        lastEventStatus: lastEvent?.paymentStatus
      }
    };
  }

  // 3. CUSTOMER_OPT_OUT (HARD_STOP)
  const optOutText = [
    recoveryCase.riskReason || '',
    ...(events.map((e) => `${e.eventType || ''} ${e.failureReason || ''}`))
  ].join(' ').toLowerCase();

  const isOptedOut = recoveryCase.customerOptOut === true ||
    optOutText.includes('opt-out') ||
    optOutText.includes('optout') ||
    optOutText.includes('unsubscribed') ||
    optOutText.includes('cancelled by customer');

  if (isOptedOut) {
    return {
      stopped: true,
      actionDisposition: ACTION_DISPOSITIONS.HARD_STOP,
      reasonCode: STOP_REASON_CODES.CUSTOMER_OPT_OUT,
      humanReadableReason: 'Customer has opted out of recovery communications or explicitly cancelled order.',
      supportingFacts: { customerReference: recoveryCase.customerReference }
    };
  }

  // 4. PROVIDER_INTEGRITY_FAILURE (HARD_STOP)
  if (recoveryCase.providerIntegrityFailure === true || recoveryCase.amount <= 0 || isNaN(recoveryCase.amount)) {
    return {
      stopped: true,
      actionDisposition: ACTION_DISPOSITIONS.HARD_STOP,
      reasonCode: STOP_REASON_CODES.PROVIDER_INTEGRITY_FAILURE,
      humanReadableReason: `Provider integrity failure: invalid or corrupted payment amount (${recoveryCase.amount}).`,
      supportingFacts: { amount: recoveryCase.amount, currency: recoveryCase.currency }
    };
  }

  // 5. DUPLICATE_ACTION (HARD_STOP)
  const activeDuplicate = existingActions.find(
    (a) => a.actionType === targetAction && ['EXECUTED', 'EXECUTING', 'APPROVED', 'PENDING'].includes(a.status)
  );

  if (activeDuplicate) {
    return {
      stopped: true,
      actionDisposition: ACTION_DISPOSITIONS.HARD_STOP,
      reasonCode: STOP_REASON_CODES.DUPLICATE_ACTION,
      humanReadableReason: `An active or executed recovery action (${activeDuplicate.providerActionId || activeDuplicate.id}) already exists for this case.`,
      supportingFacts: {
        existingActionId: activeDuplicate.id,
        status: activeDuplicate.status,
        providerActionId: activeDuplicate.providerActionId
      }
    };
  }

  // 6. STALE_CASE (HARD_STOP)
  if (recoveryCase.firstDetectedAt && staleCaseThresholdMinutes > 0) {
    const detectedTime = new Date(recoveryCase.firstDetectedAt).getTime();
    const elapsedMinutes = (currentTime.getTime() - detectedTime) / 60000;
    if (elapsedMinutes > staleCaseThresholdMinutes) {
      const elapsedHours = Math.round(elapsedMinutes / 60);
      return {
        stopped: true,
        actionDisposition: ACTION_DISPOSITIONS.HARD_STOP,
        reasonCode: STOP_REASON_CODES.STALE_CASE,
        humanReadableReason: `Case is stale (${elapsedHours} hours since failure detection; threshold is ${Math.round(staleCaseThresholdMinutes / 60)}h). Automated recovery stopped.`,
        supportingFacts: { elapsedHours, thresholdHours: Math.round(staleCaseThresholdMinutes / 60) }
      };
    }
  }

  // 7. RECOVERY_UNECONOMIC (HARD_STOP)
  // Computed using the ERV model: if ERV <= 0 for a non-control action because friction + cost exceeds expected recovery
  if (targetAction !== 'NO_ACTION' && targetAction !== 'REQUEST_MANUAL_REVIEW') {
    const strategy = getStrategy(targetAction);
    const prob = computeBaseProbability({
      riskLevel: recoveryCase.riskLevel,
      failureReason: recoveryCase.riskReason
    });
    const friction = Math.round(recoveryCase.amount * (strategy?.defaultFrictionRate || 0.05));
    const cost = strategy?.defaultInterventionCostPaise || 0;
    const erv = calculateERV({
      amount: recoveryCase.amount,
      probability: prob,
      interventionCost: cost,
      frictionCost: friction
    });

    if (erv <= 0 && recoveryCase.amount > 0) {
      return {
        stopped: true,
        actionDisposition: ACTION_DISPOSITIONS.HARD_STOP,
        reasonCode: STOP_REASON_CODES.RECOVERY_UNECONOMIC,
        humanReadableReason: `Recovery is uneconomic: Expected Recovery Value (₹${(erv / 100).toFixed(2)}) is non-positive after deducting intervention cost (₹${(cost / 100).toFixed(2)}) and friction (₹${(friction / 100).toFixed(2)}).`,
        supportingFacts: { erv, recoverableAmount: recoveryCase.amount, interventionCost: cost, frictionCost: friction }
      };
    }
  }

  // 8. COOLDOWN_ACTIVE (WAIT)
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
      const remainingMinutes = Math.ceil(cooldownMinutes - elapsedMinutes);
      const cooldownExpiresAt = new Date(actionTime + (cooldownMinutes * 60000)).toISOString();
      return {
        stopped: true,
        actionDisposition: ACTION_DISPOSITIONS.WAIT,
        reasonCode: STOP_REASON_CODES.COOLDOWN_ACTIVE,
        humanReadableReason: `Cooldown active: ${remainingMinutes} minute(s) remaining before retry is permitted.`,
        supportingFacts: {
          remainingMinutes,
          cooldownMinutes,
          cooldownExpiresAt,
          lastActionTime: recentAction.createdAt
        }
      };
    }
  }

  // 9. MAX_ATTEMPTS (ESCALATE)
  const priorBusinessActions = existingActions.filter((a) => {
    if (a.status === 'SUPERSEDED') return false;
    if (candidateReference && a.idempotencyKey === candidateReference) return false;
    return true;
  });
  const attemptCount = new Set(priorBusinessActions.map((a) => a.idempotencyKey || a.id)).size;

  if (attemptCount >= maxAutomatedAttempts) {
    return {
      stopped: true,
      actionDisposition: ACTION_DISPOSITIONS.ESCALATE,
      reasonCode: STOP_REASON_CODES.MAX_ATTEMPTS,
      humanReadableReason: `Maximum automated recovery attempts (${maxAutomatedAttempts}) exhausted for this case.`,
      supportingFacts: { attemptCount, maxAutomatedAttempts }
    };
  }

  // 10. LOW_CONFIDENCE (ESCALATE)
  if (diagnosis && typeof diagnosis.diagnosis?.confidence === 'number' && diagnosis.diagnosis.confidence < confidenceThreshold) {
    return {
      stopped: true,
      actionDisposition: ACTION_DISPOSITIONS.ESCALATE,
      reasonCode: STOP_REASON_CODES.LOW_CONFIDENCE,
      humanReadableReason: `AI diagnostic confidence (${diagnosis.diagnosis.confidence}) is below the required threshold (${confidenceThreshold}).`,
      supportingFacts: { confidence: diagnosis.diagnosis.confidence, confidenceThreshold }
    };
  }

  // 11. HIGH_RISK (ESCALATE)
  if (recoveryCase.amount > highValueThresholdPaise) {
    const formattedAmount = (recoveryCase.amount / 100).toLocaleString('en-IN');
    const formattedLimit = (highValueThresholdPaise / 100).toLocaleString('en-IN');
    return {
      stopped: true,
      actionDisposition: ACTION_DISPOSITIONS.ESCALATE,
      reasonCode: STOP_REASON_CODES.HIGH_RISK,
      humanReadableReason: `High-value exposure: Case amount ₹${formattedAmount} exceeds automatic execution limit of ₹${formattedLimit}.`,
      supportingFacts: { amountPaise: recoveryCase.amount, limitPaise: highValueThresholdPaise }
    };
  }

  // 12. MANUAL_REVIEW_REQUIRED (ESCALATE)
  if (targetAction === 'REQUEST_MANUAL_REVIEW') {
    return {
      stopped: true,
      actionDisposition: ACTION_DISPOSITIONS.ESCALATE,
      reasonCode: STOP_REASON_CODES.MANUAL_REVIEW_REQUIRED,
      humanReadableReason: 'Manual operations review explicitly requested for this case.',
      supportingFacts: { proposedAction: targetAction }
    };
  }

  // Eligible to proceed
  return {
    stopped: false,
    actionDisposition: ACTION_DISPOSITIONS.CONTINUE,
    reasonCode: null,
    humanReadableReason: null,
    supportingFacts: {}
  };
}

module.exports = {
  STOP_REASON_CODES,
  ACTION_DISPOSITIONS,
  evaluateStoppingCriteria
};
