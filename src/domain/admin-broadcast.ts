import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { conversations, whatsappIdentities } from "@/db/schema";
import { sendProactiveMessage } from "@/channels/zernio/proactive";
import { writeAdminAudit } from "@/domain/platform-admin";
import { logger } from "@/lib/logger";

const DEV_FALLBACK_CONV = "bba78bb1-bb8a-4e96-addc-b768418d2dae";

function devPhoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  const out = new Set<string>();
  out.add(phone.startsWith("+") ? phone : `+${digits}`);
  out.add(`+${digits}`);
  if (digits.startsWith("55") && digits.length === 12) {
    out.add(`+${digits.slice(0, 4)}9${digits.slice(4)}`);
  }
  if (digits.startsWith("55") && digits.length === 13) {
    out.add(`+${digits.slice(0, 4)}${digits.slice(5)}`);
  }
  if (digits.length === 11 || digits.length === 10) out.add(`+55${digits}`);
  return [...out];
}

/** Resolve conversa Zernio do número DEV (mesmo critério do notify-dev). */
async function resolveDevConversation(db: Db): Promise<{
  externalConversationId: string;
  phoneE164: string | null;
} | null> {
  const DEV =
    process.env.DEV_NOTIFY_PHONE ||
    process.env.NOTIFY_DEV_PHONE ||
    "+5561996715985";
  const phones = devPhoneVariants(DEV);
  const digitsList = phones.map((p) => p.replace(/\D/g, ""));

  const identity = await db.query.whatsappIdentities.findFirst({
    where: and(
      isNull(whatsappIdentities.deletedAt),
      or(
        ...phones.map((p) => eq(whatsappIdentities.phoneE164, p)),
        ...digitsList.map(
          (d) =>
            sql`regexp_replace(coalesce(${whatsappIdentities.phoneE164}, ''), '\\D', '', 'g') = ${d}`
        )
      )
    ),
  });

  if (identity) {
    const conv = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.whatsappIdentityId, identity.id),
        isNull(conversations.deletedAt)
      ),
      orderBy: (c, { desc }) => [desc(c.lastMessageAt)],
    });
    if (conv?.externalConversationId) {
      return {
        externalConversationId: conv.externalConversationId,
        phoneE164: identity.phoneE164,
      };
    }
  }

  const fb = await db.query.conversations.findFirst({
    where: eq(conversations.id, DEV_FALLBACK_CONV),
  });
  if (fb?.externalConversationId) {
    return {
      externalConversationId: fb.externalConversationId,
      phoneE164: DEV,
    };
  }
  return null;
}

export type BroadcastAudience =
  | "all"
  | "geral"
  | "locadora"
  | "iot"
  | "facejus";

export const BROADCAST_AUDIENCES: Array<{
  id: BroadcastAudience;
  label: string;
  description: string;
}> = [
  {
    id: "all",
    label: "Todos",
    description: "Todos com WhatsApp pareado e conversa ativa",
  },
  {
    id: "geral",
    label: "Geral / pessoal",
    description: "Sem vínculo ativo de locadora ou Facejus",
  },
  {
    id: "locadora",
    label: "Locadoras",
    description: "Contexto empresarial locadora (frota)",
  },
  {
    id: "iot",
    label: "IoT / supermercado",
    description: "Contexto IoT (carrinhos / TAGs)",
  },
  {
    id: "facejus",
    label: "Facejus",
    description: "Contexto jurídico Facejus",
  },
];

export type BroadcastRecipient = {
  conversationId: string;
  externalConversationId: string;
  workspaceId: string;
  userId: string | null;
  phoneE164: string | null;
  displayName: string | null;
  segmentHint: string | null;
};

function audienceFilterSql(audience: BroadcastAudience) {
  switch (audience) {
    case "all":
      return sql`TRUE`;
    case "geral":
      return sql`
        NOT EXISTS (
          SELECT 1 FROM whatsapp_business_context bc
          WHERE bc.phone_digits = regexp_replace(coalesce(wi.phone_e164, ''), '\\D', '', 'g')
        )
      `;
    case "locadora":
      return sql`
        EXISTS (
          SELECT 1 FROM whatsapp_business_context bc
          WHERE bc.phone_digits = regexp_replace(coalesce(wi.phone_e164, ''), '\\D', '', 'g')
            AND bc.kind = 'locadora'
            AND coalesce(bc.label, '') !~* 'iot'
            AND coalesce(bc.papel, '') !~* 'iot'
        )
      `;
    case "iot":
      return sql`
        EXISTS (
          SELECT 1 FROM whatsapp_business_context bc
          WHERE bc.phone_digits = regexp_replace(coalesce(wi.phone_e164, ''), '\\D', '', 'g')
            AND bc.kind = 'locadora'
            AND (
              coalesce(bc.label, '') ~* 'iot'
              OR coalesce(bc.papel, '') ~* 'iot'
            )
        )
      `;
    case "facejus":
      return sql`
        EXISTS (
          SELECT 1 FROM whatsapp_business_context bc
          WHERE bc.phone_digits = regexp_replace(coalesce(wi.phone_e164, ''), '\\D', '', 'g')
            AND bc.kind = 'facejus'
        )
      `;
    default:
      return sql`FALSE`;
  }
}

/** Destinatários únicos por conversa externa (1 WhatsApp = 1 envio). */
export async function listBroadcastRecipients(
  db: Db,
  audience: BroadcastAudience
): Promise<BroadcastRecipient[]> {
  const filter = audienceFilterSql(audience);
  const result = await db.execute(sql`
    SELECT DISTINCT ON (c.external_conversation_id)
      c.id AS conversation_id,
      c.external_conversation_id,
      c.workspace_id,
      c.user_id,
      wi.phone_e164,
      wi.display_name,
      (
        SELECT bc.kind || ' · ' || bc.label
        FROM whatsapp_business_context bc
        WHERE bc.phone_digits = regexp_replace(coalesce(wi.phone_e164, ''), '\\D', '', 'g')
        LIMIT 1
      ) AS segment_hint
    FROM conversations c
    JOIN whatsapp_identities wi ON wi.id = c.whatsapp_identity_id
    WHERE c.deleted_at IS NULL
      AND wi.deleted_at IS NULL
      AND c.status = 'active'
      AND c.external_conversation_id IS NOT NULL
      AND length(trim(c.external_conversation_id)) > 0
      AND wi.status = 'paired'
      AND ${filter}
    ORDER BY c.external_conversation_id, c.updated_at DESC NULLS LAST
  `);

  const rows = (Array.isArray(result) ? result : []) as Array<{
    conversation_id: string;
    external_conversation_id: string;
    workspace_id: string;
    user_id: string | null;
    phone_e164: string | null;
    display_name: string | null;
    segment_hint: string | null;
  }>;

  return rows.map((r) => ({
    conversationId: r.conversation_id,
    externalConversationId: r.external_conversation_id,
    workspaceId: r.workspace_id,
    userId: r.user_id,
    phoneE164: r.phone_e164,
    displayName: r.display_name,
    segmentHint: r.segment_hint,
  }));
}

export async function countBroadcastAudiences(db: Db) {
  const out: Record<BroadcastAudience, number> = {
    all: 0,
    geral: 0,
    locadora: 0,
    iot: 0,
    facejus: 0,
  };
  for (const a of BROADCAST_AUDIENCES) {
    const list = await listBroadcastRecipients(db, a.id);
    out[a.id] = list.length;
  }
  return out;
}

export type BroadcastSendResult = {
  audience: BroadcastAudience;
  total: number;
  sent: number;
  failed: number;
  errors: Array<{ phone: string | null; error: string }>;
};

/**
 * Envio em massa com pacing leve (anti rate-limit Zernio).
 * Superadmin only — caller deve validar role.
 */
export async function sendBroadcast(
  db: Db,
  input: {
    audience: BroadcastAudience;
    message: string;
    actorUserId: string;
    dryRun?: boolean;
    pauseMs?: number;
    /** URL pública da imagem (post) */
    imageUrl?: string | null;
    /** Só envia pro Zap DEV (teste obrigatório antes do massa) */
    testDevOnly?: boolean;
  }
): Promise<BroadcastSendResult & { testedDev?: boolean }> {
  const message = String(input.message || "").trim();
  const imageUrl = String(input.imageUrl || "").trim() || null;
  if (!imageUrl && message.length < 3) throw new Error("message_too_short");
  if (message.length > 3500) throw new Error("message_too_long");
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    throw new Error("image_url_invalid");
  }

  if (input.testDevOnly) {
    const { createZernioClient } = await import("@/channels/zernio");
    const { resolveZernioRuntimeConfig } = await import("@/domain/providers");
    const hit = await resolveDevConversation(db);
    if (!hit?.externalConversationId) {
      throw new Error("dev_conversation_not_found");
    }

    const caption = imageUrl
      ? message || undefined
      : `🧪 *Teste post (só DEV)*\n\n${message}`;

    if (imageUrl) {
      const cfg = await resolveZernioRuntimeConfig(db);
      const client = createZernioClient({
        mock: cfg.mock,
        apiKey: cfg.apiKey,
        apiUrl: cfg.apiUrl,
        accountId: cfg.accountId,
      });
      const send = await client.sendMedia({
        conversationId: hit.externalConversationId,
        attachmentUrl: imageUrl,
        attachmentType: "image",
        message: caption
          ? `🧪 *Teste post (só DEV)*\n\n${caption}`
          : "🧪 *Teste post (só DEV)*",
        idempotencyKey: `bcast-dev-test:${Date.now()}`,
        accountId: cfg.accountId,
      });
      await writeAdminAudit(db, {
        actorUserId: input.actorUserId,
        action: "broadcast.test_dev",
        resourceType: "broadcast",
        resourceId: `bcast-dev:${Date.now()}`,
        metadata: {
          audience: input.audience,
          has_image: true,
          sent: send.ok,
        },
      });
      return {
        audience: input.audience,
        total: 1,
        sent: send.ok ? 1 : 0,
        failed: send.ok ? 0 : 1,
        errors: send.ok
          ? []
          : [{ phone: hit.phoneE164, error: send.error || "fail" }],
        testedDev: true,
      };
    }

    const send = await sendProactiveMessage(db, {
      conversationId: hit.externalConversationId,
      message: caption || message,
      idempotencyKey: `bcast-dev-test:${Date.now()}`,
      withinCustomerCareWindow: true,
    });
    await writeAdminAudit(db, {
      actorUserId: input.actorUserId,
      action: "broadcast.test_dev",
      resourceType: "broadcast",
      resourceId: `bcast-dev:${Date.now()}`,
      metadata: {
        audience: input.audience,
        has_image: false,
        sent: send.ok,
      },
    });
    return {
      audience: input.audience,
      total: 1,
      sent: send.ok ? 1 : 0,
      failed: send.ok ? 0 : 1,
      errors: send.ok
        ? []
        : [{ phone: hit.phoneE164, error: send.error || "fail" }],
      testedDev: true,
    };
  }

  const recipients = await listBroadcastRecipients(db, input.audience);
  const result: BroadcastSendResult & { testedDev?: boolean } = {
    audience: input.audience,
    total: recipients.length,
    sent: 0,
    failed: 0,
    errors: [],
  };

  if (input.dryRun) return result;

  const batchId = `bcast:${input.audience}:${Date.now()}`;
  const pause = Math.min(Math.max(input.pauseMs ?? 400, 100), 3000);
  const { createZernioClient } = await import("@/channels/zernio");
  const { resolveZernioRuntimeConfig } = await import("@/domain/providers");
  const cfg = await resolveZernioRuntimeConfig(db);
  const client = createZernioClient({
    mock: cfg.mock,
    apiKey: cfg.apiKey,
    apiUrl: cfg.apiUrl,
    accountId: cfg.accountId,
  });

  for (const [i, r] of recipients.entries()) {
    try {
      if (imageUrl) {
        const send = await client.sendMedia({
          conversationId: r.externalConversationId,
          attachmentUrl: imageUrl,
          attachmentType: "image",
          message: message || undefined,
          idempotencyKey: `${batchId}:${r.externalConversationId}`,
          accountId: cfg.accountId,
        });
        if (send.ok) result.sent += 1;
        else {
          result.failed += 1;
          result.errors.push({
            phone: r.phoneE164,
            error: send.error || "send_failed",
          });
        }
      } else {
        const send = await sendProactiveMessage(db, {
          conversationId: r.externalConversationId,
          message,
          idempotencyKey: `${batchId}:${r.externalConversationId}`,
          withinCustomerCareWindow: true,
        });
        if (send.ok) result.sent += 1;
        else {
          result.failed += 1;
          result.errors.push({
            phone: r.phoneE164,
            error: send.error || send.errorCode || "send_failed",
          });
        }
      }
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        phone: r.phoneE164,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (i < recipients.length - 1) {
      await new Promise((res) => setTimeout(res, pause));
    }
  }

  await writeAdminAudit(db, {
    actorUserId: input.actorUserId,
    action: "broadcast.send",
    resourceType: "broadcast",
    resourceId: batchId,
    metadata: {
      audience: input.audience,
      total: result.total,
      sent: result.sent,
      failed: result.failed,
      message_preview: message.slice(0, 120),
      has_image: Boolean(imageUrl),
    },
  });

  logger.info("admin_broadcast_done", {
    batch_id: batchId,
    audience: input.audience,
    sent: result.sent,
    failed: result.failed,
    total: result.total,
    has_image: Boolean(imageUrl),
  });

  return result;
}
