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
  first_detected_at TIMESTAMPTZ NOT NULL,
  last_event_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  recovery_case_id BIGINT NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('EVENT_RECEIVED', 'RISK_DETECTED', 'CASE_CREATED', 'CASE_UPDATED')),
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_case_id_idx ON audit_events (recovery_case_id, created_at);
