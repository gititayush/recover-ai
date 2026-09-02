class InMemoryRecoveryRepository {
  constructor() {
    this.events = [];
    this.providerWebhookEvents = [];
    this.cases = [];
    this.audits = [];
    this.aiDiagnoses = [];
    this.actions = [];
    this.outcomes = [];
    this.nextCaseId = 1;
    this.nextAuditId = 1;
    this.nextProviderWebhookEventId = 1;
    this.nextAiDiagnosisId = 1;
    this.nextActionId = 1;
    this.nextOutcomeId = 1;
  }

  async createEvent(event) {
    if (this.events.some((stored) => stored.eventId === event.eventId)) return null;
    const stored = { ...event, receivedAt: new Date().toISOString() };
    this.events.push(stored);
    return stored;
  }

  async createProviderWebhookEvent(data) {
    if (this.providerWebhookEvents.some((event) => event.provider === data.provider && event.providerEventId === data.providerEventId)) return null;
    const event = { id: this.nextProviderWebhookEventId++, receivedAt: new Date().toISOString(), ...data };
    this.providerWebhookEvents.push(event);
    return event;
  }

  async updateProviderWebhookEvent(id, changes) {
    const event = this.providerWebhookEvents.find((item) => item.id === id);
    Object.assign(event, changes);
    return event;
  }

  async withTransaction(callback) {
    return callback(this);
  }

  async getEventsForPayment(paymentId) {
    return this.events.filter((event) => event.paymentId === paymentId).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  async findCaseByPaymentId(paymentId) {
    return this.cases.find((recoveryCase) => recoveryCase.paymentId === paymentId) || null;
  }

  async createCase(data) {
    const recoveryCase = {
      id: this.nextCaseId++,
      actionStatus: 'NOT_STARTED',
      outcome: null,
      recoveredAmount: 0,
      autonomyStatus: data.autonomyStatus || 'INACTIVE',
      autonomyAttempts: 0,
      autonomyLeaseToken: null,
      lockedUntil: null,
      lockedBy: null,
      nextRetryAt: null,
      lastAutonomyError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data
    };
    this.cases.push(recoveryCase);
    return { ...recoveryCase };
  }

  async updateCase(id, changes) {
    const recoveryCase = this.cases.find((item) => item.id === Number(id));
    if (!recoveryCase) return null;
    Object.assign(recoveryCase, changes, { updatedAt: new Date().toISOString() });
    return { ...recoveryCase };
  }

  async claimNextJob({ workerId, leaseDurationSeconds = 60, now = new Date() }) {
    const crypto = require('crypto');
    const currentTime = new Date(now).getTime();
    const candidate = this.cases
      .filter((c) => {
        if (c.autonomyStatus === 'QUEUED') {
          return !c.lockedUntil || new Date(c.lockedUntil).getTime() <= currentTime;
        }
        if (c.autonomyStatus === 'RETRY_SCHEDULED') {
          return c.nextRetryAt && new Date(c.nextRetryAt).getTime() <= currentTime &&
            (!c.lockedUntil || new Date(c.lockedUntil).getTime() <= currentTime);
        }
        if (c.autonomyStatus === 'CLAIMED') {
          return c.lockedUntil && new Date(c.lockedUntil).getTime() <= currentTime;
        }
        return false;
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];

    if (!candidate) return null;

    candidate.autonomyStatus = 'CLAIMED';
    candidate.autonomyAttempts = (candidate.autonomyAttempts || 0) + 1;
    candidate.autonomyLeaseToken = crypto.randomUUID();
    candidate.lockedUntil = new Date(currentTime + leaseDurationSeconds * 1000).toISOString();
    candidate.lockedBy = workerId;
    candidate.updatedAt = new Date().toISOString();
    return { ...candidate };
  }

  async extendLease(caseId, leaseToken, { leaseDurationSeconds = 60, now = new Date() }) {
    const candidate = this.cases.find((c) => c.id === Number(caseId) && c.autonomyLeaseToken === leaseToken && c.autonomyStatus === 'CLAIMED');
    if (!candidate) return null;
    const currentTime = new Date(now).getTime();
    candidate.lockedUntil = new Date(currentTime + leaseDurationSeconds * 1000).toISOString();
    candidate.updatedAt = new Date().toISOString();
    return { ...candidate };
  }

  async releaseJob(caseId, leaseToken, updates = {}) {
    const candidate = this.cases.find((c) => c.id === Number(caseId) && c.autonomyLeaseToken === leaseToken);
    if (!candidate) return null;
    if (updates.autonomyStatus) candidate.autonomyStatus = updates.autonomyStatus;
    candidate.lockedUntil = null;
    candidate.lockedBy = null;
    if (updates.nextRetryAt !== undefined) candidate.nextRetryAt = updates.nextRetryAt;
    if (updates.lastAutonomyError !== undefined) candidate.lastAutonomyError = updates.lastAutonomyError;
    candidate.updatedAt = new Date().toISOString();
    return { ...candidate };
  }

  async scheduleRetry(caseId, leaseToken, { backoffSeconds = 30, error = null, now = new Date() }) {
    const candidate = this.cases.find((c) => c.id === Number(caseId) && c.autonomyLeaseToken === leaseToken);
    if (!candidate) return null;
    const currentTime = new Date(now).getTime();
    candidate.autonomyStatus = 'RETRY_SCHEDULED';
    candidate.lockedUntil = null;
    candidate.lockedBy = null;
    candidate.nextRetryAt = new Date(currentTime + backoffSeconds * 1000).toISOString();
    candidate.lastAutonomyError = error;
    candidate.updatedAt = new Date().toISOString();
    return { ...candidate };
  }

  async addAudit(recoveryCaseId, eventType, message, metadata = {}) {
    const audit = { id: this.nextAuditId++, recoveryCaseId, eventType, message, metadata, createdAt: new Date().toISOString() };
    this.audits.push(audit);
    return audit;
  }

  async findDiagnosisByCaseId(recoveryCaseId) {
    return this.aiDiagnoses.find((diagnosis) => diagnosis.recoveryCaseId === Number(recoveryCaseId)) || null;
  }

  async createDiagnosis(data) {
    if (await this.findDiagnosisByCaseId(data.recoveryCaseId)) return null;
    const diagnosis = { id: this.nextAiDiagnosisId++, createdAt: new Date().toISOString(), ...data };
    this.aiDiagnoses.push(diagnosis);
    return diagnosis;
  }

  async createAction(data) {
    const existing = this.actions.find((a) => a.idempotencyKey === data.idempotencyKey);
    if (existing) return existing;
    if (data.actionType === 'CREATE_PAYMENT_LINK' && ['EXECUTING', 'EXECUTED', 'OUTCOME_CONFIRMED'].includes(data.status)) {
      const active = this.actions.find((a) => a.recoveryCaseId === Number(data.recoveryCaseId) && a.actionType === 'CREATE_PAYMENT_LINK' && ['EXECUTING', 'EXECUTED', 'OUTCOME_CONFIRMED'].includes(a.status));
      if (active) return active;
    }
    const action = {
      id: this.nextActionId++,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      providerActionId: null,
      paymentLinkUrl: null,
      completedAt: null,
      failureReason: null,
      requestMetadata: {},
      responseMetadata: {},
      ...data
    };
    this.actions.push(action);
    return action;
  }

  async updateAction(id, changes) {
    const action = this.actions.find((item) => item.id === Number(id));
    if (!action) return null;
    Object.assign(action, changes, { updatedAt: new Date().toISOString() });
    return action;
  }

  async findActionByIdempotencyKey(key) {
    return this.actions.find((a) => a.idempotencyKey === key) || null;
  }

  async findActionByPaymentLinkId(paymentLinkId) {
    return this.actions.find((a) => a.providerActionId === paymentLinkId) || null;
  }

  async findActionsByCaseId(recoveryCaseId) {
    return this.actions.filter((a) => a.recoveryCaseId === Number(recoveryCaseId)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  async getLatestActionForCase(recoveryCaseId) {
    const actions = await this.findActionsByCaseId(recoveryCaseId);
    return actions.at(-1) || null;
  }

  async createOutcome(data) {
    const existing = this.outcomes.find((o) => o.provider === data.provider && o.providerEventId === data.providerEventId);
    if (existing) return existing;
    const outcome = {
      id: this.nextOutcomeId++,
      recoveryActionId: null,
      providerPaymentLinkId: null,
      providerPaymentId: null,
      providerOrderId: null,
      verified: false,
      receivedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      ...data
    };
    this.outcomes.push(outcome);
    return outcome;
  }

  async findOutcomeByEventId(provider, providerEventId) {
    return this.outcomes.find((o) => o.provider === provider && o.providerEventId === providerEventId) || null;
  }

  async findOutcomeByActionId(recoveryActionId) {
    return this.outcomes.find((o) => o.recoveryActionId === Number(recoveryActionId)) || null;
  }

  async findOutcomesByCaseId(recoveryCaseId) {
    return this.outcomes.filter((o) => o.recoveryCaseId === Number(recoveryCaseId)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  async getRecoveryMetrics() {
    const openCases = this.cases.filter((c) => ['OPEN', 'RECOVERABLE'].includes(c.riskStatus));
    const resolvedCases = this.cases.filter((c) => c.riskStatus === 'RESOLVED');
    const revenueAtRisk = openCases.reduce((sum, c) => sum + Number(c.amount || 0), 0);

    const verifiedOutcomes = this.outcomes.filter((o) => o.verified === true);
    const revenueRecovered = verifiedOutcomes.reduce((sum, o) => sum + Number(o.amountPaid || 0), 0);

    const totalPotential = revenueAtRisk + revenueRecovered;
    const recoveryRate = totalPotential > 0 ? Number((revenueRecovered / totalPotential).toFixed(4)) : 0;

    const executedActions = this.actions.filter((a) => ['EXECUTED', 'OUTCOME_CONFIRMED'].includes(a.status));
    const confirmedRecoveries = verifiedOutcomes.length;
    const pendingRecoveries = this.actions.filter((a) => a.status === 'EXECUTED').length;
    const blockedCases = this.actions.filter((a) => a.status === 'BLOCKED').length;
    const reviewRequiredCases = this.actions.filter((a) => a.status === 'REVIEW_REQUIRED').length;

    return {
      revenue_at_risk: revenueAtRisk,
      revenue_recovered: revenueRecovered,
      recovery_rate: recoveryRate,
      total_cases: this.cases.length,
      open_cases: openCases.length,
      resolved_cases: resolvedCases.length,
      executed_actions: executedActions.length,
      confirmed_recoveries: confirmedRecoveries,
      pending_recoveries: pendingRecoveries,
      blocked_cases: blockedCases,
      review_required_cases: reviewRequiredCases
    };
  }

  async listCases() {
    return [...this.cases].sort((a, b) => new Date(b.lastEventAt) - new Date(a.lastEventAt));
  }

  async getCaseDetail(id) {
    const recoveryCase = this.cases.find((item) => item.id === Number(id));
    if (!recoveryCase) return null;
    return {
      recoveryCase,
      events: await this.getEventsForPayment(recoveryCase.paymentId),
      auditEvents: this.audits.filter((audit) => audit.recoveryCaseId === recoveryCase.id).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
      actions: await this.findActionsByCaseId(recoveryCase.id),
      outcomes: await this.findOutcomesByCaseId(recoveryCase.id)
    };
  }
}

module.exports = { InMemoryRecoveryRepository };
