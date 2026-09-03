/**
 * Revflow V2 — Playbook Engine
 *
 * Lightweight coordinator that binds incoming revenue events to specialized
 * recovery playbooks, extracts domain context, exposes candidate strategies,
 * and enforces domain stopping policies while routing through ONE common Revflow
 * control plane.
 */

const paymentDegradationPlaybook = require('./modules/paymentDegradation');
const checkoutDropOffPlaybook = require('./modules/checkoutDropOff');
const failedSubscriptionPlaybook = require('./modules/failedSubscription');
const b2bReceivablesPlaybook = require('./modules/b2bReceivables');
const { STRATEGY_DEFINITIONS, EXECUTION_MODES } = require('../strategies/strategyRegistry');

class PlaybookRegistrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlaybookRegistrationError';
  }
}

const REQUIRED_INTERFACE_METHODS = ['matchesEvent', 'assessRisk', 'extractContext', 'getCandidateActions'];
const VALID_EXECUTION_MODES = new Set([
  EXECUTION_MODES.LIVE_PROVIDER,
  EXECUTION_MODES.SIMULATED,
  EXECUTION_MODES.CONTROL
]);

class PlaybookEngine {
  constructor() {
    this.playbooks = new Map();
    this.defaultPlaybook = paymentDegradationPlaybook;

    // Register initial core playbooks with standard priority
    this.register(paymentDegradationPlaybook);
    this.register(checkoutDropOffPlaybook);
    this.register(failedSubscriptionPlaybook);
    this.register(b2bReceivablesPlaybook);
  }

  /**
   * Validates and registers a playbook module.
   *
   * @param {object} playbook
   * @param {object} [options]
   * @param {boolean} [options.allowOverride=false]
   */
  register(playbook, { allowOverride = false } = {}) {
    if (!playbook || typeof playbook !== 'object') {
      throw new PlaybookRegistrationError('Playbook must be a non-null object.');
    }

    if (!playbook.id || typeof playbook.id !== 'string' || playbook.id.trim() === '') {
      throw new PlaybookRegistrationError('Playbook must have a valid non-empty string "id".');
    }

    if (!allowOverride && this.playbooks.has(playbook.id)) {
      throw new PlaybookRegistrationError(`Duplicate playbook ID '${playbook.id}'. Playbook is already registered.`);
    }

    if (!playbook.name || typeof playbook.name !== 'string' || playbook.name.trim() === '') {
      throw new PlaybookRegistrationError(`Playbook '${playbook.id}' is missing a valid string "name".`);
    }

    if (!playbook.domain || typeof playbook.domain !== 'string' || playbook.domain.trim() === '') {
      throw new PlaybookRegistrationError(`Playbook '${playbook.id}' is missing a valid string "domain".`);
    }

    // Validate required interface functions
    for (const method of REQUIRED_INTERFACE_METHODS) {
      if (typeof playbook[method] !== 'function') {
        throw new PlaybookRegistrationError(`Playbook '${playbook.id}' is missing required interface method "${method}()".`);
      }
    }

    // Validate custom policy function if provided
    if (playbook.evaluateCustomPolicy !== undefined && typeof playbook.evaluateCustomPolicy !== 'function') {
      throw new PlaybookRegistrationError(`Playbook '${playbook.id}' optional evaluateCustomPolicy must be a function if provided.`);
    }

    // Validate candidate strategies and execution modes
    try {
      const candidates = playbook.getCandidateActions({});
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new PlaybookRegistrationError(`Playbook '${playbook.id}' getCandidateActions() must return a non-empty array of strategies.`);
      }

      for (const strategyId of candidates) {
        const strategyDef = STRATEGY_DEFINITIONS[strategyId];
        if (!strategyDef) {
          throw new PlaybookRegistrationError(`Playbook '${playbook.id}' references unknown strategy '${strategyId}' not found in Strategy Registry.`);
        }
        if (!VALID_EXECUTION_MODES.has(strategyDef.executionMode)) {
          throw new PlaybookRegistrationError(`Strategy '${strategyId}' referenced by playbook '${playbook.id}' has invalid execution mode '${strategyDef.executionMode}'.`);
        }
      }
    } catch (err) {
      if (err instanceof PlaybookRegistrationError) throw err;
      throw new PlaybookRegistrationError(`Playbook '${playbook.id}' getCandidateActions() threw an error during registration validation: ${err.message}`);
    }

    const priority = typeof playbook.priority === 'number'
      ? playbook.priority
      : (playbook.flagship ? 0 : 100);

    this.playbooks.set(playbook.id, {
      ...playbook,
      priority
    });
  }

  /**
   * Retrieves a registered playbook by its ID.
   *
   * @param {string} playbookId
   * @returns {object|null}
   */
  get(playbookId) {
    return this.playbooks.get(playbookId) || null;
  }

  /**
   * Lists all registered playbooks sorted by priority descending.
   *
   * @returns {Array}
   */
  list() {
    return Array.from(this.playbooks.values()).sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /**
   * Identifies the matching playbook for an incoming event.
   * Evaluates specialized domain playbooks in deterministic priority order.
   * Defaults to payment_degradation (V1 core gateway recovery) if no specialized playbook matches.
   *
   * @param {object} event
   * @returns {object} Matching playbook module
   */
  identifyPlaybook(event) {
    if (!event) return this.defaultPlaybook;

    // Direct playbook tag override if explicitly supplied
    if (event.playbook && this.playbooks.has(event.playbook)) {
      return this.playbooks.get(event.playbook);
    }

    // Sort specialized domain playbooks in descending priority order
    const specializedPlaybooks = Array.from(this.playbooks.values())
      .filter((p) => p.id !== this.defaultPlaybook.id)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // Evaluate specialized domain playbooks first
    for (const playbook of specializedPlaybooks) {
      if (typeof playbook.matchesEvent === 'function' && playbook.matchesEvent(event)) {
        return playbook;
      }
    }

    // Fallback to flagship payment degradation
    return this.defaultPlaybook;
  }

  /**
   * Runs risk assessment through the identified playbook.
   *
   * @param {object} event
   * @param {Array} eventHistory
   * @returns {object} Assessment result
   */
  assessRisk(event, eventHistory = []) {
    const playbook = this.identifyPlaybook(event);
    return playbook.assessRisk(event, eventHistory);
  }

  /**
   * Extracts domain-specific context from event and case detail.
   *
   * @param {object} event
   * @param {object} caseDetail
   * @returns {object} Domain context
   */
  extractContext(event, caseDetail) {
    const playbook = this.identifyPlaybook(event || caseDetail?.events?.at(-1));
    return playbook.extractContext(event, caseDetail);
  }

  /**
   * Returns candidate actions for the given context and category.
   *
   * @param {object} context
   * @param {string} [category]
   * @returns {Array<string>}
   */
  getCandidateActions(context, category) {
    const playbookId = context?.playbook
      || (category === 'CHECKOUT_DROPOFF'
          ? 'checkout_drop_off'
          : (category === 'FAILED_SUBSCRIPTION'
              ? 'failed_subscription'
              : (['B2B_APPROVAL_DELAY', 'B2B_RECEIVABLES'].includes(category)
                  ? 'b2b_receivables'
                  : 'payment_degradation')));
    const playbook = this.get(playbookId) || this.defaultPlaybook;
    if (typeof playbook.getCandidateActions === 'function') {
      return playbook.getCandidateActions(context);
    }
    return this.defaultPlaybook.getCandidateActions(context);
  }

  /**
   * Evaluates domain-specific custom stopping and policy criteria.
   *
   * @param {object} caseDetail
   * @param {string} candidateAction
   * @param {Function} [now]
   * @returns {object|null} Custom policy evaluation or null
   */
  evaluateCustomPolicy(caseDetail, candidateAction, now = () => new Date()) {
    const latestEvent = caseDetail?.events?.at(-1);
    const playbook = this.identifyPlaybook(latestEvent);
    if (typeof playbook.evaluateCustomPolicy === 'function') {
      return playbook.evaluateCustomPolicy(caseDetail, candidateAction, now);
    }
    return null;
  }
}

const defaultEngine = new PlaybookEngine();

module.exports = {
  PlaybookEngine,
  PlaybookRegistrationError,
  defaultEngine,
  playbookEngine: defaultEngine
};
