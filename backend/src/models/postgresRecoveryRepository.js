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
    actionStatus: row.action_status, outcome: row.outcome, recoveredAmount: Number(row.recovered_amount || 0),
    autonomyStatus: row.autonomy_status || 'INACTIVE',
    autonomyAttempts: Number(row.autonomy_attempts || 0),
    autonomyLeaseToken: row.autonomy_lease_token || null,
    lockedUntil: row.locked_until || null,
    lockedBy: row.locked_by || null,
    nextRetryAt: row.next_retry_at || null,
    lastAutonomyError: row.last_autonomy_error || null,
    escalationStatus: row.escalation_status || 'NONE',
    escalatedAt: row.escalated_at || null,
    escalatedReason: row.escalated_reason || null,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    rejectedBy: row.rejected_by || null,
    rejectedAt: row.rejected_at || null,
    reviewNotes: row.review_notes || null,
    firstDetectedAt: row.first_detected_at, lastEventAt: row.last_event_at,
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

function mapOutcome(row) {
  return {
    id: Number(row.id),
    recoveryCaseId: Number(row.recovery_case_id),
    recoveryActionId: row.recovery_action_id ? Number(row.recovery_action_id) : null,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    providerPaymentLinkId: row.provider_payment_link_id,
    providerPaymentId: row.provider_payment_id,
    providerOrderId: row.provider_order_id,
    amountExpected: Number(row.amount_expected),
    amountPaid: Number(row.amount_paid),
    currency: row.currency,
    outcome: row.outcome,
    verified: Boolean(row.verified),
    verificationReason: row.verification_reason,
    providerTimestamp: row.provider_timestamp,
    receivedAt: row.received_at,
    createdAt: row.created_at
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
      `INSERT INTO recovery_cases (payment_id, order_id, amount, currency, customer_reference, risk_status, risk_reason, risk_level, autonomy_status, first_detected_at, last_event_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'INACTIVE'),$10,$11) RETURNING *`,
      [data.paymentId, data.orderId, data.amount, data.currency, data.customerReference, data.riskStatus, data.riskReason, data.riskLevel, data.autonomyStatus || null, data.firstDetectedAt, data.lastEventAt]
    );
    return mapCase(result.rows[0]);
  }

  async updateCase(id, changes) {
    const result = await this.pool.query(
      `UPDATE recovery_cases SET
        risk_status=COALESCE($2, risk_status),
        risk_reason=COALESCE($3, risk_reason),
        risk_level=COALESCE($4, risk_level),
        outcome=COALESCE($5, outcome),
        action_status=COALESCE($6, action_status),
        recovered_amount=COALESCE($7, recovered_amount),
        last_event_at=COALESCE($8, last_event_at),
        autonomy_status=COALESCE($9, autonomy_status),
        autonomy_attempts=COALESCE($10, autonomy_attempts),
        autonomy_lease_token=COALESCE($11, autonomy_lease_token),
        locked_until=COALESCE($12, locked_until),
        locked_by=COALESCE($13, locked_by),
        next_retry_at=COALESCE($14, next_retry_at),
        last_autonomy_error=COALESCE($15, last_autonomy_error),
        escalation_status=COALESCE($16, escalation_status),
        escalated_at=COALESCE($17, escalated_at),
        escalated_reason=COALESCE($18, escalated_reason),
        approved_by=COALESCE($19, approved_by),
        approved_at=COALESCE($20, approved_at),
        rejected_by=COALESCE($21, rejected_by),
        rejected_at=COALESCE($22, rejected_at),
        review_notes=COALESCE($23, review_notes),
        updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [
        id,
        changes.riskStatus || null,
        changes.riskReason || null,
        changes.riskLevel || null,
        changes.outcome || null,
        changes.actionStatus || null,
        changes.recoveredAmount !== undefined ? changes.recoveredAmount : null,
        changes.lastEventAt || null,
        changes.autonomyStatus || null,
        changes.autonomyAttempts !== undefined ? changes.autonomyAttempts : null,
        changes.autonomyLeaseToken !== undefined ? changes.autonomyLeaseToken : null,
        changes.lockedUntil !== undefined ? changes.lockedUntil : null,
        changes.lockedBy !== undefined ? changes.lockedBy : null,
        changes.nextRetryAt !== undefined ? changes.nextRetryAt : null,
        changes.lastAutonomyError !== undefined ? changes.lastAutonomyError : null,
        changes.escalationStatus !== undefined ? changes.escalationStatus : null,
        changes.escalatedAt !== undefined ? changes.escalatedAt : null,
        changes.escalatedReason !== undefined ? changes.escalatedReason : null,
        changes.approvedBy !== undefined ? changes.approvedBy : null,
        changes.approvedAt !== undefined ? changes.approvedAt : null,
        changes.rejectedBy !== undefined ? changes.rejectedBy : null,
        changes.rejectedAt !== undefined ? changes.rejectedAt : null,
        changes.reviewNotes !== undefined ? changes.reviewNotes : null
      ]
    );
    return mapCase(result.rows[0]);
  }

  async listPendingEscalations() {
    const result = await this.pool.query(
      "SELECT * FROM recovery_cases WHERE escalation_status = 'PENDING_APPROVAL' OR autonomy_status = 'REVIEW_REQUIRED' ORDER BY created_at DESC"
    );
    return result.rows.map(mapCase);
  }

  async claimNextJob({ workerId, leaseDurationSeconds = 60 }) {
    const crypto = require('crypto');
    const leaseToken = crypto.randomUUID();
    const result = await this.pool.query(
      `WITH candidate AS (
        SELECT id
        FROM recovery_cases
        WHERE (
          (autonomy_status = 'QUEUED' AND (locked_until IS NULL OR locked_until <= NOW()))
          OR
          (autonomy_status = 'RETRY_SCHEDULED' AND next_retry_at <= NOW() AND (locked_until IS NULL OR locked_until <= NOW()))
          OR
          (autonomy_status = 'CLAIMED' AND locked_until IS NOT NULL AND locked_until <= NOW())
        )
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE recovery_cases c
      SET
        autonomy_status = 'CLAIMED',
        autonomy_attempts = c.autonomy_attempts + 1,
        autonomy_lease_token = $1,
        locked_until = NOW() + ($2 || ' seconds')::INTERVAL,
        locked_by = $3,
        updated_at = NOW()
      FROM candidate
      WHERE c.id = candidate.id
      RETURNING c.*`,
      [leaseToken, leaseDurationSeconds, workerId]
    );
    return result.rows[0] ? mapCase(result.rows[0]) : null;
  }

  async extendLease(caseId, leaseToken, { leaseDurationSeconds = 60 }) {
    const result = await this.pool.query(
      `UPDATE recovery_cases
       SET locked_until = NOW() + ($2 || ' seconds')::INTERVAL, updated_at = NOW()
       WHERE id = $1 AND autonomy_lease_token = $3 AND autonomy_status = 'CLAIMED'
       RETURNING *`,
      [caseId, leaseDurationSeconds, leaseToken]
    );
    return result.rows[0] ? mapCase(result.rows[0]) : null;
  }

  async releaseJob(caseId, leaseToken, updates = {}) {
    const result = await this.pool.query(
      `UPDATE recovery_cases
       SET
         autonomy_status = COALESCE($3, autonomy_status),
         locked_until = NULL,
         locked_by = NULL,
         next_retry_at = $4,
         last_autonomy_error = COALESCE($5, last_autonomy_error),
         escalation_status = COALESCE($6, escalation_status),
         escalated_at = COALESCE($7, escalated_at),
         escalated_reason = COALESCE($8, escalated_reason),
         updated_at = NOW()
       WHERE id = $1 AND autonomy_lease_token = $2
       RETURNING *`,
      [
        caseId,
        leaseToken,
        updates.autonomyStatus || null,
        updates.nextRetryAt || null,
        updates.lastAutonomyError || null,
        updates.escalationStatus || null,
        updates.escalatedAt || null,
        updates.escalatedReason || null
      ]
    );
    return result.rows[0] ? mapCase(result.rows[0]) : null;
  }

  async scheduleRetry(caseId, leaseToken, { backoffSeconds = 30, error = null }) {
    const result = await this.pool.query(
      `UPDATE recovery_cases
       SET
         autonomy_status = 'RETRY_SCHEDULED',
         locked_until = NULL,
         locked_by = NULL,
         next_retry_at = NOW() + ($3 || ' seconds')::INTERVAL,
         last_autonomy_error = $4,
         updated_at = NOW()
       WHERE id = $1 AND autonomy_lease_token = $2
       RETURNING *`,
      [caseId, leaseToken, backoffSeconds, error]
    );
    return result.rows[0] ? mapCase(result.rows[0]) : null;
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
    try {
      const result = await this.pool.query(
        `INSERT INTO recovery_actions (recovery_case_id, action_type, status, policy_decision, policy_version, idempotency_key, provider, provider_action_id, payment_link_url, amount, currency, request_metadata, response_metadata, failure_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [data.recoveryCaseId, data.actionType, data.status, data.policyDecision, data.policyVersion, data.idempotencyKey, data.provider || 'razorpay', data.providerActionId || null, data.paymentLinkUrl || null, data.amount, data.currency, JSON.stringify(data.requestMetadata || {}), JSON.stringify(data.responseMetadata || {}), data.failureReason || null]
      );
      if (!result.rows[0]) {
        return this.findActionByIdempotencyKey(data.idempotencyKey);
      }
      return mapAction(result.rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        const existingByKey = await this.findActionByIdempotencyKey(data.idempotencyKey);
        if (existingByKey) return existingByKey;
        const activeAction = await this.getLatestActionForCase(data.recoveryCaseId);
        if (activeAction) return activeAction;
      }
      throw err;
    }
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

  async findActionByPaymentLinkId(paymentLinkId) {
    const result = await this.pool.query('SELECT * FROM recovery_actions WHERE provider_action_id = $1 LIMIT 1', [paymentLinkId]);
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

  async createOutcome(data) {
    const result = await this.pool.query(
      `INSERT INTO recovery_outcomes (
        recovery_case_id, recovery_action_id, provider, provider_event_id,
        provider_payment_link_id, provider_payment_id, provider_order_id,
        amount_expected, amount_paid, currency, outcome, verified,
        verification_reason, provider_timestamp
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING *`,
      [
        data.recoveryCaseId,
        data.recoveryActionId || null,
        data.provider || 'razorpay',
        data.providerEventId,
        data.providerPaymentLinkId || null,
        data.providerPaymentId || null,
        data.providerOrderId || null,
        data.amountExpected,
        data.amountPaid,
        data.currency,
        data.outcome,
        Boolean(data.verified),
        data.verificationReason,
        data.providerTimestamp || new Date().toISOString()
      ]
    );
    if (!result.rows[0]) {
      return this.findOutcomeByEventId(data.provider || 'razorpay', data.providerEventId);
    }
    return mapOutcome(result.rows[0]);
  }

  async findOutcomeByEventId(provider, providerEventId) {
    const result = await this.pool.query(
      'SELECT * FROM recovery_outcomes WHERE provider = $1 AND provider_event_id = $2',
      [provider, providerEventId]
    );
    return result.rows[0] ? mapOutcome(result.rows[0]) : null;
  }

  async findOutcomeByActionId(recoveryActionId) {
    const result = await this.pool.query(
      'SELECT * FROM recovery_outcomes WHERE recovery_action_id = $1 ORDER BY created_at DESC LIMIT 1',
      [recoveryActionId]
    );
    return result.rows[0] ? mapOutcome(result.rows[0]) : null;
  }

  async findOutcomesByCaseId(recoveryCaseId) {
    const result = await this.pool.query(
      'SELECT * FROM recovery_outcomes WHERE recovery_case_id = $1 ORDER BY created_at ASC',
      [recoveryCaseId]
    );
    return result.rows.map(mapOutcome);
  }

  async getRecoveryMetrics() {
    const [casesRes, outcomesRes, actionsRes] = await Promise.all([
      this.pool.query(`
        SELECT
          COUNT(*) AS total_cases,
          COUNT(*) FILTER (WHERE risk_status IN ('OPEN', 'RECOVERABLE')) AS open_cases,
          COUNT(*) FILTER (WHERE risk_status = 'RESOLVED') AS resolved_cases,
          COALESCE(SUM(amount) FILTER (WHERE risk_status IN ('OPEN', 'RECOVERABLE')), 0) AS revenue_at_risk
        FROM recovery_cases
      `),
      this.pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE verified = true) AS confirmed_recoveries,
          COALESCE(SUM(amount_paid) FILTER (WHERE verified = true), 0) AS revenue_recovered
        FROM recovery_outcomes
      `),
      this.pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('EXECUTED', 'OUTCOME_CONFIRMED')) AS executed_actions,
          COUNT(*) FILTER (WHERE status = 'EXECUTED') AS pending_recoveries,
          COUNT(*) FILTER (WHERE status = 'BLOCKED') AS blocked_cases,
          COUNT(*) FILTER (WHERE status = 'REVIEW_REQUIRED') AS review_required_cases
        FROM recovery_actions
      `)
    ]);

    const casesRow = casesRes.rows[0];
    const outcomesRow = outcomesRes.rows[0];
    const actionsRow = actionsRes.rows[0];

    const revenueAtRisk = Number(casesRow.revenue_at_risk || 0);
    const revenueRecovered = Number(outcomesRow.revenue_recovered || 0);
    const totalPotential = revenueAtRisk + revenueRecovered;
    const recoveryRate = totalPotential > 0 ? Number((revenueRecovered / totalPotential).toFixed(4)) : 0;

    return {
      revenue_at_risk: revenueAtRisk,
      revenue_recovered: revenueRecovered,
      recovery_rate: recoveryRate,
      total_cases: Number(casesRow.total_cases || 0),
      open_cases: Number(casesRow.open_cases || 0),
      resolved_cases: Number(casesRow.resolved_cases || 0),
      executed_actions: Number(actionsRow.executed_actions || 0),
      confirmed_recoveries: Number(outcomesRow.confirmed_recoveries || 0),
      pending_recoveries: Number(actionsRow.pending_recoveries || 0),
      blocked_cases: Number(actionsRow.blocked_cases || 0),
      review_required_cases: Number(actionsRow.review_required_cases || 0)
    };
  }

  async listCases() {
    const result = await this.pool.query('SELECT * FROM recovery_cases ORDER BY last_event_at DESC');
    return result.rows.map(mapCase);
  }

  async getCaseDetail(id) {
    const result = await this.pool.query('SELECT * FROM recovery_cases WHERE id = $1', [id]);
    if (!result.rows[0]) return null;
    const recoveryCase = mapCase(result.rows[0]);
    const [events, audits, actions, outcomes] = await Promise.all([
      this.getEventsForPayment(recoveryCase.paymentId),
      this.pool.query('SELECT * FROM audit_events WHERE recovery_case_id = $1 ORDER BY created_at ASC', [id]),
      this.findActionsByCaseId(recoveryCase.id),
      this.findOutcomesByCaseId(recoveryCase.id)
    ]);
    return {
      recoveryCase,
      events,
      auditEvents: audits.rows.map((row) => ({ id: Number(row.id), recoveryCaseId: Number(row.recovery_case_id), eventType: row.event_type, message: row.message, metadata: row.metadata, createdAt: row.created_at })),
      actions,
      outcomes
    };
  }
}

module.exports = { PostgresRecoveryRepository };
