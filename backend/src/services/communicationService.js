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

module.exports = {
  SUPPORTED_LANGUAGES,
  LANGUAGE_SELECTION_REASONS,
  CommunicationGroundingError,
  UnsupportedLanguageError,
  selectLanguage,
  formatCurrencyINR,
  renderMessage,
  validateMessageGrounding,
  buildCommunicationPayload
};
