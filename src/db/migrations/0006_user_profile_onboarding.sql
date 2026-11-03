-- Perfil de cadastro WhatsApp + passos de onboarding

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS cpf_cnpj varchar(18),
  ADD COLUMN IF NOT EXISTS cep varchar(16),
  ADD COLUMN IF NOT EXISTS full_name varchar(200),
  ADD COLUMN IF NOT EXISTS usage_type varchar(32),
  ADD COLUMN IF NOT EXISTS business_type varchar(64),
  ADD COLUMN IF NOT EXISTS profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS address_json jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TYPE onboarding_step ADD VALUE IF NOT EXISTS 'awaiting_usage_type';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE onboarding_step ADD VALUE IF NOT EXISTS 'awaiting_business_type';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE onboarding_step ADD VALUE IF NOT EXISTS 'awaiting_full_name';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE onboarding_step ADD VALUE IF NOT EXISTS 'awaiting_cpf';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE onboarding_step ADD VALUE IF NOT EXISTS 'awaiting_cep';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
