-- MOOPE Meu Assessor — Fase 1 foundation schema
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('pending_verification', 'active', 'suspended', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE workspace_type AS ENUM ('personal', 'organization');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE workspace_member_role AS ENUM ('owner', 'admin', 'member', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE whatsapp_identity_status AS ENUM ('unpaired', 'pending_verification', 'paired', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE conversation_status AS ENUM ('onboarding', 'active', 'paused', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE message_status AS ENUM ('received', 'queued', 'sent', 'delivered', 'read', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_status AS ENUM ('pending', 'stored', 'processing', 'indexed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE memory_status AS ENUM ('active', 'archived', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('open', 'in_progress', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE appointment_status AS ENUM ('scheduled', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE reminder_status AS ENUM ('scheduled', 'queued', 'sent', 'cancelled', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agent_job_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'retry');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agent_run_status AS ENUM ('running', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tool_call_status AS ENUM ('pending', 'allowed', 'denied', 'awaiting_confirmation', 'succeeded', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE policy_decision AS ENUM ('ALLOW', 'DENY', 'REQUIRE_CONFIRMATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE webhook_event_status AS ENUM ('received', 'processed', 'ignored', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE integration_provider AS ENUM (
    'open_finance', 'google_calendar', 'gmail', 'google_drive',
    'moope_crm', 'moope_frotas', 'asaas', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE integration_connection_status AS ENUM (
    'disconnected', 'connecting', 'connected', 'error', 'revoked'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE onboarding_step AS ENUM (
    'awaiting_name', 'awaiting_email', 'awaiting_verification', 'awaiting_terms', 'completed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_user_id uuid,
  email varchar(320) NOT NULL,
  email_verified_at timestamptz,
  name varchar(200) NOT NULL,
  password_hash text,
  status user_status NOT NULL DEFAULT 'pending_verification',
  timezone varchar(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_global_user_id_uidx ON users (global_user_id) WHERE global_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type workspace_type NOT NULL DEFAULT 'personal',
  name varchar(200) NOT NULL,
  timezone varchar(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces (owner_user_id);
CREATE INDEX IF NOT EXISTS workspaces_type_idx ON workspaces (type);

CREATE TABLE IF NOT EXISTS workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role workspace_member_role NOT NULL DEFAULT 'member',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_workspace_user_uidx ON workspace_members (workspace_id, user_id);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);

CREATE TABLE IF NOT EXISTS whatsapp_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  phone_e164 varchar(32),
  bsuid varchar(128),
  display_name varchar(200),
  status whatsapp_identity_status NOT NULL DEFAULT 'unpaired',
  paired_at timestamptz,
  verification_code_hash text,
  verification_expires_at timestamptz,
  verification_attempts integer NOT NULL DEFAULT 0,
  last_seen_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_identities_phone_or_bsuid_chk CHECK (phone_e164 IS NOT NULL OR bsuid IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_identities_phone_uidx
  ON whatsapp_identities (phone_e164)
  WHERE phone_e164 IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_identities_bsuid_uidx
  ON whatsapp_identities (bsuid)
  WHERE bsuid IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS whatsapp_identities_user_idx ON whatsapp_identities (user_id);
CREATE INDEX IF NOT EXISTS whatsapp_identities_status_idx ON whatsapp_identities (status);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  whatsapp_identity_id uuid NOT NULL REFERENCES whatsapp_identities(id) ON DELETE RESTRICT,
  channel varchar(32) NOT NULL DEFAULT 'whatsapp',
  external_conversation_id varchar(128),
  status conversation_status NOT NULL DEFAULT 'onboarding',
  onboarding_step onboarding_step NOT NULL DEFAULT 'awaiting_name',
  last_message_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_workspace_idx ON conversations (workspace_id);
CREATE INDEX IF NOT EXISTS conversations_identity_idx ON conversations (whatsapp_identity_id);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_external_uidx
  ON conversations (external_conversation_id)
  WHERE external_conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  direction message_direction NOT NULL,
  status message_status NOT NULL DEFAULT 'received',
  external_message_id varchar(128),
  body_text text,
  content_type varchar(64) NOT NULL DEFAULT 'text',
  media_storage_key text,
  raw_payload jsonb,
  correlation_id varchar(64),
  sent_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS messages_workspace_idx ON messages (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_external_uidx
  ON messages (external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  original_filename varchar(512),
  mime_type varchar(128),
  size_bytes integer,
  sha256 varchar(64),
  storage_key text NOT NULL,
  source varchar(64) NOT NULL DEFAULT 'whatsapp',
  status document_status NOT NULL DEFAULT 'pending',
  classification varchar(64),
  metadata jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_workspace_idx ON documents (workspace_id);
CREATE INDEX IF NOT EXISTS documents_sha256_idx ON documents (sha256);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status);

CREATE TABLE IF NOT EXISTS document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  embedding vector(1536),
  embedding_model varchar(64) DEFAULT 'text-embedding-3-small',
  metadata jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_chunks_workspace_idx ON document_chunks (workspace_id);
CREATE INDEX IF NOT EXISTS document_chunks_document_idx ON document_chunks (document_id);
CREATE UNIQUE INDEX IF NOT EXISTS document_chunks_doc_index_uidx ON document_chunks (document_id, chunk_index);

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  content text NOT NULL,
  embedding vector(1536),
  embedding_model varchar(64) DEFAULT 'text-embedding-3-small',
  status memory_status NOT NULL DEFAULT 'active',
  metadata jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_workspace_idx ON memories (workspace_id);
CREATE INDEX IF NOT EXISTS memories_status_idx ON memories (status);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title varchar(500) NOT NULL,
  description text,
  status task_status NOT NULL DEFAULT 'open',
  due_at timestamptz,
  completed_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_workspace_idx ON tasks (workspace_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);

CREATE TABLE IF NOT EXISTS appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title varchar(500) NOT NULL,
  description text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  timezone varchar(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  status appointment_status NOT NULL DEFAULT 'scheduled',
  location varchar(500),
  metadata jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointments_workspace_idx ON appointments (workspace_id);
CREATE INDEX IF NOT EXISTS appointments_starts_at_idx ON appointments (starts_at);

CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title varchar(500) NOT NULL,
  fire_at timestamptz NOT NULL,
  timezone varchar(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  status reminder_status NOT NULL DEFAULT 'scheduled',
  delivery_channel varchar(32) NOT NULL DEFAULT 'whatsapp',
  requires_template boolean NOT NULL DEFAULT false,
  template_name varchar(128),
  recurrence_rule varchar(256),
  payload jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_workspace_idx ON reminders (workspace_id);
CREATE INDEX IF NOT EXISTS reminders_fire_at_status_idx ON reminders (fire_at, status);
CREATE INDEX IF NOT EXISTS reminders_user_idx ON reminders (user_id);

CREATE TABLE IF NOT EXISTS agent_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  webhook_event_id uuid,
  job_type varchar(64) NOT NULL,
  status agent_job_status NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(128),
  last_error text,
  idempotency_key varchar(191),
  correlation_id varchar(64),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_idempotency_uidx
  ON agent_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_jobs_poll_idx ON agent_jobs (status, available_at);
CREATE INDEX IF NOT EXISTS agent_jobs_workspace_idx ON agent_jobs (workspace_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status agent_run_status NOT NULL DEFAULT 'running',
  model varchar(128),
  input_summary text,
  output_summary text,
  error text,
  correlation_id varchar(64),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_job_idx ON agent_runs (job_id);
CREATE INDEX IF NOT EXISTS agent_runs_workspace_idx ON agent_runs (workspace_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  tool_name varchar(128) NOT NULL,
  policy_decision policy_decision NOT NULL,
  status tool_call_status NOT NULL DEFAULT 'pending',
  args jsonb DEFAULT '{}'::jsonb,
  result_summary text,
  error text,
  correlation_id varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_calls_run_idx ON tool_calls (agent_run_id);
CREATE INDEX IF NOT EXISTS tool_calls_workspace_idx ON tool_calls (workspace_id);
CREATE INDEX IF NOT EXISTS tool_calls_tool_name_idx ON tool_calls (tool_name);

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(64) NOT NULL DEFAULT 'zernio',
  external_event_id varchar(191) NOT NULL,
  event_type varchar(128) NOT NULL,
  status webhook_event_status NOT NULL DEFAULT 'received',
  signature_valid boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  headers jsonb DEFAULT '{}'::jsonb,
  correlation_id varchar(64),
  processed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_provider_external_uidx
  ON webhook_events (provider, external_event_id);
CREATE INDEX IF NOT EXISTS webhook_events_type_idx ON webhook_events (event_type);

CREATE TABLE IF NOT EXISTS integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider integration_provider NOT NULL,
  status integration_connection_status NOT NULL DEFAULT 'disconnected',
  display_name varchar(200),
  credentials_ref text,
  scopes jsonb DEFAULT '[]'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  connected_at timestamptz,
  last_synced_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_workspace_provider_uidx
  ON integration_connections (workspace_id, provider);
CREATE INDEX IF NOT EXISTS integration_connections_status_idx ON integration_connections (status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action varchar(128) NOT NULL,
  resource_type varchar(64),
  resource_id uuid,
  correlation_id varchar(64),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_workspace_idx ON audit_logs (workspace_id);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
