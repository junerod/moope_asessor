import { DateTime } from "luxon";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { reminders } from "@/db/schema";
import {
  ensureReminderOutbox,
  reminderOccurrenceKey,
} from "@/domain/alert-delivery";
import {
  extractReminderTitle,
  looksLikeReminderCreate,
} from "@/domain/reminder-intent";
import { hasExplicitClockTime, parseNaturalDateTime } from "@/lib/datetime";
import { logger } from "@/lib/logger";

export type IntegrityGap = {
  messageId: string;
  workspaceId: string;
  userId: string;
  conversationId: string;
  phoneE164: string | null;
  bodyText: string;
  messageAt: Date;
  timezone: string;
};

/**
 * Inbound “me lembre + horário” sem reminder criado na janela.
 * Fonte da verdade para varredura de falhas de gravação.
 */
export async function findReminderCreateGaps(
  db: Db,
  input: { sinceHours?: number; limit?: number } = {}
): Promise<IntegrityGap[]> {
  const sinceHours = Math.min(Math.max(input.sinceHours ?? 72, 1), 720);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);

  const result = await db.execute(sql`
    SELECT
      m.id AS message_id,
      c.id AS conversation_id,
      c.workspace_id,
      c.user_id,
      wi.phone_e164,
      m.body_text,
      m.created_at AS message_at,
      COALESCE(u.timezone, 'America/Sao_Paulo') AS timezone
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN whatsapp_identities wi ON wi.id = c.whatsapp_identity_id
    LEFT JOIN users u ON u.id = c.user_id
    WHERE m.deleted_at IS NULL
      AND m.direction = 'inbound'
      AND m.created_at > NOW() - make_interval(hours => ${sinceHours})
      AND c.workspace_id IS NOT NULL
      AND c.user_id IS NOT NULL
      AND m.body_text ~* '(me lembra|me lembre|me lembrar|lembrar|lembrete)'
      AND m.body_text !~* 'n[aã]o\\s+(me\\s+)?lembr'
      AND m.body_text !~* 'n[aã]o\\s+tem\\s+(de|que)\\s+lembr'
      AND (
        m.body_text ~* '\\d{1,2}h\\d{2}'
        OR m.body_text ~* '\\d{1,2}:\\d{2}'
        OR m.body_text ~* '\\d{1,2}\\s*hs?'
      )
      AND NOT EXISTS (
        SELECT 1 FROM reminders r
        WHERE r.workspace_id = c.workspace_id
          AND r.deleted_at IS NULL
          AND r.created_at BETWEEN m.created_at - INTERVAL '30 seconds'
                              AND m.created_at + INTERVAL '5 minutes'
      )
      AND NOT EXISTS (
        SELECT 1 FROM reminders r2
        WHERE r2.workspace_id = c.workspace_id
          AND r2.deleted_at IS NULL
          AND (r2.payload->>'recovered_from_message_id') = m.id::text
      )
    ORDER BY m.created_at ASC
    LIMIT ${limit}
  `);

  const rows = (Array.isArray(result) ? result : []) as Array<{
    message_id: string;
    conversation_id: string;
    workspace_id: string;
    user_id: string;
    phone_e164: string | null;
    body_text: string;
    message_at: Date | string;
    timezone: string;
  }>;

  return rows.map((r) => ({
    messageId: r.message_id,
    workspaceId: r.workspace_id,
    userId: r.user_id,
    conversationId: r.conversation_id,
    phoneE164: r.phone_e164,
    bodyText: String(r.body_text || ""),
    messageAt:
      r.message_at instanceof Date ? r.message_at : new Date(r.message_at),
    timezone: r.timezone || "America/Sao_Paulo",
  }));
}

function fireAtFromInbound(gap: IntegrityGap): Date | null {
  const tz = gap.timezone || "America/Sao_Paulo";
  const ref = DateTime.fromJSDate(gap.messageAt).setZone(tz);
  if (!ref.isValid) return null;

  const parsed = parseNaturalDateTime(gap.bodyText, tz, ref);
  if (!parsed?.isValid) return null;

  const now = DateTime.now().setZone(tz);
  let fire = parsed;
  // Já passou → entrega atrasada em ~2 min (ainda avisa o usuário)
  if (fire <= now.minus({ minutes: 5 })) {
    fire = now.plus({ minutes: 2 });
  }
  return fire.toUTC().toJSDate();
}

export type HealResult = {
  scanned: number;
  healed: number;
  skipped: number;
  errors: number;
  healedIds: string[];
};

/**
 * Cura gaps: cria reminder + outbox com payload de rastreio.
 */
export async function healReminderCreateGaps(
  db: Db,
  input: { sinceHours?: number; limit?: number; dryRun?: boolean } = {}
): Promise<HealResult> {
  const gaps = await findReminderCreateGaps(db, input);
  const out: HealResult = {
    scanned: gaps.length,
    healed: 0,
    skipped: 0,
    errors: 0,
    healedIds: [],
  };

  for (const gap of gaps) {
    try {
      const loose =
        looksLikeReminderCreate(gap.bodyText) ||
        (/^(lembrete)\b/i.test(gap.bodyText.trim()) &&
          hasExplicitClockTime(gap.bodyText)) ||
        (/\b(me lembra|me lembre|me lembrar)\b/i.test(gap.bodyText) &&
          hasExplicitClockTime(gap.bodyText));
      if (!loose) {
        out.skipped += 1;
        continue;
      }

      const fireAt = fireAtFromInbound(gap);
      if (!fireAt || Number.isNaN(fireAt.getTime())) {
        out.skipped += 1;
        continue;
      }

      const title = extractReminderTitle(gap.bodyText);
      if (input.dryRun) {
        out.healed += 1;
        out.healedIds.push(`dry:${gap.messageId}`);
        continue;
      }

      const payload = {
        kind: "geral",
        recovered_from_message_id: gap.messageId,
        recovered_at: new Date().toISOString(),
        original_inbound: gap.bodyText.slice(0, 300),
      };

      const [row] = await db
        .insert(reminders)
        .values({
          workspaceId: gap.workspaceId,
          userId: gap.userId,
          title: title.slice(0, 500),
          fireAt,
          timezone: gap.timezone,
          status: "scheduled",
          deliveryChannel: "whatsapp",
          payload,
          nextAttemptAt: fireAt,
        })
        .returning();

      await ensureReminderOutbox(db, {
        id: row.id,
        workspaceId: row.workspaceId,
        userId: row.userId,
        title: row.title,
        fireAt: row.fireAt,
        payload,
      });
      await db
        .update(reminders)
        .set({
          occurrenceKey: reminderOccurrenceKey(row.id, row.fireAt),
          updatedAt: new Date(),
        })
        .where(eq(reminders.id, row.id));

      out.healed += 1;
      out.healedIds.push(row.id);
      logger.warn("reminder_integrity_healed", {
        reminder_id: row.id,
        workspace_id: gap.workspaceId,
        message_id: gap.messageId,
        phone: gap.phoneE164,
        fire_at: row.fireAt.toISOString(),
        title: row.title.slice(0, 80),
      });
    } catch (err) {
      out.errors += 1;
      logger.error("reminder_integrity_heal_failed", {
        message_id: gap.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (out.healed || out.errors) {
    logger.warn("reminder_integrity_sweep", {
      scanned: out.scanned,
      healed: out.healed,
      skipped: out.skipped,
      errors: out.errors,
    });
  }
  return out;
}

/** Tick periódico do scheduler: varredura + cura automática. */
export async function runReminderIntegritySweep(db: Db) {
  return healReminderCreateGaps(db, { sinceHours: 48, limit: 80 });
}
