-- Página visual (token) enviada no WhatsApp. Idempotente.

CREATE TABLE IF NOT EXISTS visual_boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token varchar(64) NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS visual_boards_token_uidx
  ON visual_boards (token);

CREATE INDEX IF NOT EXISTS visual_boards_expires_idx
  ON visual_boards (expires_at);
