import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  requirePlatformAdminFromAuthHeader,
  writeAdminAudit,
} from "@/domain/platform-admin";
import {
  resolveProviderSecret,
  resolveZernioRuntimeConfig,
  upsertProviderConfig,
} from "@/domain/providers";
import {
  ensureAssessorWebhook,
  listZernioWebhooks,
  isPublicWebhookUrl,
} from "@/channels/zernio/webhooks";
import { getEnv } from "@/config/env";
import { randomToken } from "@/lib/crypto";

async function requireAdmin(req: NextRequest) {
  const db = getDb();
  return requirePlatformAdminFromAuthHeader(
    db,
    req.headers.get("authorization")
  );
}

export async function GET(req: NextRequest) {
  const db = getDb();
  let actor;
  try {
    actor = await requireAdmin(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json(
      { error: msg },
      { status: msg === "forbidden" ? 403 : 401 }
    );
  }
  void actor;

  const cfg = await resolveZernioRuntimeConfig(db);
  const apiKey =
    (await resolveProviderSecret(db, "zernio", "api_key")) || cfg.apiKey;
  if (!apiKey) {
    return NextResponse.json(
      { error: "missing_api_key", webhooks: [] },
      { status: 400 }
    );
  }

  const listed = await listZernioWebhooks({
    apiKey,
    apiUrl: cfg.apiUrl,
    timeoutMs: getEnv().ZERNIO_TIMEOUT_MS,
  });
  if (!listed.ok) {
    return NextResponse.json(
      { error: listed.errorCode, message: listed.error, webhooks: [] },
      { status: listed.status === 401 || listed.status === 403 ? 401 : 502 }
    );
  }

  const env = getEnv();
  const ourUrl = `${env.APP_BASE_URL.replace(/\/+$/, "")}/api/webhooks/zernio`;
  return NextResponse.json({
    webhook_url: ourUrl,
    public_url: isPublicWebhookUrl(ourUrl),
    webhooks: listed.webhooks,
    matched: listed.webhooks.find(
      (w) =>
        w.url.replace(/\/+$/, "") === ourUrl.replace(/\/+$/, "") ||
        w.name === "MOOPE Meu Assessor"
    ) || null,
  });
}

/** Cria/atualiza o webhook do Meu Assessor na Zernio via API Key. */
export async function POST(req: NextRequest) {
  const db = getDb();
  let actor;
  try {
    actor = await requireAdmin(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json(
      { error: msg },
      { status: msg === "forbidden" ? 403 : 401 }
    );
  }

  const schema = z.object({
    webhook_url: z.string().url().optional(),
    force_secret: z.boolean().optional(),
  });
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const env = getEnv();
  const cfg = await resolveZernioRuntimeConfig(db);
  const apiKey =
    (await resolveProviderSecret(db, "zernio", "api_key")) || cfg.apiKey;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "missing_api_key",
        message: "Configure a ZERNIO_API_KEY antes.",
      },
      { status: 400 }
    );
  }

  const webhookUrl =
    parsed.data.webhook_url ||
    `${env.APP_BASE_URL.replace(/\/+$/, "")}/api/webhooks/zernio`;

  let secret =
    (await resolveProviderSecret(db, "zernio", "webhook_secret")) ||
    env.ZERNIO_WEBHOOK_SECRET ||
    "";
  if (!secret || parsed.data.force_secret) {
    secret = randomToken(24);
  }

  const ensured = await ensureAssessorWebhook({
    apiKey,
    apiUrl: cfg.apiUrl,
    timeoutMs: env.ZERNIO_TIMEOUT_MS,
    webhookUrl,
    secret,
  });

  if (!ensured.ok) {
    return NextResponse.json(
      {
        error: ensured.errorCode,
        message: ensured.error,
        webhook_url: webhookUrl,
        public_url: isPublicWebhookUrl(webhookUrl),
      },
      {
        status:
          ensured.status === 400
            ? 400
            : ensured.status === 401 || ensured.status === 403
              ? 401
              : 502,
      }
    );
  }

  // Persist secret + webhook metadata without wiping number selection
  const existingRow = await (await import("@/domain/providers")).getProviderConfig(
    db,
    "zernio"
  );
  const prev = (existingRow?.configJson || {}) as Record<string, unknown>;
  await upsertProviderConfig(db, {
    providerKey: "zernio",
    enabled: true,
    providerName: "zernio",
    config: {
      ...prev,
      api_url: cfg.apiUrl || prev.api_url || "https://zernio.com/api/v1",
      account_id: cfg.accountId || prev.account_id || "",
      official_number: cfg.officialNumber || prev.official_number || "",
      webhook_url: webhookUrl,
      webhook_id: ensured.webhook.id,
      webhook_synced_at: new Date().toISOString(),
    },
    secrets: {
      webhook_secret: secret,
    },
    updatedByUserId: actor.user.id,
  });

  await writeAdminAudit(db, {
    actorUserId: actor.user.id,
    action: `provider.zernio.webhook_${ensured.action}`,
    resourceType: "zernio_webhook",
    resourceId: ensured.webhook.id,
    metadata: {
      url: webhookUrl,
      action: ensured.action,
      events: ensured.webhook.events,
    },
  });

  return NextResponse.json({
    ok: true,
    action: ensured.action,
    webhook: {
      id: ensured.webhook.id,
      name: ensured.webhook.name,
      url: ensured.webhook.url,
      is_active: ensured.webhook.is_active,
      events: ensured.webhook.events,
    },
    webhook_url: webhookUrl,
    secret_saved: true,
  });
}
