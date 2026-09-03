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
    if (!response.ok) {
      const errorBody = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
      throw new AiProviderError(
        `AI provider returned HTTP ${response.status}: ${errorBody.slice(0, 300)}`
      );
    }
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
    if (context.failureReason) evidence.push({ field: 'payment.failureReason', value: String(context.failureReason) });
    evidence.push({ field: 'payment.attemptCount', value: String(context.paymentAttemptCount || 0) });
    evidence.push({ field: 'case.riskLevel', value: String(context.riskLevel || 'MEDIUM') });

    const reasonText = `${context.failureReason || ''} ${context.riskReason || ''}`.toLowerCase();
    let category = 'AMBIGUOUS';
    if (reasonText.includes('timeout') || reasonText.includes('gateway') || reasonText.includes('bank')) {
      category = 'TRANSIENT_PAYMENT_FAILURE';
    } else if (reasonText.includes('checkout') || reasonText.includes('abandon') || reasonText.includes('drop')) {
      category = 'CHECKOUT_DROPOFF';
    }

    const cause = context.failureReason
      ? `Deterministic fallback: recorded reason is ${context.failureReason}.`
      : (category === 'CHECKOUT_DROPOFF'
          ? 'Deterministic fallback: checkout drop-off detected at payment step.'
          : 'Deterministic fallback: payment failure is recorded without a specific failure reason.');

    const action = (context.riskLevel === 'HIGH' && context.amount > 2500000) || context.paymentAttemptCount > 2
      ? 'REQUEST_MANUAL_REVIEW'
      : (category === 'CHECKOUT_DROPOFF' ? 'CHECKOUT_RECOVERY' : 'CREATE_PAYMENT_LINK');

    return {
      diagnosis: { category, cause, confidence: 0.75, evidence: evidence.slice(0, 3) },
      recommendation: { action: actions.includes(action) ? action : 'NO_ACTION' }
    };
  }
}

function createAiProvider(config) {
  if (config.apiKey) return new OpenAiCompatibleProvider(config);
  return new DevelopmentFallbackProvider();
}

module.exports = { createAiProvider, OpenAiCompatibleProvider, DevelopmentFallbackProvider, AiProviderError };
