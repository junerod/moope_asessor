import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  requirePlatformAdminFromAuthHeader,
  writeAdminAudit,
} from "@/domain/platform-admin";
import {
  listProvidersForAdmin,
  maskProviderConfig,
  upsertProviderConfig,
  testZernioConnection,
  testOpenAIConnection,
  type ProviderKey,
} from "@/domain/providers";

const keys = [
  "zernio",
  "openai_llm",
  "openai_embeddings",
  "vision",
  "transcription",
  "email",
] as const;

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

  const providers = await listProvidersForAdmin(db);
  return NextResponse.json({ providers });
}

const putSchema = z.object({
  provider_key: z.enum(keys),
  enabled: z.boolean(),
  provider_name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.string().optional()).optional(),
});

export async function PUT(req: NextRequest) {
  const db = getDb();
  let actor;
  try {
    actor = await requirePlatformAdminFromAuthHeader(
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

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const row = await upsertProviderConfig(db, {
    providerKey: parsed.data.provider_key as ProviderKey,
    enabled: parsed.data.enabled,
    providerName: parsed.data.provider_name,
    config: parsed.data.config,
    secrets: parsed.data.secrets,
    updatedByUserId: actor.user.id,
  });

  await writeAdminAudit(db, {
    actorUserId: actor.user.id,
    action: `provider.${parsed.data.provider_key}.updated`,
    resourceType: "provider_config",
    resourceId: row.id,
    metadata: {
      enabled: parsed.data.enabled,
      secret_fields_updated: Object.keys(parsed.data.secrets || {}).filter(
        (k) => parsed.data.secrets?.[k] && !/^•+$/.test(parsed.data.secrets[k]!)
      ),
    },
  });

  return NextResponse.json({ provider: maskProviderConfig(row) });
}

export async function POST(req: NextRequest) {
  const db = getDb();
  let actor;
  try {
    actor = await requirePlatformAdminFromAuthHeader(
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

  const body = await req.json().catch(() => ({}));
  const key = String(body.provider_key || "") as ProviderKey;
  if (!keys.includes(key as (typeof keys)[number])) {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }

  let result;
  if (key === "zernio") result = await testZernioConnection(db);
  else if (key === "email") {
    const to = String(body.to || actor.user.email || "");
    const { testEmailSend } = await import("@/lib/email/provider");
    result = await testEmailSend(db, to);
  } else result = await testOpenAIConnection(db, key);

  await writeAdminAudit(db, {
    actorUserId: actor.user.id,
    action: `provider.${key}.tested`,
    resourceType: "provider_config",
    metadata: { status: result.status },
  });

  return NextResponse.json(result);
}
