-- Uma chave = um envio. Trava duplicata no Zernio/WhatsApp.

CREATE TABLE IF NOT EXISTS outbound_send_keys (
  idempotency_key varchar(191) PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
