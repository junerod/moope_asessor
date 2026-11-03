/**
 * Importa credenciais do moope-finance para o Assessor:
 * - atualiza .env.local (R2, mailserver, OpenAI bootstrap)
 * - grava secrets operacionais no banco (AES-GCM via SecretStore)
 *
 * Uso: npx tsx scripts/import-finance-credentials.ts
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { eq } from "drizzle-orm";
import { getDb, closeDb } from "@/db/client";
import { users } from "@/db/schema";
import { upsertProviderConfig } from "@/domain/providers";
import { resetEnvCache } from "@/config/env";

const FINANCE_ENV =
  process.env.FINANCE_ENV_PATH ||
  "/Users/junerod/meus-moopes/moope-finance/backend/.env";
const LOCAL_ENV = resolve(process.cwd(), ".env.local");

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function upsertEnvLocal(updates: Record<string, string>) {
  const current = parseEnvFile(LOCAL_ENV);
  const merged = { ...current, ...updates };
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  writeFileSync(LOCAL_ENV, lines.join("\n") + "\n", "utf8");
}

async function main() {
  const src = parseEnvFile(FINANCE_ENV);
  if (!Object.keys(src).length) {
    console.error("finance_env_not_found", FINANCE_ENV);
    process.exit(1);
  }

  const envUpdates: Record<string, string> = {};
  const pick = (k: string, as?: string) => {
    if (src[k]) envUpdates[as || k] = src[k];
  };

  pick("OPENAI_API_KEY");
  pick("MAILSERVER_URL");
  pick("MAILSERVER_API_KEY");
  pick("MAILSERVER_FROM");
  pick("MOOPE_MAIL_URL", "MAILSERVER_URL"); // fallback name
  pick("R2_ENDPOINT");
  pick("R2_BUCKET");
  pick("R2_ACCESS_KEY_ID");
  pick("R2_SECRET_ACCESS_KEY");
  pick("R2_PUBLIC_BASE_URL");
  if (src.R2_ENDPOINT) envUpdates.STORAGE_DRIVER = "r2";
  if (src.MAILSERVER_URL || src.MOOPE_MAIL_URL) {
    envUpdates.EMAIL_PROVIDER = "mailserver";
  }
  if (src.OPENAI_API_KEY) {
    envUpdates.AI_PROVIDER = "openai";
    envUpdates.EMBEDDING_PROVIDER = "openai";
  }
  // Keep infra keys if missing
  if (!parseEnvFile(LOCAL_ENV).ENCRYPTION_MASTER_KEY) {
    envUpdates.ENCRYPTION_MASTER_KEY =
      "dev-only-encryption-master-key-32b!";
  }

  upsertEnvLocal(envUpdates);
  Object.assign(process.env, envUpdates);
  resetEnvCache();

  const db = getDb();
  const admin = await db.query.users.findFirst({
    where: eq(users.email, "admin@moope.com.br"),
  });
  const actorId = admin?.id;
  if (!actorId) {
    console.error("admin_user_missing — create admin first");
    await closeDb();
    process.exit(1);
  }

  const imported: string[] = [];

  if (src.OPENAI_API_KEY) {
    for (const key of [
      "openai_llm",
      "openai_embeddings",
      "vision",
      "transcription",
    ] as const) {
      await upsertProviderConfig(db, {
        providerKey: key,
        enabled: true,
        providerName: "openai",
        config:
          key === "openai_embeddings"
            ? { model: "text-embedding-3-small", dimensions: 1536 }
            : key === "openai_llm"
              ? { model: "gpt-4o-mini" }
              : {},
        secrets: { api_key: src.OPENAI_API_KEY },
        updatedByUserId: actorId,
      });
    }
    imported.push("openai(db+env)");
  }

  const mailUrl = src.MAILSERVER_URL || src.MOOPE_MAIL_URL;
  const mailKey = src.MAILSERVER_API_KEY;
  if (mailUrl && mailKey) {
    await upsertProviderConfig(db, {
      providerKey: "email",
      enabled: true,
      providerName: "mailserver",
      config: {
        provider: "mailserver",
        base_url: mailUrl,
        from_address: src.MAILSERVER_FROM || "info@info.moope.com.br",
        from_name: "MOOPE Meu Assessor",
      },
      secrets: { api_key: mailKey },
      updatedByUserId: actorId,
    });
    imported.push("mailserver(db+env)");
  }

  if (src.R2_ENDPOINT) {
    imported.push("r2(env)");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        finance_env: FINANCE_ENV,
        imported,
        note: "Zernio não está no .env do finance (é por conta). Configure no /admin.",
        storage: envUpdates.STORAGE_DRIVER || "local",
        email: envUpdates.EMAIL_PROVIDER || "mock",
      },
      null,
      2
    )
  );
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
