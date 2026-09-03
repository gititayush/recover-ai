/**
 * Revflow V2 — Payment Degradation & Root Cause Recovery Playbook
 *
 * Core flagship playbook for payment gateway degradation, bank server downtime,
 * and 3D-Secure authentication timeouts.
 */

const { assessRisk } = require('../../risk/detector');

const paymentDegradationPlaybook = {
  id: 'payment_degradation',
  name: 'Payment Degradation & Root Cause Recovery',
  domain: 'Core Gateway / E-Commerce Checkout',
  flagship: true,

  matchesEvent(event) {
    if (!event) return false;
    const eventType = String(event.eventType || '').toLowerCase();
    return eventType === 'payment.failed' ||
      eventType.startsWith('payment.') ||
      eventType === 'order.paid' ||
      event.playbook === 'payment_degradation';
  },

  assessRisk(event, eventHistory = []) {
    return assessRisk(event, eventHistory);
  },

  extractContext(event, caseDetail) {
    return {
      playbook: 'payment_degradation',
      paymentId: event?.paymentId || caseDetail?.recoveryCase?.paymentId || null
    };
  },

  getCandidateActions(context) {
    return ['CREATE_PAYMENT_LINK', 'CUSTOMER_OUTREACH', 'DISPATCH_VERNACULAR_ASSIST', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'];
  },

  evaluateCustomPolicy(caseDetail, candidateAction, now) {
    return null; // Standard financial policy engine handles all checks
  }
};

module.exports = paymentDegradationPlaybook;
