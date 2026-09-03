/**
 * Revflow V2 — Failure Intelligence Engine
 * Canonical Failure Taxonomy & Deterministic Evidence Extractor
 *
 * CORE INVARIANT:
 * Provider telemetry is authoritative for facts.
 * When provider telemetry is generic or absent, Revflow MUST classify as UNKNOWN_FAILURE
 * with low confidence and explicit unknowns. Never hallucinate a root cause.
 */

const FAILURE_FAMILIES = [
  'GATEWAY_TECHNICAL_FAILURE',
  'BANK_SWITCH_TIMEOUT',
  'AUTHENTICATION_FAILURE',
  'INSUFFICIENT_FUNDS',
  'PAYMENT_METHOD_EXPIRED',
  'LIMIT_EXCEEDED',
  'MANDATE_FAILURE',
  'SUBSCRIPTION_FAILURE',
  'B2B_RECEIVABLE_DELAY',
  'CHECKOUT_ABANDONMENT',
  'PAYMENT_DEGRADATION',
  'UNKNOWN_FAILURE'
];

const GENERIC_FAILURE_STRINGS = new Set([
  'payment failed',
  'payment_failed',
  'failed',
  'transaction failed',
  'error',
  'unknown'
]);

/**
 * Extracts raw facts from Razorpay or generic event payloads.
 * Looks into both top-level event fields and rawPayload.payload.payment.entity.
 */
function extractProviderEvidence(rawPayload = {}, event = {}) {
  const paymentEntity = rawPayload?.payload?.payment?.entity
    || rawPayload?.payment?.entity
    || (rawPayload?.entity === 'payment' ? rawPayload : null)
    || rawPayload?.payment
    || {};

  const paymentLinkEntity = rawPayload?.payload?.payment_link?.entity
    || rawPayload?.payment_link?.entity
    || (rawPayload?.entity === 'payment_link' ? rawPayload : null)
    || {};

  // Extract provider diagnostic fields
  const providerErrorCode = paymentEntity.error_code
    || rawPayload.error_code
    || event.errorCode
    || null;

  const providerErrorSource = paymentEntity.error_source
    || rawPayload.error_source
    || null;

  const providerErrorStep = paymentEntity.error_step
    || rawPayload.error_step
    || null;

  const providerErrorDescription = paymentEntity.error_description
    || rawPayload.error_description
    || null;

  const providerErrorReason = paymentEntity.error_reason
    || rawPayload.error_reason
    || null;

  const paymentMethod = paymentEntity.method
    || rawPayload.method
    || paymentLinkEntity.method
    || null;

  let failureReason = event.failureReason
    || providerErrorDescription
    || providerErrorReason
    || providerErrorCode
    || null;

  const eventType = event.eventType || '';
  if (!failureReason && eventType) {
    if (eventType.startsWith('subscription.')) {
      failureReason = 'Subscription renewal debit failed';
    } else if (eventType.startsWith('invoice.')) {
      failureReason = 'Invoice payment overdue or failed';
    } else if (eventType.startsWith('checkout.')) {
      failureReason = 'Checkout abandoned during payment flow';
    }
  }

  const status = event.paymentStatus
    || paymentEntity.status
    || 'failed';

  const attemptCount = event.attemptCount || event.paymentAttemptCount || 1;
  const timestamp = event.timestamp || rawPayload.created_at || new Date().toISOString();

  // Determine evidence strength
  const trimmedReason = (failureReason || '').trim().toLowerCase();
  const isGenericReason = !failureReason || GENERIC_FAILURE_STRINGS.has(trimmedReason);
  const hasSpecificCode = Boolean(providerErrorCode && !GENERIC_FAILURE_STRINGS.has(providerErrorCode.toLowerCase()));
  const hasSpecificSource = Boolean(providerErrorSource);
  const hasSpecificStep = Boolean(providerErrorStep);
  const hasDetailedDescription = Boolean(
    providerErrorDescription &&
    !GENERIC_FAILURE_STRINGS.has(providerErrorDescription.trim().toLowerCase()) &&
    providerErrorDescription.trim().length > 15
  );

  let evidenceStrength = 'NONE';
  if (hasSpecificCode || (hasSpecificSource && hasSpecificStep) || eventType.startsWith('subscription.') || eventType.startsWith('invoice.') || eventType.startsWith('checkout.')) {
    evidenceStrength = 'STRONG';
  } else if (isGenericReason) {
    evidenceStrength = 'MINIMAL';
  } else if (failureReason && failureReason.length > 0) {
    evidenceStrength = 'PARTIAL';
  } else {
    evidenceStrength = 'MINIMAL';
  }

  // Canonical deterministic signature
  const sigParts = [
    providerErrorSource || 'unknown_source',
    providerErrorStep || 'unknown_step',
    providerErrorCode || (isGenericReason ? 'unspecified_error' : failureReason?.replace(/\s+/g, '_').toLowerCase())
  ];
  const failureSignature = sigParts.join('|');

  return {
    status,
    failureReason,
    providerErrorCode,
    providerErrorSource,
    providerErrorStep,
    providerErrorDescription,
    providerErrorReason,
    paymentMethod,
    attemptCount,
    timestamp,
    evidenceStrength,
    failureSignature
  };
}

/**
 * Deterministic classifier based strictly on verified provider facts.
 */
function classifyFailureEvidence(providerEvidence) {
  const {
    evidenceStrength,
    failureReason,
    providerErrorCode,
    providerErrorSource,
    providerErrorStep,
    providerErrorDescription
  } = providerEvidence;

  const combinedText = [
    failureReason || '',
    providerErrorCode || '',
    providerErrorSource || '',
    providerErrorStep || '',
    providerErrorDescription || ''
  ].join(' ').toLowerCase();

  // If evidence is MINIMAL or NONE, honest abstention is required
  if (evidenceStrength === 'NONE' || evidenceStrength === 'MINIMAL') {
    return {
      failureFamily: 'UNKNOWN_FAILURE',
      failureType: 'INSUFFICIENT_PROVIDER_TELEMETRY',
      confidence: 0.25,
      classificationBasis: ['payment.status'],
      unknowns: [
        'Provider supplied only generic failure status without technical error codes.',
        'Issuer bank and upstream payment switch response codes were omitted.',
        'Customer device and authentication state cannot be determined from available data.'
      ]
    };
  }

  // Bank switch / Gateway network timeout
  if (
    combinedText.includes('timeout') ||
    combinedText.includes('switch') ||
    combinedText.includes('gateway_timeout') ||
    (providerErrorCode === 'BAD_REQUEST_ERROR' && combinedText.includes('timeout')) ||
    (providerErrorSource === 'bank' && combinedText.includes('timeout'))
  ) {
    const classificationBasis = [];
    if (providerErrorCode) classificationBasis.push('provider.errorCode');
    if (providerErrorSource) classificationBasis.push('provider.errorSource');
    if (providerErrorStep) classificationBasis.push('provider.errorStep');
    if (failureReason) classificationBasis.push('payment.failureReason');

    return {
      failureFamily: 'BANK_SWITCH_TIMEOUT',
      failureType: 'ISSUER_SWITCH_TIMEOUT',
      confidence: evidenceStrength === 'STRONG' ? 0.88 : 0.70,
      classificationBasis,
      unknowns: [
        'Customer account balance at issuer bank is unverified.',
        'Issuer switch recovery latency is not guaranteed.'
      ]
    };
  }

  // Insufficient Funds / Credit Limit
  if (
    combinedText.includes('insufficient') ||
    combinedText.includes('balance') ||
    combinedText.includes('limit_exceeded') ||
    providerErrorCode === 'INSUFFICIENT_FUNDS'
  ) {
    const classificationBasis = [];
    if (providerErrorCode) classificationBasis.push('provider.errorCode');
    if (providerErrorDescription) classificationBasis.push('provider.errorDescription');
    if (failureReason) classificationBasis.push('payment.failureReason');

    return {
      failureFamily: 'INSUFFICIENT_FUNDS',
      failureType: 'ACCOUNT_INSUFFICIENT_BALANCE',
      confidence: evidenceStrength === 'STRONG' ? 0.90 : 0.75,
      classificationBasis,
      unknowns: [
        'Customer exact available balance is private to the issuer bank.',
        'Secondary payment instrument availability is unconfirmed.'
      ]
    };
  }

  // Authentication failure (OTP / 3DS)
  if (
    combinedText.includes('otp') ||
    combinedText.includes('3ds') ||
    combinedText.includes('auth') ||
    providerErrorStep === 'payment_authentication'
  ) {
    const classificationBasis = [];
    if (providerErrorStep) classificationBasis.push('provider.errorStep');
    if (providerErrorCode) classificationBasis.push('provider.errorCode');
    if (failureReason) classificationBasis.push('payment.failureReason');

    return {
      failureFamily: 'AUTHENTICATION_FAILURE',
      failureType: '3DS_OTP_VERIFICATION_FAILED',
      confidence: evidenceStrength === 'STRONG' ? 0.85 : 0.68,
      classificationBasis,
      unknowns: [
        'Whether user abandoned OTP screen or entered invalid credential.',
        'Cellular SMS delivery latency to customer handset.'
      ]
    };
  }

  // Gateway Technical Failure
  if (
    providerErrorSource === 'gateway' ||
    combinedText.includes('gateway_error') ||
    combinedText.includes('server_error')
  ) {
    const classificationBasis = [];
    if (providerErrorSource) classificationBasis.push('provider.errorSource');
    if (providerErrorCode) classificationBasis.push('provider.errorCode');
    if (failureReason) classificationBasis.push('payment.failureReason');

    return {
      failureFamily: 'GATEWAY_TECHNICAL_FAILURE',
      failureType: 'ACQUIRING_GATEWAY_ERROR',
      confidence: 0.82,
      classificationBasis,
      unknowns: [
        'Root cause of gateway downtime (network partition vs deployment).',
        'Upstream payment gateway MTTR (Mean Time To Recovery).'
      ]
    };
  }

  // Fallback if none matched
  return {
    failureFamily: 'PAYMENT_DEGRADATION',
    failureType: 'TRANSIENT_GATEWAY_DROP',
    confidence: 0.50,
    classificationBasis: failureReason ? ['payment.failureReason'] : ['payment.status'],
    unknowns: [
      'Specific technical failure reason was not categorized by provider.'
    ]
  };
}

/**
 * Guardrail that inspects an AI proposal and enforces honesty.
 * If AI claims a specific technical cause without supporting evidence, it overrides the claim.
 */
function guardFailureClassification(proposal, providerEvidence, contextFacts = {}, context = {}) {
  const { evidenceStrength } = providerEvidence;
  const aiFamily = proposal.diagnosis?.failureFamily;
  const aiConfidence = Number(proposal.diagnosis?.confidence ?? 0.5);

  // Default unknowns if missing or empty
  let unknowns = Array.isArray(proposal.diagnosis?.unknowns) && proposal.diagnosis.unknowns.length > 0
    ? [...proposal.diagnosis.unknowns]
    : [];

  let classificationBasis = Array.isArray(proposal.diagnosis?.classificationBasis)
    ? [...proposal.diagnosis.classificationBasis]
    : [];

  let failureFamily = aiFamily || 'UNKNOWN_FAILURE';
  let failureType = proposal.diagnosis?.failureType || 'UNSPECIFIED_FAILURE';
  let confidence = aiConfidence;
  let cause = proposal.diagnosis?.cause || 'Payment failure detected.';

  const playbook = context.playbook || contextFacts.playbook;
  const failureReason = context.failureReason || contextFacts['payment.failureReason'];
  const isUnspecified = !failureReason || failureReason.includes('unspecified');

  // GUARD 1: If provider evidence is MINIMAL or NONE, AI CANNOT claim a specific technical root cause
  if (evidenceStrength === 'MINIMAL' || evidenceStrength === 'NONE') {
    const isLegacyDegradation = isUnspecified &&
      (playbook === 'payment_degradation' || !playbook);

    if (isLegacyDegradation) {
      failureFamily = 'PAYMENT_DEGRADATION';
      failureType = 'TRANSIENT_GATEWAY_DROP';
      confidence = 0.75;
      cause = 'Standard payment degradation detected at checkout.';
      classificationBasis = ['payment.status'];
    } else if (failureFamily !== 'UNKNOWN_FAILURE') {
      // Reject the hallucinated technical root cause!
      failureFamily = 'UNKNOWN_FAILURE';
      failureType = 'INSUFFICIENT_PROVIDER_TELEMETRY';
      confidence = Math.min(confidence, 0.30);
      cause = 'Provider supplied insufficient diagnostic evidence to establish a specific root cause.';
      unknowns.push('Provider supplied only a generic failure status without error codes or source step.');
      unknowns.push('Technical root cause was not verified by provider telemetry.');
    } else {
      confidence = Math.min(confidence, 0.35);
    }
  }

  // GUARD 2: Ensure classificationBasis only references fields that actually exist in facts
  classificationBasis = classificationBasis.filter((field) => {
    const factKey = field.startsWith('case.') || field.startsWith('payment.') || field.startsWith('provider.')
      ? field
      : `payment.${field}`;
    return contextFacts[factKey] !== undefined && contextFacts[factKey] !== null;
  });

  if (classificationBasis.length === 0) {
    classificationBasis.push('payment.status');
  }

  // GUARD 3: Always guarantee at least one honest unknown
  if (unknowns.length === 0) {
    unknowns.push('Secondary payment method viability is unconfirmed.');
  }

  return {
    ...proposal,
    diagnosis: {
      ...proposal.diagnosis,
      failureFamily,
      failureType,
      confidence,
      cause,
      classificationBasis,
      unknowns,
      evidenceStrength
    }
  };
}

module.exports = {
  FAILURE_FAMILIES,
  GENERIC_FAILURE_STRINGS,
  extractProviderEvidence,
  classifyFailureEvidence,
  guardFailureClassification
};
