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
import { fetchZernioWhatsappNumbers } from "@/channels/zernio/accounts";
import { getEnv } from "@/config/env";
import {
  getActiveAssistantChannel,
  listChannels,
  setAssistantChannel,
  syncZernioChannels,
} from "@/domain/whatsapp-channels";

async function requireAdmin(req: NextRequest) {
  const db = getDb();
  return requirePlatformAdminFromAuthHeader(
    db,
    req.headers.get("authorization")
  );
}

/** Lista números WhatsApp da chave (salva ou informada no body). */
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

  const body = await req.json().catch(() => ({}));
  const schema = z.object({
    api_key: z.string().optional(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const cfg = await resolveZernioRuntimeConfig(db);
  const apiKey =
    (parsed.data.api_key &&
      parsed.data.api_key.trim() &&
      !/^•+$/.test(parsed.data.api_key.trim())
      ? parsed.data.api_key.trim()
      : null) ||
    (await resolveProviderSecret(db, "zernio", "api_key")) ||
    cfg.apiKey;

  if (!apiKey) {
    return NextResponse.json(
      { error: "missing_api_key", message: "Cole a API Key da Zernio." },
      { status: 400 }
    );
  }

  const listed = await fetchZernioWhatsappNumbers({
    apiKey,
    apiUrl: cfg.apiUrl || getEnv().ZERNIO_API_URL,
    timeoutMs: getEnv().ZERNIO_TIMEOUT_MS,
  });

  if (!listed.ok) {
    return NextResponse.json(
      {
        error: listed.errorCode,
        message: listed.error,
        numbers: [],
      },
      { status: listed.status === 401 || listed.status === 403 ? 401 : 502 }
    );
  }

  await syncZernioChannels(db, listed.numbers);
  const channels = await listChannels(db);
  const assistant = await getActiveAssistantChannel(db);

  await writeAdminAudit(db, {
    actorUserId: actor.user.id,
    action: "provider.zernio.numbers_listed",
    resourceType: "provider_config",
    metadata: { count: listed.numbers.length },
  });

  return NextResponse.json({
    numbers: listed.numbers,
    channels: channels.map((c) => ({
      id: c.id,
      provider_account_id: c.providerAccountId,
      phone_e164: c.phoneE164,
      display_name: c.displayName,
      status: c.status,
      purpose: c.purpose,
      is_active: c.isActive,
    })),
    selected_account_id:
      assistant?.providerAccountId || cfg.accountId || null,
    official_number: assistant?.phoneE164 || cfg.officialNumber || null,
  });
}

/** Salva chave + número escolhido (fluxo finance). */
export async function PUT(req: NextRequest) {
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
    api_key: z.string().optional(),
    webhook_secret: z.string().optional(),
    account_id: z.string().min(1),
    phone: z.string().optional(),
    profile_id: z.string().optional(),
    name: z.string().optional(),
    enabled: z.boolean().optional(),
  });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const existing = await resolveZernioRuntimeConfig(db);
  const row = await upsertProviderConfig(db, {
    providerKey: "zernio",
    enabled: parsed.data.enabled ?? true,
    providerName: "zernio",
    config: {
      api_url: "https://zernio.com/api/v1",
      account_id: parsed.data.account_id,
      official_number: parsed.data.phone || existing.officialNumber || "",
      profile_id: parsed.data.profile_id || "",
      account_name: parsed.data.name || "",
    },
    secrets: {
      api_key: parsed.data.api_key,
      webhook_secret: parsed.data.webhook_secret,
    },
    updatedByUserId: actor.user.id,
  });

  const channel = await setAssistantChannel(db, {
    providerAccountId: parsed.data.account_id,
    actorUserId: actor.user.id,
    phone: parsed.data.phone,
    displayName: parsed.data.name,
    profileId: parsed.data.profile_id,
  });

  await writeAdminAudit(db, {
    actorUserId: actor.user.id,
    action: "provider.zernio.assistant_selected",
    resourceType: "whatsapp_channel",
    resourceId: channel.id,
    metadata: {
      account_id: parsed.data.account_id,
      phone: parsed.data.phone || null,
      provider_config_id: row.id,
    },
  });

  return NextResponse.json({
    ok: true,
    channel: {
      id: channel.id,
      purpose: channel.purpose,
      is_active: channel.isActive,
      provider_account_id: channel.providerAccountId,
      phone_e164: channel.phoneE164,
    },
  });
}
