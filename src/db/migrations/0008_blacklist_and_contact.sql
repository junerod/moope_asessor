-- Blacklist de telefones (banimento operacional; regras avançadas depois)
-- Contato comercial/suporte do Assessor (configurável no Admin)

CREATE TABLE IF NOT EXISTS client_access_blacklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 varchar(32) NOT NULL,
  phone_digits varchar(32) NOT NULL,
  reason varchar(500),
  notes text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS client_access_blacklist_digits_uidx
  ON client_access_blacklist (phone_digits)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS client_access_blacklist_phone_idx
  ON client_access_blacklist (phone_e164)
  WHERE deleted_at IS NULL;

INSERT INTO platform_settings (id, namespace, key, value_json, created_at, updated_at)
SELECT gen_random_uuid(), 'assessor', 'moope_contact',
  '{"phone_e164":"","label":"Comercial / suporte MOOPE"}'::jsonb,
  now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM platform_settings WHERE namespace = 'assessor' AND key = 'moope_contact'
);
