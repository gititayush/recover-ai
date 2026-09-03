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

class PlaybookEngine {
  constructor() {
    this.playbooks = new Map();
    this.defaultPlaybook = paymentDegradationPlaybook;

    // Register initial core playbooks
    this.register(paymentDegradationPlaybook);
    this.register(checkoutDropOffPlaybook);
  }

  /**
   * Registers a playbook module.
   *
   * @param {object} playbook
   */
  register(playbook) {
    if (!playbook || !playbook.id) {
      throw new Error('Playbook must have a valid string "id".');
    }
    this.playbooks.set(playbook.id, playbook);
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
   * Lists all registered playbooks.
   *
   * @returns {Array}
   */
  list() {
    return Array.from(this.playbooks.values());
  }

  /**
   * Identifies the matching playbook for an incoming event.
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

    // Evaluate specialized domain playbooks first
    for (const playbook of this.playbooks.values()) {
      if (playbook.id === this.defaultPlaybook.id) continue;
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
    const playbookId = context?.playbook || (category === 'CHECKOUT_DROPOFF' ? 'checkout_drop_off' : 'payment_degradation');
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
  defaultEngine,
  playbookEngine: defaultEngine
};
