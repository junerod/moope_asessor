Object.assign(process.env, {
  NODE_ENV: process.env.NODE_ENV || "test",
  APP_ENV: process.env.APP_ENV || "test",
  // NEVER use the app DB — tests truncate tables.
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ||
    "postgres://assessor:assessor@127.0.0.1:54329/moope_assessor_test",
  AUTH_JWT_SECRET:
    process.env.AUTH_JWT_SECRET || "test-jwt-secret-at-least-32-chars-long",
  ENCRYPTION_MASTER_KEY:
    process.env.ENCRYPTION_MASTER_KEY ||
    "test-encryption-master-key-32bytes!!",
  ZERNIO_WEBHOOK_SECRET:
    process.env.ZERNIO_WEBHOOK_SECRET || "test-zernio-webhook-secret",
  ZERNIO_MOCK: process.env.ZERNIO_MOCK || "true",
  AI_PROVIDER: process.env.AI_PROVIDER || "heuristic",
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER || "local",
  LOG_LEVEL: process.env.LOG_LEVEL || "error",
});
