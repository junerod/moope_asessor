-- Fase 2 — Assessor funcional (additive)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS terms_version varchar(64),
  ADD COLUMN IF NOT EXISTS privacy_version varchar(64),
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS type varchar(64) NOT NULL DEFAULT 'note';

CREATE INDEX IF NOT EXISTS memories_workspace_type_idx ON memories (workspace_id, type);

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS provider varchar(64),
  ADD COLUMN IF NOT EXISTS input_tokens integer,
  ADD COLUMN IF NOT EXISTS output_tokens integer,
  ADD COLUMN IF NOT EXISTS latency_ms integer,
  ADD COLUMN IF NOT EXISTS tool_count integer NOT NULL DEFAULT 0;

ALTER TABLE tool_calls
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS error_code varchar(64);

CREATE TABLE IF NOT EXISTS consent_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  terms_version varchar(64) NOT NULL,
  privacy_version varchar(64) NOT NULL,
  channel varchar(32) NOT NULL DEFAULT 'whatsapp',
  accepted_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consent_acceptances_user_idx ON consent_acceptances (user_id);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS appointments_user_idx ON appointments (user_id);

-- HNSW indexes for vector search (workspace-scoped queries still filter workspace_id)
DO $$ BEGIN
  CREATE INDEX document_chunks_embedding_hnsw_idx
    ON document_chunks USING hnsw (embedding vector_cosine_ops);
EXCEPTION WHEN undefined_object OR invalid_parameter_value OR feature_not_supported THEN
  NULL;
WHEN duplicate_table OR duplicate_object THEN
  NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX memories_embedding_hnsw_idx
    ON memories USING hnsw (embedding vector_cosine_ops);
EXCEPTION WHEN undefined_object OR invalid_parameter_value OR feature_not_supported THEN
  NULL;
WHEN duplicate_table OR duplicate_object THEN
  NULL;
END $$;
