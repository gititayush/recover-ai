/**
 * Revflow V2 — Failed Subscription Recovery Playbook (Smart Dunning)
 *
 * Manages recurring subscription auto-debit failures, mandate declines,
 * and card renewal issues. Sequences bounded recovery interventions
 * (deterministic retry scheduling, bounded Payment Link, customer outreach)
 * while enforcing subscription-specific stopping rules (cancellation, pause, expiration).
 */

const SUBSCRIPTION_TRIGGER_EVENTS = new Set([
  'subscription.created',
  'subscription.renewal_due',
  'subscription.renewal_failed',
  'subscription.charged',
  'subscription.cancelled',
  'subscription.paused',
  'subscription.resumed',
  'subscription.expired',
  'SUBSCRIPTION_CREATED',
  'SUBSCRIPTION_RENEWAL_DUE',
  'SUBSCRIPTION_RENEWAL_FAILED',
  'SUBSCRIPTION_CHARGED',
  'SUBSCRIPTION_CANCELLED',
  'SUBSCRIPTION_PAUSED',
  'SUBSCRIPTION_RESUMED',
  'SUBSCRIPTION_EXPIRED'
]);

const ACTIONABLE_SUBSCRIPTION_EVENTS = new Set([
  'subscription.renewal_failed',
  'SUBSCRIPTION_RENEWAL_FAILED'
]);

const failedSubscriptionPlaybook = {
  id: 'failed_subscription',
  name: 'Failed Subscription Recovery (Smart Dunning)',
  domain: 'SaaS & Recurring Billing',
  flagship: false,

  matchesEvent(event) {
    if (!event) return false;
    if (event.playbook === 'failed_subscription') return true;
    const eventType = String(event.eventType || '');
    if (SUBSCRIPTION_TRIGGER_EVENTS.has(eventType) || SUBSCRIPTION_TRIGGER_EVENTS.has(eventType.toLowerCase())) {
      return true;
    }
    const raw = event.rawPayload || {};
    if (raw.subscriptionId || raw.billingCycle || raw.mandateStatus || raw.renewalDueTimestamp) {
      return true;
    }
    return false;
  },

  assessRisk(event, eventHistory = []) {
    const raw = event.rawPayload || {};
    const eventType = String(event.eventType || '');

    // 1. Terminal payment / renewal charged
    const terminalPaidEvents = ['subscription.charged', 'order.paid', 'payment.captured', 'payment.succeeded', 'SUBSCRIPTION_CHARGED'];
    if (terminalPaidEvents.includes(eventType) || raw.renewalPaid === true || raw.subscriptionCharged === true) {
      return { terminal: true, outcome: 'PAID', actionable: false };
    }
    if (eventHistory.some((h) => terminalPaidEvents.includes(h.eventType) || h.rawPayload?.renewalPaid === true || h.paymentStatus === 'paid')) {
      return { terminal: false, actionable: false, terminalAlreadyKnown: true };
    }

    // 2. Cancellation check (HARD_STOP)
    if (eventType === 'subscription.cancelled' || eventType === 'SUBSCRIPTION_CANCELLED' || raw.subscriptionCancelled === true || raw.customerCancelled === true) {
      return { terminal: true, outcome: 'CANCELLED', actionable: false };
    }

    // 3. Paused check
    if (eventType === 'subscription.paused' || eventType === 'SUBSCRIPTION_PAUSED' || raw.subscriptionPaused === true) {
      return { terminal: false, actionable: false, paused: true, reason: 'Subscription is currently paused.' };
    }

    // 4. Expired check
    if (eventType === 'subscription.expired' || eventType === 'SUBSCRIPTION_EXPIRED' || raw.subscriptionExpired === true) {
      return { terminal: false, actionable: false, expired: true, reason: 'Subscription agreement has expired.' };
    }

    // 5. Amount validation
    const amount = Number(event.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return { terminal: false, actionable: false, invalidAmount: true, reason: 'Invalid or missing amount for subscription recovery.' };
    }

    // 6. Currency validation
    const currency = (event.currency || 'INR').toUpperCase();
    if (currency !== 'INR') {
      return { terminal: false, actionable: false, invalidCurrency: true, reason: 'Only INR is supported.' };
    }

    // 7. Actionability by Event Type
    const isActionable = ACTIONABLE_SUBSCRIPTION_EVENTS.has(eventType) || raw.renewalFailed === true;
    if (!isActionable) {
      return {
        terminal: false,
        actionable: false,
        stage: eventType,
        reason: 'Subscription event is informational and not actionable for recovery.'
      };
    }

    // 8. Attempt count
    const attemptNumber = Number.isInteger(raw.attemptNumber) ? raw.attemptNumber : 1;
    const isExhausted = attemptNumber >= 3;

    const failureReason = event.failureReason
      || raw.failureReason
      || raw.mandateFailureReason
      || 'Recurring mandate auto-debit failed';

    // High value threshold: ₹25,000 (2,500,000 paise) or retry exhaustion
    const riskLevel = amount >= 2500000 || isExhausted ? 'HIGH' : 'MEDIUM';

    return {
      terminal: false,
      actionable: true,
      riskStatus: 'RECOVERABLE',
      riskLevel,
      riskReason: `Failed subscription renewal: ${failureReason}`,
      playbook: 'failed_subscription',
      failureReason,
      attemptNumber,
      isExhausted
    };
  },

  extractContext(event, caseDetail) {
    const raw = event?.rawPayload || caseDetail?.recoveryCase?.metadata || {};
    return {
      playbook: 'failed_subscription',
      subscriptionId: raw.subscriptionId || event?.paymentId || caseDetail?.recoveryCase?.paymentId || null,
      customerReference: raw.customerReference || event?.customerReference || caseDetail?.recoveryCase?.customerReference || null,
      amount: event?.amount || caseDetail?.recoveryCase?.amount || null,
      currency: (event?.currency || caseDetail?.recoveryCase?.currency || 'INR').toUpperCase(),
      billingCycle: raw.billingCycle || null,
      attemptNumber: Number.isInteger(raw.attemptNumber) ? raw.attemptNumber : 1,
      renewalDueTimestamp: raw.renewalDueTimestamp || null,
      retryEligibility: raw.retryEligibility !== undefined ? Boolean(raw.retryEligibility) : true,
      subscriptionStatus: raw.subscriptionStatus || (event?.eventType ? event.eventType.split('.')[1]?.toUpperCase() : 'ACTIVE'),
      mandateStatus: raw.mandateStatus || null,
      lastSuccessfulPaymentTimestamp: raw.lastSuccessfulPaymentTimestamp || null,
      lastFailureReason: event?.failureReason || raw.failureReason || null
    };
  },

  getCandidateActions(context) {
    return [
      'SCHEDULE_RETRY_WINDOW',
      'CREATE_PAYMENT_LINK',
      'CUSTOMER_OUTREACH',
      'REQUEST_MANUAL_REVIEW',
      'NO_ACTION'
    ];
  },

  evaluateCustomPolicy(caseDetail, candidateAction, now = () => new Date()) {
    const { recoveryCase, events = [] } = caseDetail || {};

    // 1. Renewal already paid / confirmed charged
    const hasPaid = events.some((e) =>
      e.eventType === 'subscription.charged' ||
      e.eventType === 'order.paid' ||
      e.eventType === 'payment.captured' ||
      e.paymentStatus === 'paid' ||
      e.paymentStatus === 'captured' ||
      e.rawPayload?.renewalPaid === true ||
      e.rawPayload?.subscriptionCharged === true
    );
    if (hasPaid) {
      return {
        stop: true,
        actionDisposition: 'HARD_STOP',
        reasonCode: 'RENEWAL_ALREADY_PAID',
        humanReadableReason: 'Subscription renewal has already been paid and settled.'
      };
    }

    // 2. Subscription cancelled
    const hasCancelled = events.some((e) =>
      e.eventType === 'subscription.cancelled' ||
      e.eventType === 'SUBSCRIPTION_CANCELLED' ||
      e.rawPayload?.subscriptionCancelled === true ||
      e.rawPayload?.customerCancelled === true
    );
    if (hasCancelled) {
      return {
        stop: true,
        actionDisposition: 'HARD_STOP',
        reasonCode: 'SUBSCRIPTION_CANCELLED',
        humanReadableReason: 'Subscription was cancelled by subscriber or merchant.'
      };
    }

    // 3. Subscription paused
    const hasPaused = events.some((e) =>
      e.eventType === 'subscription.paused' ||
      e.eventType === 'SUBSCRIPTION_PAUSED' ||
      e.rawPayload?.subscriptionPaused === true
    );
    if (hasPaused) {
      return {
        stop: true,
        actionDisposition: 'HARD_STOP',
        reasonCode: 'SUBSCRIPTION_PAUSED',
        humanReadableReason: 'Subscription is paused; recurring recovery is paused until resumption.'
      };
    }

    // 4. Subscription expired
    const hasExpired = events.some((e) =>
      e.eventType === 'subscription.expired' ||
      e.eventType === 'SUBSCRIPTION_EXPIRED' ||
      e.rawPayload?.subscriptionExpired === true
    );
    if (hasExpired) {
      return {
        stop: true,
        actionDisposition: 'HARD_STOP',
        reasonCode: 'SUBSCRIPTION_EXPIRED',
        humanReadableReason: 'Subscription billing agreement or mandate has expired.'
      };
    }

    // 5. Retry exhausted (>= 3 attempts)
    const latestEvent = events.at(-1);
    const rawLatest = latestEvent?.rawPayload || {};
    const attemptNumber = Number.isInteger(rawLatest.attemptNumber) ? rawLatest.attemptNumber : 1;
    const retryFailuresCount = events.filter((e) => e.eventType === 'subscription.renewal_failed' || e.eventType === 'SUBSCRIPTION_RENEWAL_FAILED').length;

    if (attemptNumber >= 3 || retryFailuresCount >= 3) {
      return {
        stop: true,
        actionDisposition: 'ESCALATE',
        reasonCode: 'RETRY_EXHAUSTED',
        humanReadableReason: 'Maximum automated subscription retry attempts (3) exhausted; human review required.'
      };
    }

    return null;
  }
};

module.exports = failedSubscriptionPlaybook;
