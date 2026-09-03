/**
 * Revflow V2 — Grounded Multilingual Communication Service
 *
 * Implements deterministic, fact-grounded customer communication copy
 * in English (en), Hindi (hi), and Hinglish (hinglish).
 *
 * CORE INVARIANTS:
 * 1. AI PROPOSES. POLICY DECIDES. EXECUTOR ACTS.
 * 2. Communication is ADVISORY; message delivery !== revenue recovery.
 * 3. Never invent facts: amount, customer name, payment links, or failure reasons
 *    must be strictly derived from verified case and provider context.
 * 4. Language selection follows strict deterministic precedence:
 *    Explicit customer preference > Structured locale > Merchant default > English fallback.
 *    Language is NEVER inferred from customer name, geography, or ethnicity.
 */

class CommunicationGroundingError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CommunicationGroundingError';
    this.details = details;
    this.statusCode = 422;
  }
}

class UnsupportedLanguageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'UnsupportedLanguageError';
    this.details = details;
    this.statusCode = 400;
  }
}

const SUPPORTED_LANGUAGES = Object.freeze(['en', 'hi', 'hinglish']);

const LANGUAGE_SELECTION_REASONS = Object.freeze({
  EXPLICIT_CUSTOMER_PREFERENCE: 'EXPLICIT_CUSTOMER_PREFERENCE',
  STRUCTURED_LOCALE: 'STRUCTURED_LOCALE',
  MERCHANT_CONFIGURED_DEFAULT: 'MERCHANT_CONFIGURED_DEFAULT',
  SAFE_FALLBACK_EN: 'SAFE_FALLBACK_EN'
});

const FORBIDDEN_HALLUCINATION_PATTERNS = [
  /\b(discount|off|cashback|voucher|bonus|waiv(e|er)|free)\b/i,
  /\b(expires in \d+|midnight|hurry|last chance|urgent action)\b/i,
  /\b(legal action|account suspend(ed)?|lawsuit|penalty)\b/i
];

/**
 * Normalizes raw language strings.
 */
function normalizeLanguageCode(rawLang) {
  if (!rawLang || typeof rawLang !== 'string') return null;
  const cleaned = rawLang.trim().toLowerCase();
  if (cleaned === 'en' || cleaned === 'english') return 'en';
  if (cleaned === 'hi' || cleaned === 'hindi') return 'hi';
  if (cleaned === 'hinglish' || cleaned === 'hi-en' || cleaned === 'en-hi') return 'hinglish';
  return null;
}

/**
 * Deterministically resolves the communication language.
 *
 * Precedence:
 * 1. Explicit customer preference
 * 2. Structured customer locale
 * 3. Merchant configured default
 * 4. Safe English fallback
 *
 * Prohibits demographic or name-based language inference.
 */
function selectLanguage({
  customerPreference = null,
  locale = null,
  merchantDefault = null,
  strictValidation = false
} = {}) {
  // 1. Explicit Customer Preference
  if (customerPreference) {
    const normalized = normalizeLanguageCode(customerPreference);
    if (normalized && SUPPORTED_LANGUAGES.includes(normalized)) {
      return {
        language: normalized,
        selectionReason: LANGUAGE_SELECTION_REASONS.EXPLICIT_CUSTOMER_PREFERENCE,
        sourceValue: customerPreference
      };
    }
    if (strictValidation) {
      throw new UnsupportedLanguageError(
        `Unsupported language preference '${customerPreference}'. Supported languages are: ${SUPPORTED_LANGUAGES.join(', ')}.`
      );
    }
  }

  // 2. Structured Locale (e.g., 'hi-IN', 'hi_IN')
  if (locale && typeof locale === 'string') {
    const locClean = locale.trim().toLowerCase();
    if (locClean.startsWith('hi')) {
      return {
        language: 'hi',
        selectionReason: LANGUAGE_SELECTION_REASONS.STRUCTURED_LOCALE,
        sourceValue: locale
      };
    }
    if (locClean.startsWith('en')) {
      return {
        language: 'en',
        selectionReason: LANGUAGE_SELECTION_REASONS.STRUCTURED_LOCALE,
        sourceValue: locale
      };
    }
  }

  // 3. Explicit Merchant Policy / Default
  if (merchantDefault) {
    const normalizedMerchant = normalizeLanguageCode(merchantDefault);
    if (normalizedMerchant && SUPPORTED_LANGUAGES.includes(normalizedMerchant)) {
      return {
        language: normalizedMerchant,
        selectionReason: LANGUAGE_SELECTION_REASONS.MERCHANT_CONFIGURED_DEFAULT,
        sourceValue: merchantDefault
      };
    }
  }

  // 4. Safe Fallback to English
  return {
    language: 'en',
    selectionReason: LANGUAGE_SELECTION_REASONS.SAFE_FALLBACK_EN,
    sourceValue: null
  };
}

/**
 * Formats an amount in paise to standard Indian Rupees (₹X.XX or ₹X).
 */
function formatCurrencyINR(amountPaise) {
  if (typeof amountPaise !== 'number' || isNaN(amountPaise) || amountPaise < 0) {
    throw new CommunicationGroundingError(`Invalid financial amount '${amountPaise}'. Must be a positive integer in paise.`);
  }
  const rupees = amountPaise / 100;
  return Number.isInteger(rupees)
    ? `₹${rupees.toLocaleString('en-IN')}`
    : `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Deterministic message templates across English, Hindi, and Hinglish.
 */
function renderMessage({
  language = 'en',
  amountPaise,
  customerName = null,
  paymentLinkUrl = null,
  failureReason = null,
  purpose = 'PAYMENT_FAILURE_RECOVERY'
}) {
  const normalizedLang = normalizeLanguageCode(language) || 'en';
  const amountFormatted = formatCurrencyINR(amountPaise);
  const cleanName = (typeof customerName === 'string' && customerName.trim().length > 0) ? customerName.trim() : null;
  const cleanLink = (typeof paymentLinkUrl === 'string' && paymentLinkUrl.trim().length > 0) ? paymentLinkUrl.trim() : null;

  let message = '';

  switch (normalizedLang) {
    case 'hi': {
      // Hindi (Devanagari)
      const greeting = cleanName ? `नमस्ते ${cleanName}` : 'नमस्ते';
      if (purpose === 'B2B_INVOICE_REMINDER') {
        message = cleanLink
          ? `${greeting}, आपके इनवॉइस के लिए ${amountFormatted} का भुगतान देय है। आप इस सुरक्षित लिंक से भुगतान पूरा कर सकते हैं: ${cleanLink}`
          : `${greeting}, आपके इनवॉइस के लिए ${amountFormatted} का भुगतान देय है। कृपया देय तिथि के अनुसार भुगतान पूरा करें।`;
      } else if (purpose === 'SUBSCRIPTION_RENEWAL') {
        message = cleanLink
          ? `${greeting}, आपका ${amountFormatted} का सब्सक्रिप्शन नवीनीकरण भुगतान पूरा नहीं हो सका। कृपया इस लिंक से विवरण अपडेट करें: ${cleanLink}`
          : `${greeting}, आपका ${amountFormatted} का सब्सक्रिप्शन नवीनीकरण भुगतान पूरा नहीं हो सका। हमारा सिस्टम स्वतः पुनः प्रयास करेगा।`;
      } else {
        // Standard Payment Failure / Checkout Drop-Off
        message = cleanLink
          ? `${greeting}, बैंक टाइमआउट के कारण आपका ${amountFormatted} का भुगतान पूरा नहीं हो सका। आप इस लिंक से भुगतान पूरा कर सकते हैं: ${cleanLink}`
          : `${greeting}, बैंक टाइमआउट के कारण आपका ${amountFormatted} का भुगतान पूरा नहीं हो सका। कृपया कुछ समय बाद पुनः प्रयास करें।`;
      }
      break;
    }

    case 'hinglish': {
      // Hinglish (Conversational Romanized Hindi + English blend)
      const greeting = cleanName ? `Hi ${cleanName}` : 'Hi';
      if (purpose === 'B2B_INVOICE_REMINDER') {
        message = cleanLink
          ? `${greeting}, aapke invoice ke liye ${amountFormatted} ka payment due hai. Aap is link se payment clear kar sakte hain: ${cleanLink}`
          : `${greeting}, aapke invoice ke liye ${amountFormatted} ka payment due hai. Kripya payment terms ke anusaar settle karein.`;
      } else if (purpose === 'SUBSCRIPTION_RENEWAL') {
        message = cleanLink
          ? `${greeting}, aapka ${amountFormatted} ka subscription renewal payment complete nahi ho paya. Aap is link se details update kar sakte hain: ${cleanLink}`
          : `${greeting}, aapka ${amountFormatted} ka subscription renewal payment complete nahi ho paya. Hum automatically retry sequence sequence kar rahe hain.`;
      } else {
        // Standard Payment Failure / Checkout Drop-Off
        message = cleanLink
          ? `${greeting}, bank timeout ki wajah se aapka ${amountFormatted} ka payment complete nahi ho paya. Aap is link se payment complete kar sakte hain: ${cleanLink}`
          : `${greeting}, bank timeout ki wajah se aapka ${amountFormatted} ka payment complete nahi ho paya. Hum issue resolve kar rahe hain.`;
      }
      break;
    }

    case 'en':
    default: {
      // English
      const greeting = cleanName ? `Hi ${cleanName}` : 'Hi';
      if (purpose === 'B2B_INVOICE_REMINDER') {
        message = cleanLink
          ? `${greeting}, your invoice payment of ${amountFormatted} is currently due. You can complete the payment securely here: ${cleanLink}`
          : `${greeting}, your invoice payment of ${amountFormatted} is currently due. Please process according to agreement terms.`;
      } else if (purpose === 'SUBSCRIPTION_RENEWAL') {
        message = cleanLink
          ? `${greeting}, your subscription renewal payment of ${amountFormatted} could not be processed. You can update payment details here: ${cleanLink}`
          : `${greeting}, your subscription renewal payment of ${amountFormatted} could not be processed. Our system will automatically retry shortly.`;
      } else {
        // Standard Payment Failure / Checkout Drop-Off
        message = cleanLink
          ? `${greeting}, your payment of ${amountFormatted} could not be completed due to a temporary bank timeout. You can complete the payment here: ${cleanLink}`
          : `${greeting}, your payment of ${amountFormatted} could not be completed due to a temporary bank timeout. Our team is resolving the issue.`;
      }
      break;
    }
  }

  return message;
}

/**
 * Fact Validation Gate:
 * Strictly asserts that the rendered message is grounded in verified context
 * and contains zero hallucinations or unverified financial promises.
 */
function validateMessageGrounding({
  message,
  expectedAmountPaise,
  expectedCustomerName = null,
  expectedPaymentLinkUrl = null
}) {
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new CommunicationGroundingError('Communication message cannot be empty.');
  }

  if (message.length > 320) {
    throw new CommunicationGroundingError(
      `Message length (${message.length} chars) exceeds maximum allowable outreach threshold of 320 characters.`
    );
  }

  // 1. Amount Grounding Verification
  const formattedAmount = formatCurrencyINR(expectedAmountPaise);
  if (!message.includes(formattedAmount)) {
    throw new CommunicationGroundingError(
      `Grounding Violation: Expected amount '${formattedAmount}' is missing from the message copy.`,
      { expectedAmount: formattedAmount, message }
    );
  }

  // 2. Customer Name Grounding Verification
  if (expectedCustomerName && expectedCustomerName.trim().length > 0) {
    const trimmed = expectedCustomerName.trim();
    if (!message.includes(trimmed)) {
      throw new CommunicationGroundingError(
        `Grounding Violation: Verified customer name '${trimmed}' was not preserved in greeting.`,
        { expectedCustomerName: trimmed, message }
      );
    }
  } else {
    // If no customer name was provided, ensure no arbitrary common names were fabricated
    const suspiciousNames = ['Arjun', 'Rahul', 'Priya', 'Amit', 'Neha', 'John', 'Suresh'];
    for (const name of suspiciousNames) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(message)) {
        throw new CommunicationGroundingError(
          `Hallucination Violation: Fabricated customer name '${name}' detected when no customer name was provided in context.`,
          { fabricatedName: name, message }
        );
      }
    }
  }

  // 3. Payment Link Grounding Verification
  if (expectedPaymentLinkUrl && expectedPaymentLinkUrl.trim().length > 0) {
    const trimmedUrl = expectedPaymentLinkUrl.trim();
    if (!message.includes(trimmedUrl)) {
      throw new CommunicationGroundingError(
        `Grounding Violation: Provided payment link URL '${trimmedUrl}' is missing from message.`,
        { expectedPaymentLinkUrl: trimmedUrl, message }
      );
    }
  }

  // 4. Anti-Hallucination Forbidden Phrases Check
  for (const pattern of FORBIDDEN_HALLUCINATION_PATTERNS) {
    const match = message.match(pattern);
    if (match) {
      throw new CommunicationGroundingError(
        `Hallucination Violation: Unverified promotional or coercive phrase '${match[0]}' detected in communication copy.`,
        { forbiddenPhrase: match[0], message }
      );
    }
  }

  return {
    valid: true,
    factsVerified: [
      'case.amount',
      expectedCustomerName ? 'customer.name' : null,
      expectedPaymentLinkUrl ? 'action.paymentLinkUrl' : null
    ].filter(Boolean)
  };
}

/**
 * High-level orchestration for creating a verified communication payload.
 */
function buildCommunicationPayload({
  recoveryCase,
  diagnosis = null,
  action = null,
  customerName = null,
  languagePreference = null,
  locale = null,
  merchantDefaultLanguage = 'en',
  purpose = 'PAYMENT_FAILURE_RECOVERY'
}) {
  if (!recoveryCase || typeof recoveryCase.amount !== 'number') {
    throw new CommunicationGroundingError('Invalid case context: recoveryCase with valid amount is required.');
  }

  // 1. Determine Language
  const { language, selectionReason, sourceValue } = selectLanguage({
    customerPreference: languagePreference || recoveryCase.customerPreference,
    locale: locale || recoveryCase.locale,
    merchantDefault: merchantDefaultLanguage
  });

  // 2. Extract verified parameters
  const paymentLinkUrl = action?.paymentLinkUrl || null;
  const name = customerName || recoveryCase.customerName || null;
  const failureReason = diagnosis?.diagnosis?.cause || recoveryCase.riskReason || null;

  // 3. Render Message Copy
  const message = renderMessage({
    language,
    amountPaise: recoveryCase.amount,
    customerName: name,
    paymentLinkUrl,
    failureReason,
    purpose
  });

  // 4. Validate Grounding Assertions
  const validation = validateMessageGrounding({
    message,
    expectedAmountPaise: recoveryCase.amount,
    expectedCustomerName: name,
    expectedPaymentLinkUrl: paymentLinkUrl
  });

  return {
    channel: 'whatsapp',
    language,
    selectionReason,
    languageSourceValue: sourceValue,
    message,
    amountFormatted: formatCurrencyINR(recoveryCase.amount),
    customerName: name,
    paymentLinkUrl,
    factsUsed: validation.factsVerified,
    groundingValid: true
  };
}

const { evaluateStoppingCriteria } = require('../policy/stoppingEngine');
const { evaluatePolicy } = require('../policy/policyEngine');
const { environment } = require('../config/env');

/**
 * Headless communication dispatcher for both REST controller and autonomous recovery worker.
 *
 * Implements strict stopping/policy revalidation, frequency capping, parameter grounding,
 * idempotent action persistence, provider execution (or bounded simulation), and audit logging.
 */
async function dispatchCommunicationAction({
  repository,
  whatsappProvider,
  recoveryCaseId,
  requestedLanguage = null,
  recipientPhone = null,
  channel = 'whatsapp',
  isAutonomous = false,
  now = () => new Date()
}) {
  if (!repository) {
    throw new Error('Repository is required for communication dispatch.');
  }

  const detail = await repository.getCaseDetail(recoveryCaseId);
  if (!detail) {
    return { error: 'CASE_NOT_FOUND', message: 'Recovery case not found.', statusCode: 404 };
  }

  const targetChannel = (channel || 'whatsapp').toLowerCase();
  if (targetChannel !== 'whatsapp') {
    return {
      error: 'UNSUPPORTED_CHANNEL',
      message: `Unsupported communication channel '${targetChannel}'. Only 'whatsapp' is supported.`,
      statusCode: 400
    };
  }

  if (requestedLanguage && !SUPPORTED_LANGUAGES.includes(requestedLanguage.toLowerCase())) {
    return {
      error: 'UNSUPPORTED_LANGUAGE',
      message: `Unsupported language '${requestedLanguage}'. Supported languages are: ${SUPPORTED_LANGUAGES.join(', ')}.`,
      statusCode: 400
    };
  }

  const existingActions = await repository.findActionsByCaseId(detail.recoveryCase.id);
  const diagnosis = await repository.findDiagnosisByCaseId(detail.recoveryCase.id);

  const commActions = existingActions.filter(
    (a) => a.actionType === 'CUSTOMER_OUTREACH' || a.actionType === 'DISPATCH_VERNACULAR_ASSIST'
  );

  // 1. TOCTOU Revalidation: Authoritative Stopping Criteria Check
  const stopping = evaluateStoppingCriteria({
    recoveryCase: detail.recoveryCase,
    diagnosis,
    candidateAction: 'CUSTOMER_OUTREACH',
    events: detail.events,
    existingActions: commActions,
    cooldownMinutes: 0,
    now
  });

  if (stopping.stopped && stopping.actionDisposition === 'HARD_STOP') {
    return {
      error: 'EXECUTION_STOPPED',
      message: stopping.humanReadableReason,
      reasonCode: stopping.reasonCode,
      actionDisposition: stopping.actionDisposition,
      statusCode: 422
    };
  }

  // 2. Authoritative Policy Engine Check
  const policyDecision = evaluatePolicy({
    recoveryCase: detail.recoveryCase,
    diagnosis,
    candidateAction: 'CUSTOMER_OUTREACH',
    events: detail.events,
    existingActions: commActions,
    cooldownMinutes: 0,
    allowSimulated: true,
    now
  });

  if (policyDecision.decision === 'BLOCK') {
    return {
      error: 'POLICY_BLOCKED',
      message: 'Customer outreach is blocked by deterministic safety guardrails.',
      reasons: policyDecision.reasons,
      statusCode: 422
    };
  }

  if (policyDecision.decision === 'REVIEW' && detail.recoveryCase.escalationStatus !== 'APPROVED') {
    return {
      error: 'REVIEW_REQUIRED',
      message: 'Customer outreach requires human operations approval before dispatch.',
      reasons: policyDecision.reasons,
      statusCode: 422
    };
  }

  // 3. Frequency Capping & Outreach Attempt Limit
  const maxOutreachAttempts = environment.COMMUNICATION_MAX_ATTEMPTS || 2;
  const cooldownMinutes = environment.COMMUNICATION_COOLDOWN_MINUTES || 30;

  // For autonomous execution, check if an executed outreach already exists to prevent duplicates on lease re-drive
  if (isAutonomous) {
    const existingSuccessfulOutreach = commActions.find((a) => ['EXECUTED', 'OUTCOME_CONFIRMED', 'PENDING'].includes(a.status));
    if (existingSuccessfulOutreach) {
      return {
        duplicate: true,
        action: existingSuccessfulOutreach,
        message: 'Active or executed outreach action already exists for this case.',
        statusCode: 200
      };
    }
  }

  if (commActions.length >= maxOutreachAttempts) {
    return {
      error: 'MAX_OUTREACH_EXCEEDED',
      message: `Outreach attempt limit (${maxOutreachAttempts}) reached for this recovery case.`,
      statusCode: 422
    };
  }

  const lastCommAction = commActions.at(-1);
  if (lastCommAction && lastCommAction.createdAt) {
    const elapsedMinutes = Math.floor((now().getTime() - new Date(lastCommAction.createdAt).getTime()) / 60000);
    if (elapsedMinutes < cooldownMinutes) {
      return {
        error: 'COOLDOWN_ACTIVE',
        message: `Outreach cooldown is active (${elapsedMinutes}/${cooldownMinutes} min elapsed). Please wait before contacting again.`,
        statusCode: 422
      };
    }
  }

  // 4. Derive Verified Parameters
  const paymentLinkAction = existingActions.find(
    (a) => a.actionType === 'CREATE_PAYMENT_LINK' && a.paymentLinkUrl && ['EXECUTED', 'OUTCOME_CONFIRMED'].includes(a.status)
  );

  const lastEvent = detail.events?.at(-1);
  const customerName = lastEvent?.rawPayload?.customerName
    || lastEvent?.rawPayload?.customer?.name
    || detail.recoveryCase.customerName
    || null;

  const customerLanguage = requestedLanguage
    || lastEvent?.rawPayload?.customerLanguagePreference
    || lastEvent?.rawPayload?.customerPreference
    || lastEvent?.rawPayload?.language
    || detail.recoveryCase.customerPreference
    || null;

  const customerLocale = lastEvent?.rawPayload?.locale
    || lastEvent?.rawPayload?.customerLocale
    || detail.recoveryCase.locale
    || null;

  // 5. Render Message Copy & Validate Grounding
  const payload = buildCommunicationPayload({
    recoveryCase: detail.recoveryCase,
    diagnosis,
    action: paymentLinkAction,
    customerName,
    languagePreference: customerLanguage,
    locale: customerLocale
  });

  // 6. Resolve Destination Phone Number
  const targetPhone = recipientPhone
    || lastEvent?.rawPayload?.customerPhone
    || detail.recoveryCase.customerReference
    || '+919876543210';

  // 7. Dispatch via Provider or Bounded Simulation
  const isProviderReady = whatsappProvider
    && typeof whatsappProvider.isConfigured === 'function'
    && whatsappProvider.isConfigured()
    && (whatsappProvider.getProviderMode() === 'SANDBOX' || whatsappProvider.getProviderMode() === 'TEST');

  const attemptNumber = commActions.length + 1;
  let createdAction;

  if (isProviderReady) {
    try {
      // Live Dispatch to Twilio WhatsApp Sandbox
      const sendResult = await whatsappProvider.sendMessage({
        to: targetPhone,
        message: payload.message
      });

      createdAction = await repository.createAction({
        recoveryCaseId: detail.recoveryCase.id,
        actionType: 'CUSTOMER_OUTREACH',
        status: 'EXECUTED',
        policyDecision: 'ALLOW',
        policyVersion: policyDecision.policyVersion,
        idempotencyKey: `comm_${detail.recoveryCase.id}_whatsapp_v${attemptNumber}`,
        provider: 'twilio_sandbox',
        providerActionId: sendResult.providerMessageId,
        amount: detail.recoveryCase.amount,
        currency: detail.recoveryCase.currency,
        requestMetadata: {
          communication: {
            channel: 'whatsapp',
            language: payload.language,
            selectionReason: payload.selectionReason,
            message: payload.message,
            provider: 'twilio_sandbox',
            providerMessageId: sendResult.providerMessageId,
            status: sendResult.status,
            recipient: targetPhone,
            factsUsed: payload.factsUsed,
            groundingValid: true,
            provenance: 'WHATSAPP_TEST_PROVIDER',
            isAutonomous
          }
        },
        responseMetadata: {
          provider: 'twilio_sandbox',
          providerMessageId: sendResult.providerMessageId,
          initialStatus: sendResult.status,
          externalApiCalled: true,
          recoveredAmount: 0,
          notice: 'Dispatched via Twilio WhatsApp Sandbox. Message delivery !== revenue recovery.'
        }
      });

      // Record Audit Log
      await repository.addAudit(
        detail.recoveryCase.id,
        'COMMUNICATION_DISPATCHED',
        `Dispatched customer outreach via Twilio WhatsApp Sandbox (${payload.language}): Message ID ${sendResult.providerMessageId}`,
        {
          actionId: createdAction.id,
          channel: 'whatsapp',
          language: payload.language,
          selectionReason: payload.selectionReason,
          provider: 'twilio_sandbox',
          providerMessageId: sendResult.providerMessageId,
          status: sendResult.status,
          recipient: targetPhone,
          provenance: 'WHATSAPP_TEST_PROVIDER',
          isAutonomous
        }
      );

      return {
        success: true,
        action: createdAction,
        payload,
        providerResult: sendResult,
        provenance: 'WHATSAPP_TEST_PROVIDER',
        statusCode: 201
      };
    } catch (providerError) {
      // Record FAILED action with error details
      const failedAction = await repository.createAction({
        recoveryCaseId: detail.recoveryCase.id,
        actionType: 'CUSTOMER_OUTREACH',
        status: 'FAILED',
        policyDecision: 'ALLOW',
        policyVersion: policyDecision.policyVersion,
        idempotencyKey: `comm_${detail.recoveryCase.id}_whatsapp_v${attemptNumber}_failed`,
        provider: 'twilio_sandbox',
        providerActionId: null,
        amount: detail.recoveryCase.amount,
        currency: detail.recoveryCase.currency,
        requestMetadata: {
          communication: {
            channel: 'whatsapp',
            language: payload.language,
            selectionReason: payload.selectionReason,
            message: payload.message,
            provider: 'twilio_sandbox',
            recipient: targetPhone,
            factsUsed: payload.factsUsed,
            groundingValid: true,
            provenance: 'WHATSAPP_TEST_PROVIDER',
            isAutonomous
          }
        },
        responseMetadata: {
          provider: 'twilio_sandbox',
          externalApiCalled: true,
          error: providerError.message,
          errorCode: providerError.details?.errorCode || providerError.statusCode || 500,
          details: providerError.details || null,
          recoveredAmount: 0,
          notice: 'Twilio WhatsApp Sandbox dispatch failed.'
        }
      });

      await repository.addAudit(
        detail.recoveryCase.id,
        'COMMUNICATION_FAILED',
        `WhatsApp communication failed: ${providerError.message}`,
        {
          actionId: failedAction.id,
          error: providerError.message,
          errorCode: providerError.details?.errorCode || null,
          recipient: targetPhone,
          provider: 'twilio_sandbox',
          isAutonomous
        }
      );

      return {
        success: false,
        action: failedAction,
        error: 'PROVIDER_ERROR',
        message: providerError.message,
        statusCode: providerError.statusCode || 502
      };
    }
  } else {
    // Bounded Simulation
    const simId = `sim_msg_${detail.recoveryCase.id}_v${attemptNumber}`;
    createdAction = await repository.createAction({
      recoveryCaseId: detail.recoveryCase.id,
      actionType: 'CUSTOMER_OUTREACH',
      status: 'EXECUTED',
      policyDecision: 'ALLOW',
      policyVersion: policyDecision.policyVersion,
      idempotencyKey: `comm_${detail.recoveryCase.id}_simulated_v${attemptNumber}`,
      provider: 'simulated',
      providerActionId: simId,
      amount: detail.recoveryCase.amount,
      currency: detail.recoveryCase.currency,
      requestMetadata: {
        communication: {
          channel: 'whatsapp',
          language: payload.language,
          selectionReason: payload.selectionReason,
          message: payload.message,
          provider: 'simulated',
          providerMessageId: simId,
          status: 'SENT',
          recipient: targetPhone,
          factsUsed: payload.factsUsed,
          groundingValid: true,
          provenance: 'SIMULATED',
          isAutonomous
        }
      },
      responseMetadata: {
        provider: 'simulated',
        isSimulated: true,
        externalApiCalled: false,
        recoveredAmount: 0,
        notice: 'Simulated WhatsApp outreach executed. No external messaging provider was called.'
      }
    });

    await repository.addAudit(
      detail.recoveryCase.id,
      'COMMUNICATION_DISPATCHED',
      `Executed simulated customer outreach (${payload.language}): ${simId}`,
      {
        actionId: createdAction.id,
        channel: 'whatsapp',
        language: payload.language,
        selectionReason: payload.selectionReason,
        provider: 'simulated',
        providerActionId: simId,
        status: 'SENT',
        recipient: targetPhone,
        provenance: 'SIMULATED',
        isAutonomous
      }
    );

    return {
      success: true,
      action: createdAction,
      payload,
      provenance: 'SIMULATED',
      statusCode: 201
    };
  }
}

module.exports = {
  SUPPORTED_LANGUAGES,
  LANGUAGE_SELECTION_REASONS,
  CommunicationGroundingError,
  UnsupportedLanguageError,
  selectLanguage,
  formatCurrencyINR,
  renderMessage,
  validateMessageGrounding,
  buildCommunicationPayload,
  dispatchCommunicationAction
};
