/**
 * Revflow V2 — Checkout Drop-off Recovery Playbook
 *
 * Recovers high-intent carts abandoned at or near the payment step.
 * Preserves cart context, detects customer hesitation, and sequences
 * bounded recovery interventions (Payment Link or simulated cart recovery).
 */

const CHECKOUT_TRIGGER_EVENTS = new Set([
  'checkout.started',
  'checkout.progress',
  'checkout.payment_step_reached',
  'checkout.abandoned',
  'checkout.drop_off',
  'checkout.completed',
  'checkout.cancelled',
  'CHECKOUT_STARTED',
  'CHECKOUT_PROGRESS',
  'PAYMENT_STEP_REACHED',
  'CHECKOUT_DROP_OFF_DETECTED',
  'CHECKOUT_ABANDONED'
]);

const ACTIONABLE_CHECKOUT_EVENTS = new Set([
  'checkout.payment_step_reached',
  'checkout.abandoned',
  'checkout.drop_off',
  'PAYMENT_STEP_REACHED',
  'CHECKOUT_DROP_OFF_DETECTED',
  'CHECKOUT_ABANDONED'
]);

const checkoutDropOffPlaybook = {
  id: 'checkout_drop_off',
  name: 'Checkout Drop-off Recovery',
  domain: 'High-Intent Cart Abandonment',
  flagship: false,

  matchesEvent(event) {
    if (!event) return false;
    if (event.playbook === 'checkout_drop_off') return true;
    const eventType = String(event.eventType || '');
    if (CHECKOUT_TRIGGER_EVENTS.has(eventType) || CHECKOUT_TRIGGER_EVENTS.has(eventType.toLowerCase())) return true;
    const raw = event.rawPayload || {};
    if (raw.checkoutSessionId || raw.checkoutStage || raw.cartReference) return true;
    return false;
  },

  assessRisk(event, eventHistory = []) {
    const raw = event.rawPayload || {};
    const eventType = String(event.eventType || '');

    // 1. Terminal payment / order / completion check
    const terminalEvents = ['order.paid', 'payment.captured', 'payment.succeeded', 'checkout.completed'];
    if (terminalEvents.includes(eventType) || raw.checkoutCompleted === true || raw.orderPaid === true) {
      return { terminal: true, outcome: 'PAID', actionable: false };
    }
    if (eventHistory.some((h) => terminalEvents.includes(h.eventType) || h.rawPayload?.checkoutCompleted === true || h.paymentStatus === 'paid')) {
      return { terminal: false, actionable: false, terminalAlreadyKnown: true };
    }

    // 2. Cancellation / Customer Opt-out check
    if (eventType === 'checkout.cancelled' || raw.customerOptOut === true || raw.customerCancelled === true) {
      return { terminal: true, outcome: 'OPTED_OUT', actionable: false };
    }

    // 3. Stale check (> 24 hours / 1440 minutes since event activity)
    const eventTime = new Date(event.timestamp || event.occurredAt || Date.now()).getTime();
    const ageMinutes = Math.max(0, Math.floor((Date.now() - eventTime) / 60000));
    if (ageMinutes > 1440) {
      return { terminal: false, actionable: false, stale: true, reason: 'Checkout session is older than 24 hours.' };
    }

    // 4. Actionability by Stage:
    // Only actionable if payment step reached or abandonment/drop-off is explicitly detected
    const stage = String(raw.checkoutStage || '').toUpperCase();
    const isPaymentStepOrAbandoned = ACTIONABLE_CHECKOUT_EVENTS.has(eventType) ||
      ['PAYMENT_STEP', 'PAYMENT_STEP_REACHED', 'CHECKOUT_DROP_OFF_DETECTED', 'ABANDONED'].includes(stage);

    if (!isPaymentStepOrAbandoned) {
      // Incomplete checkout in earlier stage (e.g. cart viewed or address entered without drop-off)
      return {
        terminal: false,
        actionable: false,
        stage: raw.checkoutStage || 'IN_PROGRESS',
        reason: 'Checkout has not reached payment step or recorded drop-off.'
      };
    }

    // 5. Amount validation
    const amount = Number(event.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return { terminal: false, actionable: false, invalidAmount: true, reason: 'Invalid or missing amount for checkout recovery.' };
    }

    // 6. Currency validation
    const currency = (event.currency || 'INR').toUpperCase();
    if (currency !== 'INR') {
      return { terminal: false, actionable: false, invalidCurrency: true, reason: 'Only INR is supported.' };
    }

    const failureReason = event.failureReason
      || raw.abandonmentReason
      || (stage ? `Checkout abandoned at ${stage}` : 'Checkout drop-off after payment step reached');

    const riskLevel = amount >= 1000000 ? 'HIGH' : 'MEDIUM';

    return {
      terminal: false,
      actionable: true,
      riskStatus: 'RECOVERABLE',
      riskLevel,
      riskReason: `Checkout drop-off: ${failureReason}`,
      playbook: 'checkout_drop_off',
      failureReason
    };
  },

  extractContext(event, caseDetail) {
    const raw = event?.rawPayload || caseDetail?.recoveryCase?.metadata || {};
    return {
      playbook: 'checkout_drop_off',
      checkoutSessionId: raw.checkoutSessionId || event?.paymentId || caseDetail?.recoveryCase?.paymentId || null,
      orderId: event?.orderId || raw.orderId || caseDetail?.recoveryCase?.orderId || null,
      cartReference: raw.cartReference || event?.customerReference || caseDetail?.recoveryCase?.customerReference || null,
      cartAmount: event?.amount || caseDetail?.recoveryCase?.amount || null,
      currency: (event?.currency || caseDetail?.recoveryCase?.currency || 'INR').toUpperCase(),
      checkoutStage: raw.checkoutStage || 'PAYMENT_STEP_REACHED',
      lastActivityAt: event?.timestamp || raw.lastActivityAt || null,
      itemCount: Number.isInteger(raw.itemCount) ? raw.itemCount : null,
      paymentMethodAttempt: raw.paymentMethodAttempt || null,
      abandonmentReason: event?.failureReason || raw.abandonmentReason || null
    };
  },

  getCandidateActions(context) {
    return ['CREATE_PAYMENT_LINK', 'CHECKOUT_RECOVERY', 'CUSTOMER_OUTREACH', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'];
  },

  evaluateCustomPolicy(caseDetail, candidateAction, now = () => new Date()) {
    const { recoveryCase, events = [] } = caseDetail || {};

    // 1. Checkout already completed / paid order
    const hasCompleted = events.some((e) =>
      e.eventType === 'checkout.completed' ||
      e.eventType === 'order.paid' ||
      e.paymentStatus === 'paid' ||
      e.paymentStatus === 'captured' ||
      e.rawPayload?.checkoutCompleted === true
    );
    if (hasCompleted) {
      return {
        stop: true,
        actionDisposition: 'HARD_STOP',
        reasonCode: 'CHECKOUT_ALREADY_COMPLETED',
        humanReadableReason: 'Checkout session has already completed with a successful payment.'
      };
    }

    // 2. Customer explicitly cancelled or opted out
    const hasCancelled = events.some((e) =>
      e.eventType === 'checkout.cancelled' ||
      e.rawPayload?.customerCancelled === true ||
      e.rawPayload?.customerOptOut === true
    );
    if (hasCancelled) {
      return {
        stop: true,
        actionDisposition: 'HARD_STOP',
        reasonCode: 'CUSTOMER_OPT_OUT',
        humanReadableReason: 'Customer explicitly cancelled checkout or opted out of recovery.'
      };
    }

    // 3. Stale / Expired checkout session (> 24 hours / 1440 minutes)
    const referenceTimestamp = recoveryCase?.lastEventAt || recoveryCase?.firstDetectedAt;
    if (referenceTimestamp) {
      const ageMinutes = Math.max(0, Math.floor((now().getTime() - new Date(referenceTimestamp).getTime()) / 60000));
      if (ageMinutes > 1440) {
        return {
          stop: true,
          actionDisposition: 'HARD_STOP',
          reasonCode: 'CHECKOUT_EXPIRED',
          humanReadableReason: `Checkout session expired (${Math.floor(ageMinutes / 60)} hours since last activity; maximum permitted is 24 hours).`
        };
      }
    }

    return null;
  }
};

module.exports = checkoutDropOffPlaybook;
