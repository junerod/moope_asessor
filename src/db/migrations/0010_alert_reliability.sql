-- Alert reliability: outbox + delivery tracking on reminders
-- Idempotent. Safe to re-run.

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_error text NULL,
  ADD COLUMN IF NOT EXISTS last_delivered_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS locked_by varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS occurrence_key varchar(191) NULL;

CREATE INDEX IF NOT EXISTS reminders_due_claim_idx
  ON reminders (status, fire_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS reminders_next_attempt_idx
  ON reminders (status, next_attempt_at)
  WHERE deleted_at IS NULL AND next_attempt_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS reminders_occurrence_key_uidx
  ON reminders (occurrence_key)
  WHERE occurrence_key IS NOT NULL;

DO $$ BEGIN
  CREATE TYPE alert_outbox_status AS ENUM (
    'pending',
    'processing',
    'delivered',
    'failed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS alert_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type varchar(32) NOT NULL, -- reminder | appointment
  source_id uuid NOT NULL,
  occurrence_key varchar(191) NOT NULL,
  fire_at timestamptz NOT NULL,
  title varchar(500) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status alert_outbox_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 12,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text NULL,
  delivered_at timestamptz NULL,
  delivered_message_id uuid NULL REFERENCES messages(id) ON DELETE SET NULL,
  job_idempotency_key varchar(191) NULL,
  locked_at timestamptz NULL,
  locked_by varchar(128) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_outbox_occurrence_uidx UNIQUE (occurrence_key)
);

CREATE INDEX IF NOT EXISTS alert_outbox_due_idx
  ON alert_outbox (status, next_attempt_at, fire_at);

CREATE INDEX IF NOT EXISTS alert_outbox_workspace_idx
  ON alert_outbox (workspace_id, status);

CREATE INDEX IF NOT EXISTS alert_outbox_source_idx
  ON alert_outbox (source_type, source_id);

-- Backfill outbox for reminders still scheduled/queued/failed (não recria delivered)
INSERT INTO alert_outbox (
  workspace_id, user_id, source_type, source_id, occurrence_key,
  fire_at, title, payload, status, next_attempt_at, job_idempotency_key
)
SELECT
  r.workspace_id,
  r.user_id,
  'reminder',
  r.id,
  'reminder:' || r.id::text || ':' || to_char(r.fire_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  r.fire_at,
  r.title,
  COALESCE(r.payload, '{}'::jsonb),
  CASE
    WHEN r.status = 'sent' THEN 'delivered'::alert_outbox_status
    WHEN r.status = 'cancelled' THEN 'cancelled'::alert_outbox_status
    ELSE 'pending'::alert_outbox_status
  END,
  CASE
    WHEN r.status IN ('scheduled', 'queued', 'failed') AND r.fire_at <= now() THEN now()
    ELSE r.fire_at
  END,
  'reminder_delivery:' || r.id::text || ':' || to_char(r.fire_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM reminders r
WHERE r.deleted_at IS NULL
ON CONFLICT (occurrence_key) DO NOTHING;
