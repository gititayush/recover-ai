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

function mapDiagnosis(row) {
  return {
    id: Number(row.id), recoveryCaseId: Number(row.recovery_case_id),
    diagnosis: { cause: row.diagnosis_cause, confidence: Number(row.confidence), evidence: row.evidence },
    proposedAction: row.proposed_action,
    recommendation: { action: row.recommended_action, reason: row.selection_reason },
    candidates: row.candidate_interventions,
    provider: row.provider, model: row.model, promptVersion: row.prompt_version, source: row.source, createdAt: row.created_at
  };
}

function mapAction(row) {
  return {
    id: Number(row.id), recoveryCaseId: Number(row.recovery_case_id),
    actionType: row.action_type, status: row.status, policyDecision: row.policy_decision, policyVersion: row.policy_version,
    idempotencyKey: row.idempotency_key, provider: row.provider, providerActionId: row.provider_action_id, paymentLinkUrl: row.payment_link_url,
    amount: Number(row.amount), currency: row.currency, requestMetadata: row.request_metadata, responseMetadata: row.response_metadata,
    failureReason: row.failure_reason, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at
  };
}

class PostgresRecoveryRepository {
  constructor(pool) { this.pool = pool; }

  async createEvent(event) {
    const result = await this.pool.query(
      `INSERT INTO revenue_events (event_id, event_type, payment_id, order_id, amount, currency, payment_status, failure_reason, customer_reference, occurred_at, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (event_id) DO NOTHING RETURNING *`,
      [event.eventId, event.eventType, event.paymentId, event.orderId, event.amount, event.currency, event.paymentStatus, event.failureReason, event.customerReference, event.timestamp, typeof event.rawPayload === 'string' ? event.rawPayload : JSON.stringify(event.rawPayload || {})]
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
      `UPDATE recovery_cases SET risk_status=COALESCE($2, risk_status), risk_reason=COALESCE($3, risk_reason), risk_level=COALESCE($4, risk_level), outcome=COALESCE($5, outcome), action_status=COALESCE($6, action_status), last_event_at=COALESCE($7, last_event_at), updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, changes.riskStatus || null, changes.riskReason || null, changes.riskLevel || null, changes.outcome || null, changes.actionStatus || null, changes.lastEventAt || null]
    );
    return mapCase(result.rows[0]);
  }

  async addAudit(recoveryCaseId, eventType, message, metadata = {}) {
    const result = await this.pool.query(
      'INSERT INTO audit_events (recovery_case_id, event_type, message, metadata) VALUES ($1,$2,$3,$4) RETURNING *',
      [recoveryCaseId, eventType, message, JSON.stringify(metadata)]
    );
    const row = result.rows[0];
    return { id: Number(row.id), recoveryCaseId: Number(row.recovery_case_id), eventType: row.event_type, message: row.message, metadata: row.metadata, createdAt: row.created_at };
  }

  async findDiagnosisByCaseId(recoveryCaseId) {
    const result = await this.pool.query('SELECT * FROM ai_diagnoses WHERE recovery_case_id = $1', [recoveryCaseId]);
    return result.rows[0] ? mapDiagnosis(result.rows[0]) : null;
  }

  async createDiagnosis(data) {
    const result = await this.pool.query(
      `INSERT INTO ai_diagnoses (recovery_case_id, diagnosis_cause, confidence, evidence, proposed_action, recommended_action, selection_reason, candidate_interventions, provider, model, prompt_version, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (recovery_case_id) DO NOTHING RETURNING *`,
      [data.recoveryCaseId, data.diagnosis.cause, data.diagnosis.confidence, JSON.stringify(data.diagnosis.evidence), data.proposedAction, data.recommendation.action, data.recommendation.reason, JSON.stringify(data.candidates), data.provider, data.model, data.promptVersion, data.source]
    );
    return result.rows[0] ? mapDiagnosis(result.rows[0]) : null;
  }

  async createAction(data) {
    const result = await this.pool.query(
      `INSERT INTO recovery_actions (recovery_case_id, action_type, status, policy_decision, policy_version, idempotency_key, provider, provider_action_id, payment_link_url, amount, currency, request_metadata, response_metadata, failure_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [data.recoveryCaseId, data.actionType, data.status, data.policyDecision, data.policyVersion, data.idempotencyKey, data.provider || 'razorpay', data.providerActionId || null, data.paymentLinkUrl || null, data.amount, data.currency, JSON.stringify(data.requestMetadata || {}), JSON.stringify(data.responseMetadata || {}), data.failureReason || null]
    );
    if (!result.rows[0]) {
      return this.findActionByIdempotencyKey(data.idempotencyKey);
    }
    return mapAction(result.rows[0]);
  }

  async updateAction(id, changes) {
    const result = await this.pool.query(
      `UPDATE recovery_actions SET status=COALESCE($2, status), provider_action_id=COALESCE($3, provider_action_id), payment_link_url=COALESCE($4, payment_link_url), completed_at=COALESCE($5, completed_at), failure_reason=COALESCE($6, failure_reason), response_metadata=COALESCE($7, response_metadata), updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, changes.status, changes.providerActionId, changes.paymentLinkUrl, changes.completedAt, changes.failureReason, changes.responseMetadata ? JSON.stringify(changes.responseMetadata) : null]
    );
    return result.rows[0] ? mapAction(result.rows[0]) : null;
  }

  async findActionByIdempotencyKey(key) {
    const result = await this.pool.query('SELECT * FROM recovery_actions WHERE idempotency_key = $1', [key]);
    return result.rows[0] ? mapAction(result.rows[0]) : null;
  }

  async findActionsByCaseId(recoveryCaseId) {
    const result = await this.pool.query('SELECT * FROM recovery_actions WHERE recovery_case_id = $1 ORDER BY created_at ASC', [recoveryCaseId]);
    return result.rows.map(mapAction);
  }

  async getLatestActionForCase(recoveryCaseId) {
    const result = await this.pool.query('SELECT * FROM recovery_actions WHERE recovery_case_id = $1 ORDER BY created_at DESC LIMIT 1', [recoveryCaseId]);
    return result.rows[0] ? mapAction(result.rows[0]) : null;
  }

  async listCases() {
    const result = await this.pool.query('SELECT * FROM recovery_cases ORDER BY last_event_at DESC');
    return result.rows.map(mapCase);
  }

  async getCaseDetail(id) {
    const result = await this.pool.query('SELECT * FROM recovery_cases WHERE id = $1', [id]);
    if (!result.rows[0]) return null;
    const recoveryCase = mapCase(result.rows[0]);
    const [events, audits, actions] = await Promise.all([
      this.getEventsForPayment(recoveryCase.paymentId),
      this.pool.query('SELECT * FROM audit_events WHERE recovery_case_id = $1 ORDER BY created_at ASC', [id]),
      this.findActionsByCaseId(recoveryCase.id)
    ]);
    return {
      recoveryCase,
      events,
      auditEvents: audits.rows.map((row) => ({ id: Number(row.id), recoveryCaseId: Number(row.recovery_case_id), eventType: row.event_type, message: row.message, metadata: row.metadata, createdAt: row.created_at })),
      actions
    };
  }
}

module.exports = { PostgresRecoveryRepository };
