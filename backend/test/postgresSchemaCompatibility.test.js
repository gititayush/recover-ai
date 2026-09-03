import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { PostgresRecoveryRepository } from '../src/models/postgresRecoveryRepository';

describe('PostgreSQL Schema Compatibility — Milestone 7 Communication Constraints', () => {
  let pool;
  let repository;
  let testCaseId;
  const TEST_PAYMENT_ID = `pay_test_schema_${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    await migrate(pool);
    repository = new PostgresRecoveryRepository(pool);

    // Create a temporary test recovery case
    const caseResult = await pool.query(
      `INSERT INTO recovery_cases (
        payment_id, order_id, amount, currency, customer_reference,
        risk_status, risk_reason, risk_level, action_status,
        first_detected_at, last_event_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      RETURNING id`,
      [TEST_PAYMENT_ID, 'order_test_schema_01', 50000, 'INR', '+919999999999', 'RECOVERABLE', 'Schema test', 'MEDIUM', 'NOT_STARTED']
    );
    testCaseId = Number(caseResult.rows[0].id);
  });

  afterAll(async () => {
    if (pool && testCaseId) {
      try {
        await pool.query('DELETE FROM recovery_cases WHERE id = $1', [testCaseId]);
      } catch {
        // cleanup best-effort
      }
    }
  });

  describe('recovery_actions.action_type CHECK constraint', () => {
    it('accepts CUSTOMER_OUTREACH as a valid action_type in raw PostgreSQL query', async () => {
      const idempotencyKey = `test_action_outreach_${Date.now()}`;
      const result = await pool.query(
        `INSERT INTO recovery_actions (
          recovery_case_id, action_type, status, policy_decision, policy_version,
          idempotency_key, amount, currency
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, action_type`,
        [testCaseId, 'CUSTOMER_OUTREACH', 'EXECUTED', 'ALLOW', 'recoverai-policy-v1', idempotencyKey, 50000, 'INR']
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].action_type).toBe('CUSTOMER_OUTREACH');
    });

    it('accepts DISPATCH_VERNACULAR_ASSIST as a valid action_type in raw PostgreSQL query', async () => {
      const idempotencyKey = `test_action_assist_${Date.now()}`;
      const result = await pool.query(
        `INSERT INTO recovery_actions (
          recovery_case_id, action_type, status, policy_decision, policy_version,
          idempotency_key, amount, currency
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, action_type`,
        [testCaseId, 'DISPATCH_VERNACULAR_ASSIST', 'EXECUTED', 'ALLOW', 'recoverai-policy-v1', idempotencyKey, 50000, 'INR']
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].action_type).toBe('DISPATCH_VERNACULAR_ASSIST');
    });

    it('accepts CUSTOMER_OUTREACH via PostgresRecoveryRepository.createAction()', async () => {
      const idempotencyKey = `test_repo_outreach_${Date.now()}`;
      const action = await repository.createAction({
        recoveryCaseId: testCaseId,
        actionType: 'CUSTOMER_OUTREACH',
        status: 'EXECUTED',
        policyDecision: 'ALLOW',
        policyVersion: 'recoverai-policy-v1',
        idempotencyKey,
        provider: 'twilio_sandbox',
        providerActionId: 'SM_test_prov_01',
        amount: 50000,
        currency: 'INR',
        requestMetadata: { communication: { channel: 'whatsapp', recipient: '+919999999999' } },
        responseMetadata: { provider: 'twilio_sandbox', initialStatus: 'queued' }
      });

      expect(action).toBeDefined();
      expect(action.actionType).toBe('CUSTOMER_OUTREACH');
      expect(action.provider).toBe('twilio_sandbox');
    });

    it('strictly rejects invalid action_type violating check constraint', async () => {
      const idempotencyKey = `test_action_invalid_${Date.now()}`;
      await expect(
        pool.query(
          `INSERT INTO recovery_actions (
            recovery_case_id, action_type, status, policy_decision, policy_version,
            idempotency_key, amount, currency
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [testCaseId, 'UNAUTHORIZED_MAGIC_ACTION', 'EXECUTED', 'ALLOW', 'recoverai-policy-v1', idempotencyKey, 50000, 'INR']
        )
      ).rejects.toThrow();
    });
  });

  describe('audit_events.event_type CHECK constraint', () => {
    it('accepts COMMUNICATION_DISPATCHED as a valid audit event_type', async () => {
      const audit = await repository.addAudit(
        testCaseId,
        'COMMUNICATION_DISPATCHED',
        'Dispatched WhatsApp outreach via Twilio',
        { providerMessageId: 'SM_test_01' }
      );
      expect(audit).toBeDefined();
      expect(audit.eventType).toBe('COMMUNICATION_DISPATCHED');
    });

    it('accepts COMMUNICATION_FAILED as a valid audit event_type', async () => {
      const audit = await repository.addAudit(
        testCaseId,
        'COMMUNICATION_FAILED',
        'Twilio dispatch failed closed',
        { errorCode: 21608 }
      );
      expect(audit).toBeDefined();
      expect(audit.eventType).toBe('COMMUNICATION_FAILED');
    });

    it('accepts COMMUNICATION_STATUS_UPDATED as a valid audit event_type', async () => {
      const audit = await repository.addAudit(
        testCaseId,
        'COMMUNICATION_STATUS_UPDATED',
        'Twilio status updated to DELIVERED',
        { status: 'DELIVERED', providerMessageId: 'SM_test_01' }
      );
      expect(audit).toBeDefined();
      expect(audit.eventType).toBe('COMMUNICATION_STATUS_UPDATED');
    });

    it('strictly rejects unauthorized audit event_type violating check constraint', async () => {
      await expect(
        pool.query(
          `INSERT INTO audit_events (recovery_case_id, event_type, message)
           VALUES ($1, $2, $3)`,
          [testCaseId, 'ARBITRARY_UNVERIFIED_EVENT', 'Should fail']
        )
      ).rejects.toThrow();
    });
  });
});
