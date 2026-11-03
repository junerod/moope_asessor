import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  APP_NAME: z.string().default("moope-assessor"),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://assessor:assessor@127.0.0.1:54329/moope_assessor"),
  AUTH_JWT_SECRET: z
    .string()
    .min(16)
    .default("dev-only-change-me-use-32chars-min-secret"),
  AUTH_JWT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  ENCRYPTION_MASTER_KEY: z
    .string()
    .min(32)
    .default("dev-only-encryption-master-key-32b!"),
  DEFAULT_TIMEZONE: z.string().default("America/Sao_Paulo"),
  TERMS_VERSION: z.string().default("2026-10-22"),
  PRIVACY_VERSION: z.string().default("2026-09-19"),
  ZERNIO_MOCK: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  ZERNIO_API_URL: z.string().default("https://zernio.com/api/v1"),
  ZERNIO_API_KEY: z.string().optional().default(""),
  ZERNIO_ACCOUNT_ID: z.string().optional().default(""),
  ZERNIO_WEBHOOK_SECRET: z.string().min(8),
  ZERNIO_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  ZERNIO_REMINDER_TEMPLATE: z.string().default("assessor_reminder"),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(500),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(5),
  SCHEDULER_POLL_MS: z.coerce.number().int().positive().default(5000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  AI_PROVIDER: z.enum(["openai", "heuristic"]).default("heuristic"),
  EMBEDDING_PROVIDER: z.enum(["openai", "local"]).default("local"),
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  STORAGE_ROOT: z.string().default(".data/storage"),
  STORAGE_DRIVER: z.enum(["local", "r2"]).default("local"),
  R2_ENDPOINT: z.string().optional().default(""),
  R2_BUCKET: z.string().optional().default(""),
  R2_ACCESS_KEY_ID: z.string().optional().default(""),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(""),
  R2_PUBLIC_BASE_URL: z.string().optional().default(""),
  R2_REGION: z.string().optional().default("auto"),
  EMAIL_PROVIDER: z.enum(["mock", "smtp", "mailserver"]).default("mock"),
  MAILSERVER_URL: z.string().optional().default(""),
  MAILSERVER_API_KEY: z.string().optional().default(""),
  MAILSERVER_FROM: z.string().optional().default("info@info.moope.com.br"),
  MAX_DOCUMENT_SIZE_BYTES: z.coerce.number().int().positive().default(15_000_000),
  MAX_IMAGE_SIZE_BYTES: z.coerce.number().int().positive().default(8_000_000),
  MAX_AUDIO_SIZE_BYTES: z.coerce.number().int().positive().default(10_000_000),
  HEARTBEAT_STALE_SECONDS: z.coerce.number().int().positive().default(30),
  /** Anti-abuso: liberados (whitelist) não têm teto. Trial/avaliação usa os *_TRIAL_*. */
  RATE_LIMIT_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(8),
  RATE_LIMIT_MESSAGES_PER_DAY: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_TRIAL_MESSAGES_PER_DAY: z.coerce
    .number()
    .int()
    .positive()
    .default(20),
  RATE_LIMIT_INPUT_TOKENS_PER_DAY: z.coerce
    .number()
    .int()
    .positive()
    .default(250_000),
  RATE_LIMIT_TRIAL_INPUT_TOKENS_PER_DAY: z.coerce
    .number()
    .int()
    .positive()
    .default(40_000),
  RATE_LIMIT_MAX_MESSAGE_CHARS: z.coerce.number().int().positive().default(4000),
  RATE_LIMIT_MAX_SCHEDULED_REMINDERS: z.coerce
    .number()
    .int()
    .positive()
    .default(40),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(900),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  MOOPE_FINANCE_API_URL: z.string().optional().default("https://frotas.moope.com.br"),
  MOOPE_FINANCE_ASSESSOR_SECRET: z.string().optional().default(""),
  FACEJUS_API_URL: z.string().optional().default("https://web.facejus.com.br"),
  FACEJUS_ASSESSOR_SECRET: z.string().optional().default(""),
  GOOGLE_REDIRECT_URI: z.string().optional().default(""),
  GOOGLE_OAUTH_DEV_MOCK: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  /** WhatsApps (vírgula) só no Assessor pessoal — sem locadora/IoT/Facejus. */
  ASSESSOR_PERSONAL_FOCUS_PHONES: z.string().optional().default(""),
  /** Número público do Assessor (wa.me) — fallback ao canal ASSISTANT no banco. */
  ASSESSOR_WHATSAPP_E164: z.string().optional().default(""),
});
export type Env = z.infer<typeof envSchema> & {
  ZERNIO_MOCK: boolean;
};

let cached: Env | null = null;

/**
 * Shell often exports empty FOO= which blocks Next from applying .env.local.
 * Fill empty keys from .env.local when present.
 */
function mergeEnvLocalFallback(
  source: Record<string, string | undefined>
): Record<string, string | undefined> {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return source;
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!value) continue;
      if (!String(source[key] || "").trim()) {
        source[key] = value;
      }
    }
  } catch {
    /* ignore */
  }
  return source;
}

export function getEnv(overrides?: Partial<Record<string, string>>): Env {
  if (cached && !overrides) return cached;

  const source = mergeEnvLocalFallback({
    ...process.env,
    ...overrides,
  });
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }

  const isProd =
    parsed.data.APP_ENV === "production" || parsed.data.NODE_ENV === "production";

  let aiProvider = parsed.data.AI_PROVIDER;
  let embeddingProvider = parsed.data.EMBEDDING_PROVIDER;

  if (isProd) {
    if (aiProvider === "heuristic") {
      throw new Error("AI_PROVIDER_UNAVAILABLE:heuristic_forbidden_in_production");
    }
    if (!parsed.data.OPENAI_API_KEY && aiProvider === "openai") {
      throw new Error("AI_PROVIDER_UNAVAILABLE:openai_key_missing");
    }
  } else {
    if (aiProvider === "openai" && !parsed.data.OPENAI_API_KEY) {
      aiProvider = "heuristic";
    }
    if (embeddingProvider === "openai" && !parsed.data.OPENAI_API_KEY) {
      embeddingProvider = "local";
    }
  }

  // Prefer explicit false from .env.local over empty-shell forcing mock
  const zernioMockExplicitFalse =
    String(source.ZERNIO_MOCK || "").toLowerCase() === "false" ||
    source.ZERNIO_MOCK === "0";

  // Produção: NUNCA expor localhost em links/webhook base
  let appBaseUrl = parsed.data.APP_BASE_URL.replace(/\/+$/, "");
  if (
    isProd &&
    /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(appBaseUrl)
  ) {
    appBaseUrl = "https://assessor.moope.com.br";
  }

  const env = {
    ...parsed.data,
    APP_BASE_URL: appBaseUrl,
    AI_PROVIDER: aiProvider,
    EMBEDDING_PROVIDER: embeddingProvider,
    ZERNIO_MOCK: zernioMockExplicitFalse
      ? false
      : parsed.data.ZERNIO_MOCK ||
        !parsed.data.ZERNIO_API_KEY ||
        !parsed.data.ZERNIO_ACCOUNT_ID,
    GOOGLE_OAUTH_DEV_MOCK:
      parsed.data.GOOGLE_OAUTH_DEV_MOCK === true ||
      (!isProd && !parsed.data.GOOGLE_CLIENT_ID),
  } as Env;

  if (!overrides) cached = env;
  return env;
}

export function resetEnvCache() {
  cached = null;
}

export function isProductionEnv(env = getEnv()): boolean {
  return env.APP_ENV === "production" || env.NODE_ENV === "production";
}
