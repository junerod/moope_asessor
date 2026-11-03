-- Contexto empresarial ativo por WhatsApp (locadora / Facejus).
-- Pessoal NÃO entra aqui — sempre disponível em paralelo.

CREATE TABLE IF NOT EXISTS whatsapp_business_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_digits varchar(32) NOT NULL,
  phone_e164 varchar(32) NOT NULL,
  kind varchar(32) NOT NULL,
  tenant_id integer NOT NULL,
  label varchar(200) NOT NULL,
  papel varchar(64),
  meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_business_context_phone_uidx
  ON whatsapp_business_context (phone_digits);
