import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { requirePlatformAdminFromAuthHeader } from "@/domain/platform-admin";
import { getHeartbeatStatus, databasePing } from "@/domain/health";
import { getProviderConfig } from "@/domain/providers";
import { getEnv } from "@/config/env";

export async function GET(req: NextRequest) {
  const db = getDb();
  try {
    await requirePlatformAdminFromAuthHeader(
      db,
      req.headers.get("authorization")
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json(
      { error: msg },
      { status: msg === "forbidden" ? 403 : 401 }
    );
  }

  await databasePing(db);
  const counts = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS users,
      (SELECT count(*)::int FROM workspaces WHERE deleted_at IS NULL) AS workspaces,
      (SELECT count(*)::int FROM messages WHERE created_at::date = CURRENT_DATE) AS messages_today,
      (SELECT count(*)::int FROM agent_runs WHERE created_at::date = CURRENT_DATE) AS agent_runs_today,
      (SELECT count(*)::int FROM agent_jobs WHERE status IN ('pending','retry')) AS jobs_pending,
      (SELECT count(*)::int FROM agent_jobs WHERE status = 'failed' OR dead_at IS NOT NULL) AS jobs_failed,
      (SELECT count(*)::int FROM reminders WHERE status = 'scheduled') AS reminders_pending,
      (SELECT count(*)::int FROM documents WHERE status = 'indexed') AS documents_processed
  `);
  const row = (
    Array.isArray(counts)
      ? counts[0]
      : (counts as { rows?: unknown[] })?.rows?.[0] || counts
  ) as Record<string, number>;

  const metrics = {
    users: Number(row?.users ?? 0),
    workspaces: Number(row?.workspaces ?? 0),
    messages_today: Number(row?.messages_today ?? 0),
    agent_runs_today: Number(row?.agent_runs_today ?? 0),
    jobs_pending: Number(row?.jobs_pending ?? 0),
    jobs_failed: Number(row?.jobs_failed ?? 0),
    reminders_pending: Number(row?.reminders_pending ?? 0),
    documents_processed: Number(row?.documents_processed ?? 0),
  };

  const worker = await getHeartbeatStatus(db, "worker");
  const scheduler = await getHeartbeatStatus(db, "scheduler");
  const zernio = await getProviderConfig(db, "zernio");
  const llm = await getProviderConfig(db, "openai_llm");
  const emb = await getProviderConfig(db, "openai_embeddings");
  const email = await getProviderConfig(db, "email");
  const env = getEnv();

  const { resolveProviderSecret } = await import("@/domain/providers");
  const zernioSecret = await resolveProviderSecret(db, "zernio", "api_key");
  const openaiSecret = await resolveProviderSecret(db, "openai_llm", "api_key");
  const emailSecret = await resolveProviderSecret(db, "email", "api_key");

  return NextResponse.json({
    metrics,
    status: {
      database: "ONLINE",
      worker: worker.status,
      scheduler: scheduler.status,
      zernio: mapProviderStatus(
        preferLiveStatus(zernio?.lastTestStatus, Boolean(zernioSecret)),
        zernio?.enabled ?? Boolean(zernioSecret)
      ),
      llm: mapProviderStatus(
        preferLiveStatus(llm?.lastTestStatus, Boolean(openaiSecret)),
        llm?.enabled ?? Boolean(openaiSecret)
      ),
      embeddings: mapProviderStatus(
        preferLiveStatus(emb?.lastTestStatus, Boolean(openaiSecret)),
        emb?.enabled ?? Boolean(openaiSecret)
      ),
      email: mapProviderStatus(
        preferLiveStatus(
          email?.lastTestStatus,
          Boolean(emailSecret || env.MAILSERVER_API_KEY)
        ),
        email?.enabled ?? Boolean(emailSecret || env.MAILSERVER_API_KEY)
      ),
    },
    heartbeats: { worker, scheduler },
    webhook_url: `${env.APP_BASE_URL}/api/webhooks/zernio`,
    bootstrap: {
      zernio_from_env: Boolean(env.ZERNIO_API_KEY),
      openai_from_env: Boolean(env.OPENAI_API_KEY),
      email_from_env: Boolean(env.MAILSERVER_API_KEY),
    },
    checklist: {
      metrics_source: "postgres_live",
      providers_storage: "encrypted_secrets + provider_configs (+ env bootstrap)",
      zernio_configured: Boolean(zernioSecret),
      openai_configured: Boolean(openaiSecret),
      email_configured: Boolean(emailSecret || env.MAILSERVER_API_KEY),
    },
  });
}

function preferLiveStatus(
  status: string | null | undefined,
  hasSecret: boolean
) {
  if (status === "connected") return "connected";
  if (hasSecret && (!status || status === "never" || status === "not_configured")) {
    return "env_bootstrap";
  }
  return status || (hasSecret ? "env_bootstrap" : null);
}

function mapProviderStatus(
  status: string | null | undefined,
  enabled?: boolean
) {
  if (status === "connected") return "CONNECTED";
  if (status === "env_bootstrap") return "CONNECTED (ENV)";
  if (!enabled && (!status || status === "never")) return "NOT_CONFIGURED";
  if (status === "not_configured" || status === "never") return "NOT_CONFIGURED";
  return "ERROR";
}
