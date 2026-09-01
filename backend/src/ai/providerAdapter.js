const { actions } = require('./diagnosisSchema');

class AiProviderError extends Error {
  constructor(message) { super(message); this.name = 'AiProviderError'; }
}

class OpenAiCompatibleProvider {
  constructor({ apiKey, model, baseUrl }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.provider = 'openai-compatible';
    this.source = 'live_ai';
  }

  async diagnose({ context, prompt }) {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: JSON.stringify({ context, schema: 'diagnosis.category, diagnosis.cause, diagnosis.confidence, diagnosis.evidence[{field,value}], recommendation.action' }) }] })
    });
    if (!response.ok) throw new AiProviderError(`AI provider returned HTTP ${response.status}.`);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new AiProviderError('AI provider returned no diagnosis content.');
    return content;
  }
}

class DevelopmentFallbackProvider {
  constructor() { this.provider = 'development-fallback'; this.model = 'deterministic-recovery-v1'; this.source = 'development_fallback'; }

  async diagnose({ context }) {
    const evidence = [];
    if (context.failureReason) evidence.push({ field: 'payment.failureReason', value: context.failureReason });
    evidence.push({ field: 'payment.attemptCount', value: String(context.paymentAttemptCount) });
    evidence.push({ field: 'case.riskLevel', value: context.riskLevel });
    const cause = context.failureReason
      ? `Deterministic fallback: recorded payment failure reason is ${context.failureReason}.`
      : 'Deterministic fallback: payment failure is recorded without a specific failure reason.';
    const action = context.riskLevel === 'HIGH' || context.paymentAttemptCount > 1 ? 'REQUEST_MANUAL_REVIEW' : 'CREATE_PAYMENT_LINK';
    const category = context.failureReason?.toLowerCase().includes('timeout') ? 'TRANSIENT_PAYMENT_FAILURE' : 'AMBIGUOUS';
    return { diagnosis: { category, cause, confidence: 0.7, evidence: evidence.slice(0, 3) }, recommendation: { action: actions.includes(action) ? action : 'NO_ACTION' } };
  }
}

function createAiProvider(config) {
  if (config.apiKey) return new OpenAiCompatibleProvider(config);
  return new DevelopmentFallbackProvider();
}

module.exports = { createAiProvider, OpenAiCompatibleProvider, DevelopmentFallbackProvider, AiProviderError };
