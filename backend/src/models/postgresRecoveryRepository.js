function mapEvent(row) {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    paymentId: row.payment_id,
    orderId: row.order_id,
    amount: Number(row.amount),
    currency: row.currency,
    paymentStatus: row.payment_status,
    failureReason: row.failure_reason,
    customerReference: row.customer_reference,
    timestamp: row.occurred_at,
    rawPayload: row.raw_payload,
    receivedAt: row.received_at
  };
}

function mapCase(row) {
  return {
    id: Number(row.id), paymentId: row.payment_id, orderId: row.order_id, amount: Number(row.amount), currency: row.currency,
    customerReference: row.customer_reference, riskStatus: row.risk_status, riskReason: row.risk_reason, riskLevel: row.risk_level,
    actionStatus: row.action_status, outcome: row.outcome, firstDetectedAt: row.first_detected_at, lastEventAt: row.last_event_at,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

class PostgresRecoveryRepository {
  constructor(pool) { this.pool = pool; }

  async createEvent(event) {
    const result = await this.pool.query(
      `INSERT INTO revenue_events (event_id, event_type, payment_id, order_id, amount, currency, payment_status, failure_reason, customer_reference, occurred_at, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (event_id) DO NOTHING RETURNING *`,
      [event.eventId, event.eventType, event.paymentId, event.orderId, event.amount, event.currency, event.paymentStatus, event.failureReason, event.customerReference, event.timestamp, event.rawPayload]
    );
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  }

  async createProviderWebhookEvent(data) {
    const result = await this.pool.query(
      `INSERT INTO provider_webhook_events (provider, provider_event_id, event_type, raw_payload, signature_verified, processing_status)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING *`,
      [data.provider, data.providerEventId, data.eventType, data.rawPayload, data.signatureVerified, data.processingStatus]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return { id: Number(row.id), provider: row.provider, providerEventId: row.provider_event_id, eventType: row.event_type, rawPayload: row.raw_payload, signatureVerified: row.signature_verified, receivedAt: row.received_at, processingStatus: row.processing_status, processingError: row.processing_error };
  }

  async updateProviderWebhookEvent(id, changes) {
    const result = await this.pool.query(
      `UPDATE provider_webhook_events SET processing_status = $2, processing_error = $3 WHERE id = $1 RETURNING *`,
      [id, changes.processingStatus, changes.processingError || null]
    );
    const row = result.rows[0];
    return { id: Number(row.id), provider: row.provider, providerEventId: row.provider_event_id, eventType: row.event_type, rawPayload: row.raw_payload, signatureVerified: row.signature_verified, receivedAt: row.received_at, processingStatus: row.processing_status, processingError: row.processing_error };
  }

  async withTransaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(new PostgresRecoveryRepository(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getEventsForPayment(paymentId) {
    const result = await this.pool.query('SELECT * FROM revenue_events WHERE payment_id = $1 ORDER BY occurred_at ASC', [paymentId]);
    return result.rows.map(mapEvent);
  }

  async findCaseByPaymentId(paymentId) {
    const result = await this.pool.query('SELECT * FROM recovery_cases WHERE payment_id = $1', [paymentId]);
    return result.rows[0] ? mapCase(result.rows[0]) : null;
  }

  async createCase(data) {
    const result = await this.pool.query(
      `INSERT INTO recovery_cases (payment_id, order_id, amount, currency, customer_reference, risk_status, risk_reason, risk_level, first_detected_at, last_event_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [data.paymentId, data.orderId, data.amount, data.currency, data.customerReference, data.riskStatus, data.riskReason, data.riskLevel, data.firstDetectedAt, data.lastEventAt]
    );
    return mapCase(result.rows[0]);
  }

  async updateCase(id, changes) {
    const result = await this.pool.query(
      `UPDATE recovery_cases SET risk_status=$2, risk_reason=$3, risk_level=$4, outcome=$5, last_event_at=$6, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, changes.riskStatus, changes.riskReason, changes.riskLevel, changes.outcome, changes.lastEventAt]
    );
    return mapCase(result.rows[0]);
  }

  async addAudit(recoveryCaseId, eventType, message, metadata = {}) {
    const result = await this.pool.query(
      'INSERT INTO audit_events (recovery_case_id, event_type, message, metadata) VALUES ($1,$2,$3,$4) RETURNING *',
      [recoveryCaseId, eventType, message, metadata]
    );
    const row = result.rows[0];
    return { id: Number(row.id), recoveryCaseId: Number(row.recovery_case_id), eventType: row.event_type, message: row.message, metadata: row.metadata, createdAt: row.created_at };
  }

  async listCases() {
    const result = await this.pool.query('SELECT * FROM recovery_cases ORDER BY last_event_at DESC');
    return result.rows.map(mapCase);
  }

  async getCaseDetail(id) {
    const result = await this.pool.query('SELECT * FROM recovery_cases WHERE id = $1', [id]);
    if (!result.rows[0]) return null;
    const recoveryCase = mapCase(result.rows[0]);
    const [events, audits] = await Promise.all([
      this.getEventsForPayment(recoveryCase.paymentId),
      this.pool.query('SELECT * FROM audit_events WHERE recovery_case_id = $1 ORDER BY created_at ASC', [id])
    ]);
    return { recoveryCase, events, auditEvents: audits.rows.map((row) => ({ id: Number(row.id), recoveryCaseId: Number(row.recovery_case_id), eventType: row.event_type, message: row.message, metadata: row.metadata, createdAt: row.created_at })) };
  }
}

module.exports = { PostgresRecoveryRepository };
