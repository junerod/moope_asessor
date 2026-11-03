import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { providerConfigs, whatsappTemplates } from "@/db/schema";
import { secretStore } from "@/lib/secrets/store";
import { getEnv, isProductionEnv } from "@/config/env";
import { logger } from "@/lib/logger";

export type ProviderKey =
  | "zernio"
  | "openai_llm"
  | "openai_embeddings"
  | "vision"
  | "transcription"
  | "email"
  | "google_oauth";

const SECRET_FIELDS: Record<ProviderKey, string[]> = {
  zernio: ["api_key", "webhook_secret"],
  openai_llm: ["api_key"],
  openai_embeddings: ["api_key"],
  vision: ["api_key"],
  transcription: ["api_key"],
  email: ["password", "api_key"],
  google_oauth: ["client_id", "client_secret"],
};

function secretRef(providerKey: ProviderKey, field: string) {
  return `provider:${providerKey}:${field}`;
}

export async function getProviderConfig(db: Db, providerKey: ProviderKey) {
  return (
    (await db.query.providerConfigs.findFirst({
      where: eq(providerConfigs.providerKey, providerKey),
    })) ?? null
  );
}

export async function upsertProviderConfig(
  db: Db,
  input: {
    providerKey: ProviderKey;
    enabled: boolean;
    providerName: string;
    config: Record<string, unknown>;
    secrets?: Record<string, string | undefined>;
    updatedByUserId: string;
  }
) {
  const secretRefs: Record<string, string> = {};
  const allowed = SECRET_FIELDS[input.providerKey] || [];
  for (const field of allowed) {
    const value = input.secrets?.[field];
    if (value && value.trim() && !/^•+$/.test(value)) {
      const key = secretRef(input.providerKey, field);
      await secretStore.setSecret(db, key, value.trim());
      secretRefs[field] = key;
    }
  }

  const existing = await getProviderConfig(db, input.providerKey);
  // Preserve previous secret refs if not rotated
  const mergedRefs = {
    ...((existing?.secretRefs as Record<string, string>) || {}),
    ...secretRefs,
  };

  if (existing) {
    const [row] = await db
      .update(providerConfigs)
      .set({
        enabled: input.enabled,
        providerName: input.providerName,
        configJson: input.config,
        secretRefs: mergedRefs,
        updatedByUserId: input.updatedByUserId,
        updatedAt: new Date(),
      })
      .where(eq(providerConfigs.providerKey, input.providerKey))
      .returning();
    return row;
  }

  const [row] = await db
    .insert(providerConfigs)
    .values({
      providerKey: input.providerKey,
      enabled: input.enabled,
      providerName: input.providerName,
      configJson: input.config,
      secretRefs: mergedRefs,
      updatedByUserId: input.updatedByUserId,
    })
    .returning();
  return row;
}

export function maskProviderConfig(row: typeof providerConfigs.$inferSelect | null) {
  if (!row) return null;
  const refs = (row.secretRefs || {}) as Record<string, string>;
  const secretsMasked: Record<string, string> = {};
  for (const field of Object.keys(refs)) {
    secretsMasked[field] = "••••••••••";
  }
  return {
    provider_key: row.providerKey,
    enabled: row.enabled,
    provider_name: row.providerName,
    config: row.configJson,
    secrets: secretsMasked,
    has_secrets: Object.keys(refs),
    last_tested_at: row.lastTestedAt,
    last_test_status: row.lastTestStatus,
    last_error_code: row.lastErrorCode,
    source: "db" as const,
  };
}

/** Admin view: DB row + env bootstrap (never returns plaintext secrets). */
export async function listProvidersForAdmin(db: Db) {
  const env = getEnv();
  const out: Array<Record<string, unknown>> = [];

  for (const key of Object.keys(SECRET_FIELDS) as ProviderKey[]) {
    const row = await getProviderConfig(db, key);
    const masked = maskProviderConfig(row);
    const envKey =
      key === "zernio"
        ? Boolean(env.ZERNIO_API_KEY)
        : key === "email"
          ? Boolean(env.MAILSERVER_API_KEY)
          : Boolean(env.OPENAI_API_KEY);

    if (masked) {
      out.push({
        ...masked,
        has_env_fallback: envKey,
        has_usable_key:
          Boolean(masked.secrets && Object.keys(masked.secrets as object).length) ||
          envKey,
      });
    } else if (envKey) {
      out.push({
        provider_key: key,
        enabled: true,
        provider_name: key.startsWith("openai") || key === "vision" || key === "transcription"
          ? "openai"
          : key === "email"
            ? "mailserver"
            : "zernio",
        config: key === "zernio"
          ? {
              api_url: env.ZERNIO_API_URL,
              account_id: env.ZERNIO_ACCOUNT_ID || "",
            }
          : key === "email"
            ? {
                provider: "mailserver",
                base_url: env.MAILSERVER_URL || "https://mailserver.moope.com.br",
                from_address: env.MAILSERVER_FROM || "",
              }
            : {},
        secrets: { api_key: "••••••••••" },
        has_secrets: ["api_key"],
        last_tested_at: null,
        last_test_status: "env_bootstrap",
        last_error_code: null,
        source: "env",
        has_env_fallback: true,
        has_usable_key: true,
      });
    }
  }

  return out;
}

export async function resolveProviderSecret(
  db: Db,
  providerKey: ProviderKey,
  field: string
): Promise<string | null> {
  const env = getEnv();
  const envFallback = (): string | null => {
    if (providerKey === "zernio" && field === "api_key") return env.ZERNIO_API_KEY || null;
    if (providerKey === "zernio" && field === "webhook_secret")
      return env.ZERNIO_WEBHOOK_SECRET || null;
    if (
      (providerKey === "openai_llm" ||
        providerKey === "openai_embeddings" ||
        providerKey === "vision" ||
        providerKey === "transcription") &&
      field === "api_key"
    ) {
      return env.OPENAI_API_KEY || null;
    }
    if (providerKey === "email" && field === "api_key") {
      return env.MAILSERVER_API_KEY || null;
    }
    return null;
  };

  try {
    const row = await getProviderConfig(db, providerKey);
    const ref = (row?.secretRefs as Record<string, string> | undefined)?.[field];
    if (ref) {
      try {
        const fromDb = await secretStore.getSecret(db, ref);
        if (fromDb) return fromDb;
      } catch (err) {
        logger.warn("provider_secret_decrypt_failed_env_fallback", {
          provider: providerKey,
          field,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.warn("provider_secret_resolve_failed_env_fallback", {
      provider: providerKey,
      field,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return envFallback();
}

export async function resolveZernioRuntimeConfig(db: Db) {
  const row = await getProviderConfig(db, "zernio");
  const env = getEnv();
  const apiKey =
    (await resolveProviderSecret(db, "zernio", "api_key")) || env.ZERNIO_API_KEY;
  const webhookSecret =
    (await resolveProviderSecret(db, "zernio", "webhook_secret")) ||
    env.ZERNIO_WEBHOOK_SECRET;
  const config = (row?.configJson || {}) as Record<string, unknown>;

  // Prefer active ASSISTANT channel over stale config/env
  const { getActiveAssistantChannel } = await import("@/domain/whatsapp-channels");
  const assistant = await getActiveAssistantChannel(db);
  const accountId = String(
    assistant?.providerAccountId ||
      config.account_id ||
      env.ZERNIO_ACCOUNT_ID ||
      ""
  );
  const officialNumber = String(
    assistant?.phoneE164 || config.official_number || ""
  );

  const dbConfigured = Boolean(row?.enabled && apiKey && accountId);

  return {
    enabled: row?.enabled ?? Boolean(apiKey && accountId),
    apiUrl: String(config.api_url || env.ZERNIO_API_URL),
    accountId,
    officialNumber,
    apiKey: apiKey || "",
    webhookSecret,
    assistantChannelId: assistant?.id ?? null,
    // DB configured wins: never silent mock when credentials+assistant exist
    mock: dbConfigured
      ? false
      : Boolean(env.ZERNIO_MOCK) ||
        !apiKey ||
        !accountId ||
        row?.enabled === false,
  };
}

export async function testZernioConnection(db: Db) {
  const cfg = await resolveZernioRuntimeConfig(db);
  if (!cfg.apiKey) {
    await setProviderTestResult(db, "zernio", "not_configured", "missing_credentials");
    return { status: "not_configured" as const };
  }
  try {
    const { fetchZernioWhatsappNumbers } = await import("@/channels/zernio/accounts");
    const listed = await fetchZernioWhatsappNumbers({
      apiKey: cfg.apiKey,
      apiUrl: cfg.apiUrl,
      timeoutMs: getEnv().ZERNIO_TIMEOUT_MS,
    });
    if (!listed.ok) {
      const status =
        listed.errorCode === "invalid_credentials"
          ? "invalid_credentials"
          : listed.errorCode === "timeout"
            ? "timeout"
            : "provider_error";
      await setProviderTestResult(db, "zernio", status, listed.errorCode);
      return { status };
    }
    if (!listed.numbers.length) {
      await setProviderTestResult(db, "zernio", "provider_error", "no_whatsapp");
      return { status: "provider_error" as const, numbers: [] };
    }
    await setProviderTestResult(db, "zernio", "connected", null);
    return {
      status: "connected" as const,
      numbers: listed.numbers,
      selected_account_id: cfg.accountId || null,
      official_number: cfg.officialNumber || null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    const status = /abort|timeout/i.test(msg) ? "timeout" : "provider_error";
    await setProviderTestResult(db, "zernio", status, status);
    return { status };
  }
}

export async function testOpenAIConnection(db: Db, providerKey: ProviderKey = "openai_llm") {
  const apiKey = await resolveProviderSecret(db, providerKey, "api_key");
  if (!apiKey) {
    await setProviderTestResult(db, providerKey, "not_configured", "missing_key");
    return { status: "not_configured" as const };
  }
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) {
      await setProviderTestResult(db, providerKey, "invalid_credentials", "http_401");
      return { status: "invalid_credentials" as const };
    }
    if (!res.ok) {
      await setProviderTestResult(db, providerKey, "provider_error", `http_${res.status}`);
      return { status: "provider_error" as const };
    }
    await setProviderTestResult(db, providerKey, "connected", null);
    return { status: "connected" as const };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    const status = /abort|timeout/i.test(msg) ? "timeout" : "provider_error";
    await setProviderTestResult(db, providerKey, status, status);
    return { status };
  }
}

async function setProviderTestResult(
  db: Db,
  providerKey: ProviderKey,
  status:
    | "connected"
    | "invalid_credentials"
    | "timeout"
    | "provider_error"
    | "not_configured",
  errorCode: string | null
) {
  const existing = await getProviderConfig(db, providerKey);
  if (!existing) {
    await db.insert(providerConfigs).values({
      providerKey,
      enabled: false,
      providerName: providerKey,
      lastTestedAt: new Date(),
      lastTestStatus: status,
      lastErrorCode: errorCode,
    });
    return;
  }
  await db
    .update(providerConfigs)
    .set({
      lastTestedAt: new Date(),
      lastTestStatus: status,
      lastErrorCode: errorCode,
      updatedAt: new Date(),
    })
    .where(eq(providerConfigs.providerKey, providerKey));
}

export async function setProviderTestResultPublic(
  db: Db,
  providerKey: ProviderKey,
  status:
    | "connected"
    | "invalid_credentials"
    | "timeout"
    | "provider_error"
    | "not_configured",
  errorCode: string | null
) {
  return setProviderTestResult(db, providerKey, status, errorCode);
}

export async function getTemplate(db: Db, logicalName: string) {
  return db.query.whatsappTemplates.findFirst({
    where: eq(whatsappTemplates.logicalName, logicalName),
  });
}

export function assertAiProviderAllowed() {
  if (isProductionEnv()) {
    const env = getEnv();
    if (env.AI_PROVIDER === "heuristic") {
      throw new Error("AI_PROVIDER_UNAVAILABLE");
    }
  }
}
