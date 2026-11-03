-- Whitelist de telefones com acesso livre (homolog / VIP / sem cobrança)

CREATE TABLE IF NOT EXISTS client_access_whitelist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 varchar(32) NOT NULL,
  phone_digits varchar(32) NOT NULL,
  label varchar(200),
  notes text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS client_access_whitelist_digits_uidx
  ON client_access_whitelist (phone_digits)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS client_access_whitelist_phone_idx
  ON client_access_whitelist (phone_e164)
  WHERE deleted_at IS NULL;

-- Flag operacional: quando true, só trialing/active/comped/whitelist passam
INSERT INTO platform_settings (id, namespace, key, value_json, created_at, updated_at)
SELECT gen_random_uuid(), 'billing', 'paywall_enforced', '{"enabled": false}'::jsonb, now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM platform_settings WHERE namespace = 'billing' AND key = 'paywall_enforced'
);
