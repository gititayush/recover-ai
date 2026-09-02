const { z } = require('zod');
const { contextFacts } = require('./contextBuilder');

const EXECUTABLE_ACTIONS = ['CREATE_PAYMENT_LINK'];
const ADVISORY_ACTIONS = [
  'SCHEDULE_RETRY_WINDOW',
  'DISPATCH_VERNACULAR_ASSIST',
  'RECORD_PROMISE_TO_PAY'
];
const CONTROL_ACTIONS = ['REQUEST_MANUAL_REVIEW', 'NO_ACTION'];
const actions = [...EXECUTABLE_ACTIONS, ...ADVISORY_ACTIONS, ...CONTROL_ACTIONS];

const evidenceFields = [
  'case.amount',
  'case.currency',
  'case.status',
  'case.riskLevel',
  'case.riskReason',
  'case.hasOrder',
  'case.hasPriorSuccess',
  'payment.status',
  'payment.failureReason',
  'payment.errorCode',
  'payment.attemptCount',
  'payment.timeSinceFailureMinutes',
  'order.status'
];

const DIAGNOSIS_CATEGORIES = [
  'TRANSIENT_PAYMENT_FAILURE',
  'CHECKOUT_DROPOFF',
  'FAILED_SUBSCRIPTION',
  'B2B_APPROVAL_DELAY',
  'MANDATE_TIMING',
  'LANGUAGE_ASSISTANCE',
  'PROMISE_TO_PAY',
  'TERMINAL_STATE',
  'AMBIGUOUS'
];

const diagnosisProposalSchema = z.object({
  diagnosis: z.object({
    category: z.enum(DIAGNOSIS_CATEGORIES).optional().default('TRANSIENT_PAYMENT_FAILURE'),
    cause: z.string().trim().min(3).max(280),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.object({ field: z.enum(evidenceFields), value: z.string().trim().min(1).max(280) }).strict()).min(1).max(6)
  }).strict(),
  recommendation: z.object({ action: z.enum(actions) }).strict()
}).strict();

class AiDiagnosisValidationError extends Error {
  constructor(message) { super(message); this.name = 'AiDiagnosisValidationError'; }
}

const RESTRICTED_SPECIFIC_TERMS = [
  { term: '3D-Secure', pattern: /\b(3d[- ]?secure|3ds)\b/i },
  { term: 'OTP', pattern: /\b(otp|one[- ]?time[- ]?password)\b/i },
  { term: 'HDFC', pattern: /\bhdfc\b/i },
  { term: 'SBI', pattern: /\bsbi\b/i },
  { term: 'ICICI', pattern: /\bicici\b/i },
  { term: 'Axis', pattern: /\baxis\b/i },
  { term: 'Kotak', pattern: /\bkotak\b/i },
  { term: 'RuPay', pattern: /\brupay\b/i },
  { term: 'Visa', pattern: /\bvisa\b/i },
  { term: 'Mastercard', pattern: /\bmastercard\b/i },
  { term: 'UPI Autopay', pattern: /\b(upi[- ]?autopay|autopay)\b/i },
  { term: 'e-Mandate', pattern: /\b(e[- ]?mandate|mandate)\b/i },
  { term: 'Stolen card', pattern: /\b(stolen|lost[- ]?card)\b/i },
  { term: 'Fraud', pattern: /\b(fraud|chargeback)\b/i },
  { term: 'Insufficient funds', pattern: /\binsufficient[- ]?funds\b/i },
  { term: 'Salary cycle', pattern: /\bsalary[- ]?cycle\b/i }
];

function validateDiagnosisCause(cause, context, evidenceList) {
  if (typeof cause !== 'string' || cause.trim().length < 3) {
    throw new AiDiagnosisValidationError('Diagnosis cause must be at least 3 characters.');
  }

  // Combine all supplied text from context and cited evidence into a search string
  const searchableContext = [
    context.failureReason || '',
    context.riskReason || '',
    context.errorCode || '',
    context.paymentStatus || '',
    context.caseStatus || '',
    ...(context.recentEvents || []).map((e) => `${e.eventType || ''} ${e.failureReason || ''}`),
    ...(evidenceList || []).map((ev) => ev.value || '')
  ].join(' ').toLowerCase();

  const ungroundedTerms = [];
  for (const { term, pattern } of RESTRICTED_SPECIFIC_TERMS) {
    if (pattern.test(cause) && !pattern.test(searchableContext)) {
      ungroundedTerms.push(term);
    }
  }

  if (ungroundedTerms.length > 0) {
    throw new AiDiagnosisValidationError(
      `Diagnosis cause contains ungrounded claims (${ungroundedTerms.join(', ')}). All specific entities must be supported by supplied context.`
    );
  }

  // Contradiction checks
  if (context.paymentStatus === 'failed' && /\b(payment (was )?successful|captured successfully|funds transferred successfully)\b/i.test(cause)) {
    throw new AiDiagnosisValidationError('Diagnosis cause contradicts the recorded payment failure status.');
  }
}

function parseDiagnosisProposal(rawResult, context) {
  let parsedResult = rawResult;
  if (typeof rawResult === 'string') {
    try { parsedResult = JSON.parse(rawResult); } catch (error) { throw new AiDiagnosisValidationError('AI output was not valid JSON.'); }
  }
  const result = diagnosisProposalSchema.safeParse(parsedResult);
  if (!result.success) {
    const issues = JSON.stringify(result.error?.issues || []).slice(0, 500);
    throw new AiDiagnosisValidationError(`AI output did not match the required diagnosis schema: ${issues}`);
  }

  const facts = contextFacts(context);
  for (const evidence of result.data.diagnosis.evidence) {
    if (facts[evidence.field] === null || facts[evidence.field] === undefined || facts[evidence.field] !== evidence.value) {
      throw new AiDiagnosisValidationError(`AI evidence did not match available context for ${evidence.field}.`);
    }
  }

  // Semantic grounding verification of diagnosis.cause
  validateDiagnosisCause(result.data.diagnosis.cause, context, result.data.diagnosis.evidence);

  return result.data;
}

module.exports = {
  EXECUTABLE_ACTIONS,
  ADVISORY_ACTIONS,
  CONTROL_ACTIONS,
  DIAGNOSIS_CATEGORIES,
  actions,
  evidenceFields,
  diagnosisProposalSchema,
  parseDiagnosisProposal,
  validateDiagnosisCause,
  AiDiagnosisValidationError
};
