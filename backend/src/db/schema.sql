CREATE TABLE IF NOT EXISTS revenue_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  order_id TEXT,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL,
  payment_status TEXT NOT NULL,
  failure_reason TEXT,
  customer_reference TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  raw_payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS revenue_events_payment_id_idx ON revenue_events (payment_id, occurred_at);

CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT,
  raw_payload TEXT NOT NULL,
  signature_verified BOOLEAN NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_status TEXT NOT NULL CHECK (processing_status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED')),
  processing_error TEXT,
  CONSTRAINT provider_webhook_events_provider_event_unique UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS provider_webhook_events_received_at_idx ON provider_webhook_events (received_at DESC);

CREATE TABLE IF NOT EXISTS recovery_cases (
  id BIGSERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE,
  order_id TEXT,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL,
  customer_reference TEXT,
  risk_status TEXT NOT NULL CHECK (risk_status IN ('OPEN', 'RECOVERABLE', 'RESOLVED', 'SUPPRESSED')),
  risk_reason TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  action_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  outcome TEXT,
  recovered_amount BIGINT NOT NULL DEFAULT 0 CHECK (recovered_amount >= 0),
  autonomy_status TEXT NOT NULL DEFAULT 'INACTIVE' CHECK (autonomy_status IN ('INACTIVE', 'QUEUED', 'CLAIMED', 'COMPLETED', 'REVIEW_REQUIRED', 'BLOCKED', 'RETRY_SCHEDULED', 'FAILED')),
  autonomy_attempts INTEGER NOT NULL DEFAULT 0 CHECK (autonomy_attempts >= 0),
  autonomy_lease_token TEXT,
  locked_until TIMESTAMPTZ,
  locked_by TEXT,
  next_retry_at TIMESTAMPTZ,
  last_autonomy_error TEXT,
  first_detected_at TIMESTAMPTZ NOT NULL,
  last_event_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS recovered_amount BIGINT NOT NULL DEFAULT 0 CHECK (recovered_amount >= 0);
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS autonomy_status TEXT NOT NULL DEFAULT 'INACTIVE';
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS autonomy_attempts INTEGER NOT NULL DEFAULT 0 CHECK (autonomy_attempts >= 0);
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS autonomy_lease_token TEXT;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS last_autonomy_error TEXT;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS escalation_status TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS escalated_reason TEXT;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS rejected_by TEXT;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS review_notes TEXT;

ALTER TABLE recovery_cases DROP CONSTRAINT IF EXISTS recovery_cases_autonomy_status_check;
ALTER TABLE recovery_cases ADD CONSTRAINT recovery_cases_autonomy_status_check CHECK (
  autonomy_status IN ('INACTIVE', 'QUEUED', 'CLAIMED', 'COMPLETED', 'REVIEW_REQUIRED', 'BLOCKED', 'RETRY_SCHEDULED', 'FAILED')
);

ALTER TABLE recovery_cases DROP CONSTRAINT IF EXISTS recovery_cases_escalation_status_check;
ALTER TABLE recovery_cases ADD CONSTRAINT recovery_cases_escalation_status_check CHECK (
  escalation_status IN ('NONE', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED')
);

CREATE INDEX IF NOT EXISTS recovery_cases_autonomy_queue_idx
ON recovery_cases (autonomy_status, next_retry_at, locked_until)
WHERE autonomy_status IN ('QUEUED', 'RETRY_SCHEDULED', 'CLAIMED');

CREATE INDEX IF NOT EXISTS recovery_cases_escalation_status_idx
ON recovery_cases (escalation_status)
WHERE escalation_status = 'PENDING_APPROVAL';

CREATE TABLE IF NOT EXISTS ai_diagnoses (
  id BIGSERIAL PRIMARY KEY,
  recovery_case_id BIGINT NOT NULL UNIQUE REFERENCES recovery_cases(id) ON DELETE CASCADE,
  diagnosis_cause TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence JSONB NOT NULL,
  proposed_action TEXT NOT NULL CHECK (proposed_action IN ('CREATE_PAYMENT_LINK', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION')),
  recommended_action TEXT NOT NULL CHECK (recommended_action IN ('CREATE_PAYMENT_LINK', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION')),
  selection_reason TEXT NOT NULL,
  candidate_interventions JSONB NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('live_ai', 'development_fallback', 'system_safety')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_diagnoses_created_at_idx ON ai_diagnoses (created_at DESC);

CREATE TABLE IF NOT EXISTS recovery_actions (
  id BIGSERIAL PRIMARY KEY,
  recovery_case_id BIGINT NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('CREATE_PAYMENT_LINK', 'REQUEST_MANUAL_REVIEW', 'NO_ACTION')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'EXECUTING', 'EXECUTED', 'OUTCOME_CONFIRMED', 'FAILED', 'BLOCKED', 'REVIEW_REQUIRED', 'SUPERSEDED')),
  policy_decision TEXT NOT NULL CHECK (policy_decision IN ('ALLOW', 'REVIEW', 'BLOCK')),
  policy_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'razorpay',
  provider_action_id TEXT,
  payment_link_url TEXT,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL,
  request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE recovery_actions DROP CONSTRAINT IF EXISTS recovery_actions_status_check;
ALTER TABLE recovery_actions ADD CONSTRAINT recovery_actions_status_check CHECK (
  status IN ('PENDING', 'APPROVED', 'EXECUTING', 'EXECUTED', 'OUTCOME_CONFIRMED', 'FAILED', 'BLOCKED', 'REVIEW_REQUIRED', 'SUPERSEDED')
);

CREATE INDEX IF NOT EXISTS recovery_actions_case_id_idx ON recovery_actions (recovery_case_id, created_at);
CREATE INDEX IF NOT EXISTS recovery_actions_status_idx ON recovery_actions (status);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_actions_case_active_plink_idx
ON recovery_actions (recovery_case_id)
WHERE action_type = 'CREATE_PAYMENT_LINK' AND status IN ('EXECUTING', 'EXECUTED', 'OUTCOME_CONFIRMED');

CREATE TABLE IF NOT EXISTS recovery_outcomes (
  id BIGSERIAL PRIMARY KEY,
  recovery_case_id BIGINT NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  recovery_action_id BIGINT REFERENCES recovery_actions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'razorpay',
  provider_event_id TEXT NOT NULL,
  provider_payment_link_id TEXT,
  provider_payment_id TEXT,
  provider_order_id TEXT,
  amount_expected BIGINT NOT NULL CHECK (amount_expected >= 0),
  amount_paid BIGINT NOT NULL CHECK (amount_paid >= 0),
  currency CHAR(3) NOT NULL,
  outcome TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT false,
  verification_reason TEXT NOT NULL,
  provider_timestamp TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT recovery_outcomes_provider_event_unique UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS recovery_outcomes_case_id_idx ON recovery_outcomes (recovery_case_id, created_at);
CREATE INDEX IF NOT EXISTS recovery_outcomes_action_id_idx ON recovery_outcomes (recovery_action_id);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_outcomes_action_verified_idx ON recovery_outcomes (recovery_action_id) WHERE (verified = true);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  recovery_case_id BIGINT NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_type_check CHECK (
  event_type IN (
    'EVENT_RECEIVED', 'RISK_DETECTED', 'CASE_CREATED', 'CASE_UPDATED', 'AI_DIAGNOSIS',
    'POLICY_EVALUATED', 'ACTION_APPROVED', 'ACTION_BLOCKED', 'ACTION_REVIEW_REQUIRED',
    'ACTION_EXECUTION_STARTED', 'ACTION_EXECUTED', 'ACTION_EXECUTION_FAILED',
    'RECOVERY_OUTCOME_RECEIVED', 'RECOVERY_OUTCOME_VERIFIED', 'RECOVERY_OUTCOME_REJECTED',
    'REVENUE_RECOVERED',
    'AUTONOMY_QUEUED', 'AUTONOMY_CLAIMED', 'AUTONOMY_COMPLETED',
    'AUTONOMY_REVIEW_REQUIRED', 'AUTONOMY_BLOCKED', 'AUTONOMY_RETRY', 'AUTONOMY_FAILED',
    'ESCALATION_TRIGGERED', 'ESCALATION_APPROVED', 'ESCALATION_REJECTED'
  )
);

CREATE INDEX IF NOT EXISTS audit_events_case_id_idx ON audit_events (recovery_case_id, created_at);
