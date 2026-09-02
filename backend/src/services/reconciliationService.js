const OUTCOME_EVENT_TYPES = new Set([
  'payment_link.paid',
  'payment_link.partially_paid',
  'payment.captured',
  'payment.succeeded',
  'order.paid'
]);

function isOutcomeEvent(eventType) {
  return OUTCOME_EVENT_TYPES.has(eventType);
}

/**
 * Reconciles an incoming payment outcome event against executed RecoveryActions.
 *
 * Correlation Strategy (in strict priority order):
 * 1. Match by Payment Link ID (action.providerActionId == event.paymentLinkId)
 * 2. Match by Reference ID (action.idempotencyKey == event.referenceId)
 * 3. Match by Case Payment ID or Order ID (recovery_case.payment_id == event.paymentId or recovery_case.order_id == event.orderId)
 *
 * @param {object} repository
 * @param {object} event - normalized event
 * @returns {Promise<object>} reconciliation result
 */
async function reconcileOutcome(repository, event) {
  if (!isOutcomeEvent(event.eventType)) {
    return { isOutcome: false, reconciled: false };
  }

  // 1. Check if an outcome record for this provider event was already created (idempotent duplicate delivery)
  const existingEventOutcome = await repository.findOutcomeByEventId('razorpay', event.eventId);
  if (existingEventOutcome) {
    const recoveryCase = await repository.findCaseByPaymentId(event.paymentId)
      || (existingEventOutcome.recoveryCaseId ? (await repository.getCaseDetail(existingEventOutcome.recoveryCaseId))?.recoveryCase : null);
    return {
      isOutcome: true,
      reconciled: existingEventOutcome.verified,
      duplicate: true,
      outcome: existingEventOutcome,
      recoveryCase
    };
  }

  // 2. Correlate with RecoveryAction
  let action = null;
  let recoveryCase = null;

  // Strategy 1: Match by Payment Link ID
  if (event.paymentLinkId) {
    action = await repository.findActionByPaymentLinkId(event.paymentLinkId);
  }

  // Strategy 2: Match by Reference ID (idempotency key)
  if (!action && event.referenceId) {
    action = await repository.findActionByIdempotencyKey(event.referenceId);
  }

  // Strategy 3: Match by Case's payment ID or order ID (unambiguous case correlation fallback)
  if (!action && event.paymentId) {
    recoveryCase = await repository.findCaseByPaymentId(event.paymentId);
    if (recoveryCase) {
      const actions = await repository.findActionsByCaseId(recoveryCase.id);
      const candidateAction = actions.find((a) => a.actionType === 'CREATE_PAYMENT_LINK' && ['EXECUTED', 'OUTCOME_CONFIRMED'].includes(a.status));
      if (candidateAction) {
        // Guard for Strategy 3: A direct payment on original paymentId cannot precede action creation
        if (event.timestamp && candidateAction.createdAt) {
          const eventTime = new Date(event.timestamp).getTime();
          const actionTime = new Date(candidateAction.createdAt).getTime();
          if (eventTime >= actionTime - 5000) {
            action = candidateAction;
          }
        } else {
          action = candidateAction;
        }
      }
    }
  }

  if (action && !recoveryCase) {
    const caseDetail = await repository.getCaseDetail(action.recoveryCaseId);
    recoveryCase = caseDetail?.recoveryCase || null;
  }

  // If no action correlated:
  if (!action || !recoveryCase) {
    return {
      isOutcome: true,
      reconciled: false,
      unmatched: true,
      action: null,
      recoveryCase: recoveryCase || null
    };
  }

  // 3. Idempotency Guard on Action: Check if this action was already confirmed with a verified outcome
  const existingActionOutcome = await repository.findOutcomeByActionId(action.id);
  if (existingActionOutcome && existingActionOutcome.verified) {
    return {
      isOutcome: true,
      reconciled: true,
      alreadyReconciled: true,
      outcome: existingActionOutcome,
      recoveryCase,
      action
    };
  }

  // 3b. TOCTOU Guard: If action is SUPERSEDED or case is already settled as PAID (externally)
  if (action.status === 'SUPERSEDED' || (recoveryCase.riskStatus === 'RESOLVED' && recoveryCase.outcome === 'PAID')) {
    const supersededOutcome = await repository.createOutcome({
      recoveryCaseId: recoveryCase.id,
      recoveryActionId: action.id,
      provider: 'razorpay',
      providerEventId: event.eventId,
      providerPaymentLinkId: event.paymentLinkId || action.providerActionId || null,
      providerPaymentId: event.paymentId || null,
      providerOrderId: event.orderId || null,
      amountExpected: Number(action.amount),
      amountPaid: Number(event.amountPaid !== undefined ? event.amountPaid : event.amount),
      currency: (event.currency || 'INR').toUpperCase(),
      outcome: 'SUPERSEDED_IGNORED',
      verified: false,
      verificationReason: 'SUPERSEDED_ACTION_IGNORED: Case was already resolved by prior payment; no duplicate recovery credit attributed.',
      providerTimestamp: event.timestamp || new Date().toISOString()
    });

    await repository.addAudit(recoveryCase.id, 'RECOVERY_OUTCOME_REJECTED', 'Payment received on superseded recovery link. No recovery credit attributed.', {
      actionId: action.id,
      outcomeId: supersededOutcome.id,
      providerPaymentLinkId: event.paymentLinkId || action.providerActionId,
      reason: 'SUPERSEDED_ACTION_IGNORED'
    });

    return {
      isOutcome: true,
      reconciled: false,
      superseded: true,
      outcome: supersededOutcome,
      recoveryCase,
      action
    };
  }

  // 4. Amount and Currency Integrity Checks
  const expectedAmount = Number(action.amount);
  const paidAmount = Number(event.amountPaid !== undefined ? event.amountPaid : event.amount);
  const expectedCurrency = (action.currency || 'INR').toUpperCase();
  const receivedCurrency = (event.currency || 'INR').toUpperCase();

  const isCurrencyMatch = expectedCurrency === receivedCurrency;
  const isPartial = isCurrencyMatch && (event.eventType === 'payment_link.partially_paid');
  const isFullMatch = isCurrencyMatch && paidAmount === expectedAmount && event.eventType !== 'payment_link.partially_paid';

  // 5. Handle Partial Payment
  if (isPartial) {
    const partialOutcome = await repository.createOutcome({
      recoveryCaseId: recoveryCase.id,
      recoveryActionId: action.id,
      provider: 'razorpay',
      providerEventId: event.eventId,
      providerPaymentLinkId: event.paymentLinkId || action.providerActionId || null,
      providerPaymentId: event.paymentId || null,
      providerOrderId: event.orderId || null,
      amountExpected: expectedAmount,
      amountPaid: paidAmount,
      currency: receivedCurrency,
      outcome: 'PARTIALLY_PAID',
      verified: false,
      verificationReason: `Partial payment received: ₹${(paidAmount / 100).toLocaleString('en-IN')} paid of ₹${(expectedAmount / 100).toLocaleString('en-IN')} expected. Case remains open.`,
      providerTimestamp: event.timestamp || new Date().toISOString()
    });

    await repository.addAudit(recoveryCase.id, 'RECOVERY_OUTCOME_RECEIVED', `Partial payment received for Payment Link: ₹${(paidAmount / 100).toLocaleString('en-IN')} of ₹${(expectedAmount / 100).toLocaleString('en-IN')}`, {
      actionId: action.id,
      outcomeId: partialOutcome.id,
      amountExpected: expectedAmount,
      amountPaid: paidAmount,
      currency: receivedCurrency
    });

    return {
      isOutcome: true,
      reconciled: false,
      partial: true,
      outcome: partialOutcome,
      recoveryCase,
      action
    };
  }

  // 6. Handle Mismatch (Wrong Amount or Wrong Currency)
  if (!isFullMatch) {
    const mismatchReason = !isCurrencyMatch
      ? `Currency mismatch: expected ${expectedCurrency}, received ${receivedCurrency}`
      : `Amount mismatch: expected ₹${(expectedAmount / 100).toLocaleString('en-IN')}, received ₹${(paidAmount / 100).toLocaleString('en-IN')}`;

    const rejectedOutcome = await repository.createOutcome({
      recoveryCaseId: recoveryCase.id,
      recoveryActionId: action.id,
      provider: 'razorpay',
      providerEventId: event.eventId,
      providerPaymentLinkId: event.paymentLinkId || action.providerActionId || null,
      providerPaymentId: event.paymentId || null,
      providerOrderId: event.orderId || null,
      amountExpected: expectedAmount,
      amountPaid: paidAmount,
      currency: receivedCurrency,
      outcome: 'FAILED_MISMATCH',
      verified: false,
      verificationReason: mismatchReason,
      providerTimestamp: event.timestamp || new Date().toISOString()
    });

    await repository.addAudit(recoveryCase.id, 'RECOVERY_OUTCOME_REJECTED', `Recovery outcome rejected: ${mismatchReason}`, {
      actionId: action.id,
      outcomeId: rejectedOutcome.id,
      amountExpected: expectedAmount,
      amountPaid: paidAmount,
      expectedCurrency,
      receivedCurrency
    });

    const updatedCase = await repository.updateCase(recoveryCase.id, {
      actionStatus: 'REVIEW_REQUIRED',
      riskReason: `Reconciliation error: ${mismatchReason}`,
      lastEventAt: event.timestamp || new Date().toISOString()
    });

    return {
      isOutcome: true,
      reconciled: false,
      mismatch: true,
      outcome: rejectedOutcome,
      recoveryCase: updatedCase,
      action
    };
  }

  // 7. Full Verified Recovery Transition
  const verifiedOutcome = await repository.createOutcome({
    recoveryCaseId: recoveryCase.id,
    recoveryActionId: action.id,
    provider: 'razorpay',
    providerEventId: event.eventId,
    providerPaymentLinkId: event.paymentLinkId || action.providerActionId || null,
    providerPaymentId: event.paymentId || null,
    providerOrderId: event.orderId || null,
    amountExpected: expectedAmount,
    amountPaid: paidAmount,
    currency: receivedCurrency,
    outcome: 'PAID',
    verified: true,
    verificationReason: 'Payment verified by Razorpay webhook: full amount and currency match.',
    providerTimestamp: event.timestamp || new Date().toISOString()
  });

  // Transition Action: EXECUTED -> OUTCOME_CONFIRMED
  const updatedAction = await repository.updateAction(action.id, {
    status: 'OUTCOME_CONFIRMED',
    completedAt: new Date().toISOString()
  });

  // Transition Case: -> RESOLVED, outcome 'RECOVERED', recoveredAmount = paidAmount
  const updatedCase = await repository.updateCase(recoveryCase.id, {
    riskStatus: 'RESOLVED',
    riskReason: 'Revenue successfully recovered via verified Payment Link',
    riskLevel: 'LOW',
    actionStatus: 'RECOVERED',
    outcome: 'RECOVERED',
    recoveredAmount: paidAmount,
    lastEventAt: event.timestamp || new Date().toISOString()
  });

  // Record Audit Trail Sequence
  await repository.addAudit(recoveryCase.id, 'RECOVERY_OUTCOME_RECEIVED', `Received provider outcome event: ${event.eventType}`, {
    eventId: event.eventId,
    eventType: event.eventType,
    paymentLinkId: event.paymentLinkId || action.providerActionId
  });

  await repository.addAudit(recoveryCase.id, 'RECOVERY_OUTCOME_VERIFIED', `Recovery outcome verified for Payment Link ${action.providerActionId || action.id} (₹${(paidAmount / 100).toLocaleString('en-IN')} ${receivedCurrency})`, {
    actionId: action.id,
    outcomeId: verifiedOutcome.id,
    amount: paidAmount,
    currency: receivedCurrency
  });

  await repository.addAudit(recoveryCase.id, 'REVENUE_RECOVERED', `Revenue of ₹${(paidAmount / 100).toLocaleString('en-IN')} recovered successfully`, {
    amount: paidAmount,
    currency: receivedCurrency,
    paymentId: event.paymentId
  });

  await repository.addAudit(recoveryCase.id, 'CASE_UPDATED', 'Recovery case resolved after verified customer payment', {
    status: 'RESOLVED',
    outcome: 'RECOVERED',
    recoveredAmount: paidAmount
  });

  return {
    isOutcome: true,
    reconciled: true,
    outcome: verifiedOutcome,
    action: updatedAction,
    recoveryCase: updatedCase
  };
}

module.exports = { reconcileOutcome, isOutcomeEvent, OUTCOME_EVENT_TYPES };
