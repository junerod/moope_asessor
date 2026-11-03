/**
 * Guarda de envio: se bom dia, boa noite ou aviso do CRM não saiu,
 * tenta de novo com o template aprovado e avisa o DEV se ainda falhar.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { messages } from "@/db/schema";
import { sendProactiveMessage } from "@/channels/zernio/proactive";
import { beat, getHeartbeatStatus } from "@/domain/health";
import { executeRows, isConfirmedDelivery } from "@/domain/send-once";
import { notifyDevWhatsApp } from "@/domain/dev-ops-metrics";
import { logger } from "@/lib/logger";

export const APPROVED_FALLBACK_TEMPLATE = "notification";

export function digestStillMissing(input: {
  failed: boolean;
  laterSent: boolean;
}): boolean {
  return input.failed && !input.laterSent;
}

export async function sendGuardedMessage(
  db: Db,
  input: {
    conversationId: string;
    message: string;
    idempotencyKey: string;
    withinCustomerCareWindow?: boolean;
    forceTemplate?: boolean;
    logicalTemplate?: string;
    allowDuplicate?: boolean;
  }
) {
  const first = await sendProactiveMessage(db, input);
  if (isConfirmedDelivery(first)) return first;
  if (
    first.errorCode === "SEND_UNCERTAIN" ||
    first.errorCode === "CLAIM_HELD"
  ) {
    return first;
  }
  return sendProactiveMessage(db, {
    ...input,
    conversationId: input.conversationId,
    message: input.message,
    idempotencyKey: `${input.idempotencyKey}:guard`,
    allowDuplicate: true,
    withinCustomerCareWindow: false,
    forceTemplate: true,
    logicalTemplate: APPROVED_FALLBACK_TEMPLATE,
  });
}

type FailedDigest = {
  conversation_id: string;
  workspace_id: string | null;
  body_text: string;
  correlation_id: string;
  external_conversation_id: string;
  phone_e164: string | null;
};

export async function runOutboundGuardTick(db: Db): Promise<{
  found: number;
  retried: number;
  recovered: number;
  alerted: boolean;
}> {
  const rows = executeRows(
    await db.execute(sql`
      SELECT
        m.conversation_id,
        m.workspace_id,
        m.body_text,
        m.correlation_id,
        c.external_conversation_id,
        wi.phone_e164
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN whatsapp_identities wi ON wi.id = c.whatsapp_identity_id
      WHERE m.deleted_at IS NULL
        AND m.direction = 'outbound'
        AND m.status = 'failed'
        AND m.created_at > NOW() - INTERVAL '18 hours'
        AND (
          m.correlation_id LIKE 'daily_brief:%'
          OR m.correlation_id LIKE 'evening_wrap:%'
          OR m.correlation_id LIKE 'crm-new:%'
          OR m.correlation_id LIKE 'crm-reply:%'
          OR m.correlation_id LIKE 'crm-down:%'
          OR m.correlation_id LIKE 'weekly_digest:%'
          OR m.correlation_id LIKE 'gcal-new:%'
          OR m.correlation_id LIKE 'gcal-nudge:%'
          OR m.correlation_id LIKE 'weather_alert:%'
          OR m.correlation_id LIKE 'horoscope_alert:%'
          OR m.correlation_id LIKE 'goal_alert:%'
          OR m.correlation_id LIKE 'bill_due:%'
        )
        AND NOT EXISTS (
          SELECT 1 FROM messages s
          WHERE s.conversation_id = m.conversation_id
            AND s.deleted_at IS NULL
            AND s.direction = 'outbound'
            AND s.status = 'sent'
            AND s.correlation_id = m.correlation_id
        )
      ORDER BY m.created_at DESC
      LIMIT 20
    `)
  ) as FailedDigest[];

  let retried = 0;
  let recovered = 0;
  const still: string[] = [];

  for (const row of rows) {
    const ext = String(row.external_conversation_id || "").trim();
    const text = String(row.body_text || "").trim();
    const corr = String(row.correlation_id || "").trim();
    if (!ext || !text || !corr) continue;
    retried += 1;
    const send = await sendGuardedMessage(db, {
      conversationId: ext,
      message: text,
      idempotencyKey: `${corr}:${ext}:retry`,
      withinCustomerCareWindow: false,
      forceTemplate: true,
      logicalTemplate: APPROVED_FALLBACK_TEMPLATE,
      allowDuplicate: true,
    });
    if (isConfirmedDelivery(send)) {
      recovered += 1;
      await db.insert(messages).values({
        conversationId: row.conversation_id,
        workspaceId: row.workspace_id || null,
        direction: "outbound",
        status: "sent",
        bodyText: text,
        contentType: "text",
        correlationId: corr,
        rawPayload: { kind: "outbound_guard", recovered: true },
        sentAt: new Date(),
      });
      logger.info("outbound_guard_recovered", {
        correlation_id: corr,
        phone: row.phone_e164,
      });
    } else {
      still.push(row.phone_e164 || ext.slice(-8));
      logger.warn("outbound_guard_still_failed", {
        correlation_id: corr,
        phone: row.phone_e164,
        error: send.error,
      });
    }
  }

  let alerted = false;
  if (still.length) {
    const hb = await getHeartbeatStatus(db, "outbound_guard");
    const recent = typeof hb.age_seconds === "number" && hb.age_seconds < 3 * 3600;
    if (!recent) {
      await beat(db, "outbound_guard", { still: still.length, recovered });
      const unique = [...new Set(still)].slice(0, 8);
      const text = [
        "⚠️ *Zap que não saiu*",
        `Tentei de novo: *${retried}* · recuperados: *${recovered}* · ainda falhou: *${still.length}*`,
        unique.map((p) => `• ${p}`).join("\n"),
        "_O guarda tenta de novo sozinho. Facejus/finance não entram aqui._",
      ].join("\n");
      alerted = await notifyDevWhatsApp(db, text, `outbound-guard:${Date.now()}`);
      if (!alerted) {
        logger.warn("outbound_guard_dev_notify_failed", {
          still: still.length,
        });
      } else {
        logger.info("outbound_guard_dev_notified", { still: still.length });
      }
    }
  }

  return { found: rows.length, retried, recovered, alerted };
}
