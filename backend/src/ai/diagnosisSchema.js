const { z } = require('zod');
const { contextFacts } = require('./contextBuilder');

const actions = ['CREATE_PAYMENT_LINK', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION'];
const evidenceFields = ['case.amount', 'case.currency', 'case.status', 'case.riskLevel', 'case.riskReason', 'payment.status', 'payment.failureReason', 'payment.attemptCount', 'payment.timeSinceFailureMinutes', 'order.status'];

const diagnosisProposalSchema = z.object({
  diagnosis: z.object({
    cause: z.string().trim().min(3).max(280),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.object({ field: z.enum(evidenceFields), value: z.string().trim().min(1).max(280) }).strict()).min(1).max(6)
  }).strict(),
  recommendation: z.object({ action: z.enum(actions) }).strict()
}).strict();

class AiDiagnosisValidationError extends Error {
  constructor(message) { super(message); this.name = 'AiDiagnosisValidationError'; }
}

function parseDiagnosisProposal(rawResult, context) {
  let parsedResult = rawResult;
  if (typeof rawResult === 'string') {
    try { parsedResult = JSON.parse(rawResult); } catch (error) { throw new AiDiagnosisValidationError('AI output was not valid JSON.'); }
  }
  const result = diagnosisProposalSchema.safeParse(parsedResult);
  if (!result.success) throw new AiDiagnosisValidationError('AI output did not match the required diagnosis schema.');

  const facts = contextFacts(context);
  for (const evidence of result.data.diagnosis.evidence) {
    if (facts[evidence.field] === null || facts[evidence.field] === undefined || facts[evidence.field] !== evidence.value) {
      throw new AiDiagnosisValidationError(`AI evidence did not match available context for ${evidence.field}.`);
    }
  }
  return result.data;
}

module.exports = { actions, diagnosisProposalSchema, parseDiagnosisProposal, AiDiagnosisValidationError };
