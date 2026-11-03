-- Fase 3 — produto real + administração operacional

DO $$ BEGIN
  CREATE TYPE platform_admin_role AS ENUM ('super_admin', 'operator', 'support');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE provider_test_status AS ENUM (
    'never', 'connected', 'invalid_credentials', 'timeout', 'provider_error', 'not_configured'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_status AS ENUM ('active', 'trial', 'suspended', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_status account_status NOT NULL DEFAULT 'active';

ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS dead_at timestamptz;

ALTER TABLE tool_calls
  ADD COLUMN IF NOT EXISTS execution_key varchar(191);

CREATE UNIQUE INDEX IF NOT EXISTS tool_calls_execution_key_uidx
  ON tool_calls (execution_key)
  WHERE execution_key IS NOT NULL;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS source_type varchar(64) DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS source_id uuid,
  ADD COLUMN IF NOT EXISTS document_type varchar(64),
  ADD COLUMN IF NOT EXISTS embedding_provider varchar(64),
  ADD COLUMN IF NOT EXISTS embedding_dimensions integer;

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS embedding_provider varchar(64),
  ADD COLUMN IF NOT EXISTS embedding_dimensions integer;

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS source_type varchar(64) DEFAULT 'conversation',
  ADD COLUMN IF NOT EXISTS source_id uuid,
  ADD COLUMN IF NOT EXISTS embedding_provider varchar(64),
  ADD COLUMN IF NOT EXISTS embedding_dimensions integer;

ALTER TABLE integration_connections
  ADD COLUMN IF NOT EXISTS consent_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS secret_reference text;

CREATE TABLE IF NOT EXISTS platform_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role platform_admin_role NOT NULL DEFAULT 'operator',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_admins_user_uidx
  ON platform_admins (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS encrypted_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(128) NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS encrypted_secrets_key_uidx ON encrypted_secrets (key);

CREATE TABLE IF NOT EXISTS platform_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace varchar(64) NOT NULL,
  key varchar(128) NOT NULL,
  value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_settings_ns_key_uidx
  ON platform_settings (namespace, key);

CREATE TABLE IF NOT EXISTS provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key varchar(64) NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  provider_name varchar(64) NOT NULL,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_tested_at timestamptz,
  last_test_status provider_test_status NOT NULL DEFAULT 'never',
  last_error_code varchar(64),
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_configs_key_uidx ON provider_configs (provider_key);

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logical_name varchar(64) NOT NULL,
  provider_template_name varchar(128) NOT NULL,
  language varchar(16) NOT NULL DEFAULT 'pt_BR',
  status varchar(32) NOT NULL DEFAULT 'draft',
  last_sync_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_logical_uidx ON whatsapp_templates (logical_name);

CREATE TABLE IF NOT EXISTS process_heartbeats (
  process_name varchar(64) PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action varchar(128) NOT NULL,
  resource_type varchar(64),
  resource_id varchar(128),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_logs_actor_idx ON admin_audit_logs (actor_user_id);
CREATE INDEX IF NOT EXISTS admin_audit_logs_action_idx ON admin_audit_logs (action);

CREATE TABLE IF NOT EXISTS plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(64) NOT NULL,
  name varchar(128) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'active',
  limits_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  features_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS plans_code_uidx ON plans (code);

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status varchar(32) NOT NULL DEFAULT 'active',
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  provider varchar(64) NOT NULL DEFAULT 'manual',
  external_subscription_id varchar(191),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_workspace_idx ON subscriptions (workspace_id);

CREATE TABLE IF NOT EXISTS usage_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_key varchar(16) NOT NULL,
  metric varchar(64) NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS usage_counters_ws_period_metric_uidx
  ON usage_counters (workspace_id, period_key, metric);

INSERT INTO whatsapp_templates (logical_name, provider_template_name, language, status)
VALUES
  ('verification', 'assessor_verification', 'pt_BR', 'draft'),
  ('reminder', 'assessor_reminder', 'pt_BR', 'draft'),
  ('notification', 'assessor_notification', 'pt_BR', 'draft')
ON CONFLICT (logical_name) DO NOTHING;

INSERT INTO plans (code, name, status, limits_json, features_json)
VALUES
  ('individual', 'Individual', 'active', '{"messages":1000}'::jsonb, '{"whatsapp":true}'::jsonb),
  ('pro', 'Pro', 'active', '{"messages":10000}'::jsonb, '{"whatsapp":true,"vision":true}'::jsonb),
  ('business', 'Business', 'active', '{"messages":100000}'::jsonb, '{"whatsapp":true,"vision":true,"integrations":true}'::jsonb)
ON CONFLICT (code) DO NOTHING;
