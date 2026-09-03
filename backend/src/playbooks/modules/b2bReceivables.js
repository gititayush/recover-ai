/**
 * Revflow V2 — B2B Receivables & Unpaid Invoice Recovery Playbook
 *
 * Manages commercial B2B overdue invoices, corporate payment delays,
 * and dispute-aware accounts receivable recovery.
 *
 * Sequences bounded recovery interventions (structured corporate reminders,
 * bounded Payment Link, outreach, manual review) while enforcing
 * commercial B2B stopping rules (dispute, cancellation, pre-due terms, collection window expiry).
 */

const INVOICE_TRIGGER_EVENTS = new Set([
  'invoice.created',
  'invoice.due',
  'invoice.overdue',
  'invoice.payment_failed',
  'invoice.paid',
  'invoice.disputed',
  'invoice.cancelled',
  'INVOICE_CREATED',
  'INVOICE_DUE',
  'INVOICE_OVERDUE',
  'INVOICE_PAYMENT_FAILED',
  'INVOICE_PAID',
  'INVOICE_DISPUTED',
  'INVOICE_CANCELLED'
]);

const ACTIONABLE_INVOICE_EVENTS = new Set([
  'invoice.overdue',
  'invoice.payment_failed',
  'INVOICE_OVERDUE',
  'INVOICE_PAYMENT_FAILED'
]);

const b2bReceivablesPlaybook = {
  id: 'b2b_receivables',
  name: 'B2B Receivables & Unpaid Invoice Recovery',
  domain: 'B2B / Corporate Invoicing',
  flagship: false,
  priority: 100,

  /**
   * Evaluates if this playbook handles the incoming event.
   *
   * @param {object} event
   * @returns {boolean}
   */
  matchesEvent(event) {
    if (!event) return false;
    if (event.playbook === 'b2b_receivables') return true;
    const eventType = String(event.eventType || '');
    if (INVOICE_TRIGGER_EVENTS.has(eventType) || INVOICE_TRIGGER_EVENTS.has(eventType.toLowerCase())) {
      return true;
    }
    const raw = event.rawPayload || {};
    if (raw.invoiceId || raw.invoiceNumber || raw.paymentTerms || raw.daysOverdue !== undefined) {
      return true;
    }
    return false;
  },

  /**
   * Assesses recovery risk and initial case eligibility.
   *
   * @param {object} event
   * @param {Array} eventHistory
   * @returns {object}
   */
  assessRisk(event, eventHistory = []) {
    const raw = event.rawPayload || {};
    const eventType = String(event.eventType || '');

    // 1. Terminal paid
    const terminalPaidEvents = ['invoice.paid', 'payment.captured', 'payment.succeeded', 'order.paid', 'INVOICE_PAID'];
    if (terminalPaidEvents.includes(eventType) || raw.invoicePaid === true || raw.paid === true) {
      return { terminal: true, outcome: 'PAID', actionable: false };
    }
    if (eventHistory.some((h) => terminalPaidEvents.includes(h.eventType) || h.rawPayload?.invoicePaid === true || h.paymentStatus === 'paid')) {
      return { terminal: false, actionable: false, terminalAlreadyKnown: true };
    }

    // 2. Cancellation check (HARD_STOP)
    if (eventType === 'invoice.cancelled' || eventType === 'INVOICE_CANCELLED' || raw.invoiceCancelled === true) {
      return { terminal: true, outcome: 'CANCELLED', actionable: false };
    }

    // 3. Dispute check
    if (eventType === 'invoice.disputed' || eventType === 'INVOICE_DISPUTED' || raw.disputed === true) {
      return { terminal: false, actionable: false, disputed: true, reason: 'Invoice is under formal commercial dispute.' };
    }

    // 4. Amount validation
    const amount = Number(event.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return { terminal: false, actionable: false, invalidAmount: true, reason: 'Invalid or missing invoice amount in paise.' };
    }

    // 5. Currency validation
    const currency = (event.currency || 'INR').toUpperCase();
    if (currency !== 'INR') {
      return { terminal: false, actionable: false, invalidCurrency: true, reason: 'Only INR is supported for B2B receivables recovery.' };
    }

    // 6. Terms not reached check (due date in future or daysOverdue < 0)
    const daysOverdue = typeof raw.daysOverdue === 'number' ? raw.daysOverdue : (event.daysOverdue ?? 0);
    const dueDate = raw.dueDate || event.dueDate;
    if (dueDate && new Date(dueDate).getTime() > Date.now() && daysOverdue <= 0) {
      return {
        terminal: false,
        actionable: false,
        termsNotReached: true,
        reason: 'Invoice payment terms not yet reached; invoice is not yet overdue.'
      };
    }

    // 7. Actionability by Event Type
    const isActionable = ACTIONABLE_INVOICE_EVENTS.has(eventType) || raw.isOverdue === true || daysOverdue > 0;
    if (!isActionable) {
      return {
        terminal: false,
        actionable: false,
        stage: eventType,
        reason: 'Invoice event is informational and not currently actionable for recovery.'
      };
    }

    // 8. Collection window expired check (> 180 days)
    const isWindowExpired = daysOverdue > 180;

    const failureReason = event.failureReason
      || raw.failureReason
      || (daysOverdue > 0 ? `Commercial invoice overdue by ${daysOverdue} days` : 'B2B invoice payment overdue');

    // High value threshold: ₹25,000 (2,500,000 paise) or overdue > 60 days or window expired
    const riskLevel = amount >= 2500000 || daysOverdue >= 60 || isWindowExpired ? 'HIGH' : 'MEDIUM';

    return {
      terminal: false,
      actionable: true,
      riskStatus: 'RECOVERABLE',
      riskLevel,
      riskReason: `B2B Receivables Recovery: ${failureReason}`,
      playbook: 'b2b_receivables',
      failureReason,
      daysOverdue,
      isWindowExpired
    };
  },

  /**
   * Extracts un-hallucinated domain facts for AI diagnosis and policy evaluation.
   *
   * @param {object} event
   * @param {object} caseDetail
   * @returns {object}
   */
  extractContext(event, caseDetail) {
    const raw = event?.rawPayload || caseDetail?.recoveryCase?.metadata || {};
    return {
      playbook: 'b2b_receivables',
      invoiceId: raw.invoiceId || event?.paymentId || caseDetail?.recoveryCase?.paymentId || null,
      customerReference: raw.customerReference || event?.customerReference || caseDetail?.recoveryCase?.customerReference || null,
      amount: event?.amount || caseDetail?.recoveryCase?.amount || null,
      currency: (event?.currency || caseDetail?.recoveryCase?.currency || 'INR').toUpperCase(),
      issueDate: raw.issueDate || null,
      dueDate: raw.dueDate || event?.dueDate || null,
      daysOverdue: typeof raw.daysOverdue === 'number' ? raw.daysOverdue : (typeof event?.daysOverdue === 'number' ? event.daysOverdue : 0),
      paymentTerms: raw.paymentTerms || null,
      invoiceStatus: raw.invoiceStatus || (event?.eventType ? event.eventType.split('.')[1]?.toUpperCase() : 'OVERDUE'),
      disputeStatus: raw.disputed ? 'DISPUTED' : 'NONE',
      lastPaymentAttempt: raw.lastPaymentAttempt || null,
      lastFailureReason: event?.failureReason || raw.failureReason || null
    };
  },

  /**
   * Returns authoritative candidate actions supported for B2B receivables.
   *
   * @param {object} context
   * @returns {Array<string>}
   */
  getCandidateActions(context) {
    return [
      'INVOICE_REMINDER',
      'CREATE_PAYMENT_LINK',
      'CUSTOMER_OUTREACH',
      'REQUEST_MANUAL_REVIEW',
      'NO_ACTION'
    ];
  },

  /**
   * Evaluates B2B-specific domain stopping criteria and policy constraints.
   *
   * @param {object} caseDetail
   * @param {string} candidateAction
   * @param {Function} [now]
   * @returns {object|null}
   */
  evaluateCustomPolicy(caseDetail, candidateAction, now = () => new Date()) {
    const { recoveryCase, events = [] } = caseDetail || {};

    // 1. Invoice already paid
    const hasPaid = events.some((e) =>
      e.eventType === 'invoice.paid' ||
      e.eventType === 'INVOICE_PAID' ||
      e.paymentStatus === 'paid' ||
      e.rawPayload?.invoicePaid === true ||
      e.rawPayload?.paid === true
    );
    if (hasPaid) {
      return {
        stop: true,
        actionDisposition: 'HARD_STOP',
        reasonCode: 'INVOICE_ALREADY_PAID',
        humanReadableReason: 'Invoice has already been settled and marked paid.'
      };
    }

    // 2. Invoice cancelled
    const hasCancelled = events.some((e) =>
      e.eventType === 'invoice.cancelled' ||
      e.eventType === 'INVOICE_CANCELLED' ||
      e.rawPayload?.invoiceCancelled === true
    );
    if (hasCancelled) {
      return {
        stop: true,
        actionDisposition: 'HARD_STOP',
        reasonCode: 'INVOICE_CANCELLED',
        humanReadableReason: 'Invoice was cancelled or voided by accounts receivable.'
      };
    }

    // 3. Invoice disputed
    const hasDispute = events.some((e) =>
      e.eventType === 'invoice.disputed' ||
      e.eventType === 'INVOICE_DISPUTED' ||
      e.rawPayload?.disputed === true
    );
    if (hasDispute) {
      return {
        stop: true,
        actionDisposition: 'HARD_STOP',
        reasonCode: 'INVOICE_DISPUTED',
        humanReadableReason: 'Invoice is under formal commercial dispute; recovery interventions are suspended.'
      };
    }

    // 4. Terms not reached (due date in future)
    const latestEvent = events.at(-1);
    const rawLatest = latestEvent?.rawPayload || {};
    const dueDate = rawLatest.dueDate || latestEvent?.dueDate;
    const daysOverdue = typeof rawLatest.daysOverdue === 'number' ? rawLatest.daysOverdue : (latestEvent?.daysOverdue ?? 0);

    if (dueDate && new Date(dueDate).getTime() > now().getTime() && daysOverdue <= 0) {
      return {
        stop: true,
        actionDisposition: 'WAIT',
        reasonCode: 'B2B_TERMS_NOT_REACHED',
        humanReadableReason: 'Invoice terms have not yet reached due date; payment is not yet overdue.'
      };
    }

    // 5. Collection window expired (> 180 days)
    if (daysOverdue > 180) {
      return {
        stop: true,
        actionDisposition: 'ESCALATE',
        reasonCode: 'COLLECTION_WINDOW_EXPIRED',
        humanReadableReason: `Invoice is ${daysOverdue} days overdue, exceeding maximum standard recovery window (180 days); human review required.`
      };
    }

    return null;
  }
};

module.exports = b2bReceivablesPlaybook;
