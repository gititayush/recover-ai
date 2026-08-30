class InMemoryRecoveryRepository {
  constructor() {
    this.events = [];
    this.cases = [];
    this.audits = [];
    this.nextCaseId = 1;
    this.nextAuditId = 1;
  }

  async createEvent(event) {
    if (this.events.some((stored) => stored.eventId === event.eventId)) return null;
    const stored = { ...event, receivedAt: new Date().toISOString() };
    this.events.push(stored);
    return stored;
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data
    };
    this.cases.push(recoveryCase);
    return recoveryCase;
  }

  async updateCase(id, changes) {
    const recoveryCase = this.cases.find((item) => item.id === id);
    Object.assign(recoveryCase, changes, { updatedAt: new Date().toISOString() });
    return recoveryCase;
  }

  async addAudit(recoveryCaseId, eventType, message, metadata = {}) {
    const audit = { id: this.nextAuditId++, recoveryCaseId, eventType, message, metadata, createdAt: new Date().toISOString() };
    this.audits.push(audit);
    return audit;
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
      auditEvents: this.audits.filter((audit) => audit.recoveryCaseId === recoveryCase.id).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    };
  }
}

module.exports = { InMemoryRecoveryRepository };
