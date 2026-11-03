-- Platform knowledge base for MOOPE RAG (products, pricing pointers, FAQ)
CREATE TABLE IF NOT EXISTS platform_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(128) NOT NULL,
  title varchar(300) NOT NULL,
  category varchar(64) NOT NULL DEFAULT 'geral',
  content text NOT NULL,
  source_url varchar(500),
  embedding vector(1536),
  embedding_model varchar(64) DEFAULT 'text-embedding-3-small',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(32) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_knowledge_slug_uidx
  ON platform_knowledge (slug);
CREATE INDEX IF NOT EXISTS platform_knowledge_category_idx
  ON platform_knowledge (category);
CREATE INDEX IF NOT EXISTS platform_knowledge_status_idx
  ON platform_knowledge (status);
