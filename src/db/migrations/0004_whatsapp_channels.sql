-- Fase 3 ajuste — canais WhatsApp multi-número + vínculo conversation

DO $$ BEGIN
  CREATE TYPE whatsapp_channel_purpose AS ENUM ('ASSISTANT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE whatsapp_channel_status AS ENUM ('online', 'offline', 'unknown', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS whatsapp_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(32) NOT NULL DEFAULT 'zernio',
  provider_account_id varchar(64) NOT NULL,
  provider_number_id varchar(64),
  phone_e164 varchar(32),
  display_name varchar(200),
  status whatsapp_channel_status NOT NULL DEFAULT 'unknown',
  purpose whatsapp_channel_purpose NOT NULL DEFAULT 'OTHER',
  is_active boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_channels_provider_account_uidx
  ON whatsapp_channels (provider, provider_account_id);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_channels_one_assistant_uidx
  ON whatsapp_channels (purpose)
  WHERE purpose = 'ASSISTANT' AND is_active = true;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_channel_id uuid REFERENCES whatsapp_channels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conversations_channel_idx
  ON conversations (whatsapp_channel_id);

-- subscription statuses already varchar; document expected values in app layer
