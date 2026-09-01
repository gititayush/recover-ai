const { environment } = require('../config/env');
const { buildCaseContext } = require('./contextBuilder');
const { parseDiagnosisProposal } = require('./diagnosisSchema');
const { createAiProvider } = require('./providerAdapter');
const { evaluateCandidates, rankCandidates } = require('./interventionEvaluator');
const { PROMPT_VERSION, SYSTEM_PROMPT } = require('./prompts');

function isTerminal(context) {
  return ['RESOLVED', 'SUPPRESSED'].includes(context.caseStatus) || ['captured', 'paid', 'refunded'].includes(context.paymentStatus) || context.orderStatus === 'paid';
}

function selectRecommendation(proposal, candidates, context, confidenceThreshold) {
  if (isTerminal(context)) return { action: 'NO_ACTION', reason: 'Terminal payment or recovery-case state makes recovery intervention ineligible.' };
  if (proposal.diagnosis.confidence < confidenceThreshold) return { action: 'REQUEST_MANUAL_REVIEW', reason: `AI confidence is below the configured ${confidenceThreshold} threshold.` };
  if (proposal.recommendation.action === 'NO_ACTION') return { action: 'NO_ACTION', reason: 'AI abstained from a recovery intervention.' };
  const selected = rankCandidates(candidates)[0];
  return { action: selected.action, reason: selected.action === proposal.recommendation.action ? 'AI proposal aligns with the highest estimated heuristic recovery value.' : 'Deterministic candidate comparison selected the highest estimated heuristic recovery value.' };
}

function terminalProposal(context) {
  let field = 'case.status';
  let value = context.caseStatus;
  if (['captured', 'paid', 'refunded'].includes(context.paymentStatus)) {
    field = 'payment.status';
    value = context.paymentStatus;
  } else if (context.orderStatus === 'paid') {
    field = 'order.status';
    value = context.orderStatus;
  }
  return {
    diagnosis: {
      category: 'TERMINAL_STATE',
      cause: 'Terminal payment or case state prevents recovery intervention.',
      confidence: 1,
      evidence: [{ field, value }]
    },
    recommendation: { action: 'NO_ACTION' }
  };
}

function createDiagnosisService({ provider = createAiProvider({ apiKey: environment.AI_API_KEY, model: environment.AI_MODEL, baseUrl: environment.AI_BASE_URL }), confidenceThreshold = environment.AI_CONFIDENCE_THRESHOLD, now } = {}) {
  return {
    async diagnose(detail) {
      const context = buildCaseContext(detail, now ? now() : new Date());
      const terminal = isTerminal(context);
      const proposal = terminal ? terminalProposal(context) : parseDiagnosisProposal(await provider.diagnose({ context, prompt: { version: PROMPT_VERSION, system: SYSTEM_PROMPT } }), context);
      const category = proposal.diagnosis?.category || null;
      const candidates = evaluateCandidates(context, category);
      const recommendation = selectRecommendation(proposal, candidates, context, confidenceThreshold);
      return {
        diagnosis: proposal.diagnosis,
        proposedAction: proposal.recommendation.action,
        recommendation,
        candidates,
        provider: terminal ? 'system-safety' : provider.provider,
        model: terminal ? 'terminal-safety-v1' : provider.model,
        promptVersion: PROMPT_VERSION,
        source: terminal ? 'system_safety' : provider.source
      };
    }
  };
}

module.exports = { createDiagnosisService, isTerminal };
