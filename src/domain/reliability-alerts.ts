import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { sendProactiveMessage } from "@/channels/zernio/proactive";
import { beat, getHeartbeatStatus } from "@/domain/health";
import { logger } from "@/lib/logger";
import { getEnv } from "@/config/env";

/**
 * Conta sinais de risco na última hora e alerta o DEV se estourar limiar.
 */
export async function runReliabilityAlertTick(db: Db): Promise<{
  phantoms: number;
  healed: number;
  overdue: number;
  jobsFailed: number;
  gaps: number;
  alerted: boolean;
}> {
  const stats = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM agent_runs
        WHERE created_at > NOW() - INTERVAL '1 hour'
          AND tool_count = 0
          AND provider = 'openai'
          AND (
            output_summary ILIKE '%vou te lembrar%'
            OR output_summary ILIKE '%te lembro%'
          )
      ) AS phantoms,
      (SELECT count(*)::int FROM reminders
        WHERE created_at > NOW() - INTERVAL '1 hour'
          AND payload ? 'recovered_from_message_id'
      ) AS healed,
      (SELECT count(*)::int FROM reminders
        WHERE deleted_at IS NULL
          AND fire_at <= NOW() - INTERVAL '2 minutes'
          AND status IN ('scheduled','queued','failed')
      ) AS overdue,
      (SELECT count(*)::int FROM agent_jobs
        WHERE job_type = 'deliver_reminder'
          AND created_at > NOW() - INTERVAL '1 hour'
          AND (status = 'failed' OR dead_at IS NOT NULL)
      ) AS jobs_failed,
      (SELECT count(*)::int FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.deleted_at IS NULL
          AND m.direction = 'inbound'
          AND m.created_at > NOW() - INTERVAL '6 hours'
          AND m.body_text ~* '(me lembra|me lembre|lembrar|lembrete)'
          AND m.body_text !~* 'n[aã]o\\s+(me\\s+)?lembr'
          AND m.body_text !~* 'n[aã]o\\s+tem\\s+(de|que)\\s+lembr'
          AND (m.body_text ~* '\\d{1,2}h\\d{2}' OR m.body_text ~* '\\d{1,2}:\\d{2}' OR m.body_text ~* '\\d{1,2}\\s*hs?')
          AND c.workspace_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM reminders r
            WHERE r.workspace_id = c.workspace_id
              AND r.deleted_at IS NULL
              AND (
                r.created_at BETWEEN m.created_at - INTERVAL '30 seconds'
                                AND m.created_at + INTERVAL '5 minutes'
                OR (r.payload->>'recovered_from_message_id') = m.id::text
              )
          )
      ) AS gaps
  `);

  const row = (Array.isArray(stats) ? stats[0] : null) as Record<
    string,
    number
  > | null;
  const phantoms = Number(row?.phantoms || 0);
  const healed = Number(row?.healed || 0);
  const overdue = Number(row?.overdue || 0);
  const jobsFailed = Number(row?.jobs_failed || 0);
  const gaps = Number(row?.gaps || 0);

  const shouldAlert =
    phantoms >= 1 || overdue >= 1 || jobsFailed >= 2 || gaps >= 3 || healed >= 5;

  let alerted = false;
  if (shouldAlert) {
    logger.error("reliability_threshold_breach", {
      phantoms,
      healed,
      overdue,
      jobs_failed: jobsFailed,
      gaps,
    });

    const hb = await getHeartbeatStatus(db, "reliability_alert");
    const recent =
      typeof hb.age_seconds === "number" && hb.age_seconds < 1800;

    if (!recent) {
      await beat(db, "reliability_alert", {
        phantoms,
        healed,
        overdue,
        jobsFailed,
        gaps,
      });

      const env = getEnv();
      const phone =
        process.env.DEV_NOTIFY_PHONE ||
        process.env.NOTIFY_DEV_PHONE ||
        "+5561996715985";
      const conv = await db.execute(sql`
        SELECT c.external_conversation_id
        FROM whatsapp_identities wi
        JOIN conversations c ON c.whatsapp_identity_id = wi.id
        WHERE wi.phone_e164 = ${phone}
          AND wi.deleted_at IS NULL
          AND c.deleted_at IS NULL
        ORDER BY c.updated_at DESC NULLS LAST
        LIMIT 1
      `);
      const externalId = (Array.isArray(conv) ? conv[0] : null) as {
        external_conversation_id?: string;
      } | null;
      if (externalId?.external_conversation_id) {
        const text = [
          "🚨 *Alerta confiabilidade Assessor*",
          `Phantoms (1h): *${phantoms}*`,
          `Healed (1h): *${healed}*`,
          `Overdue stuck: *${overdue}*`,
          `Jobs failed (1h): *${jobsFailed}*`,
          `Gaps abertos (6h): *${gaps}*`,
          "",
          "Ver /admin/reliability",
        ].join("\n");
        await sendProactiveMessage(db, {
          conversationId: externalId.external_conversation_id,
          message: text,
          idempotencyKey: `rel-alert:${Date.now()}`,
          withinCustomerCareWindow: true,
        });
        alerted = true;
      }
    }
  }

  return { phantoms, healed, overdue, jobsFailed, gaps, alerted };
}

export async function getReliabilitySnapshot(db: Db) {
  const stats = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM reminders
        WHERE deleted_at IS NULL AND status = 'scheduled' AND fire_at > NOW()
      ) AS scheduled_future,
      (SELECT count(*)::int FROM reminders
        WHERE deleted_at IS NULL
          AND fire_at <= NOW()
          AND status IN ('scheduled','queued','failed')
      ) AS overdue_stuck,
      (SELECT count(*)::int FROM reminders
        WHERE deleted_at IS NULL AND status = 'sent'
          AND last_delivered_at > NOW() - INTERVAL '24 hours'
      ) AS delivered_24h,
      (SELECT count(*)::int FROM agent_jobs
        WHERE job_type = 'deliver_reminder'
          AND created_at > NOW() - INTERVAL '24 hours'
          AND (status = 'failed' OR dead_at IS NOT NULL)
      ) AS deliver_failed_24h,
      (SELECT count(*)::int FROM agent_runs
        WHERE created_at > NOW() - INTERVAL '24 hours'
          AND tool_count = 0
          AND provider = 'openai'
          AND (
            output_summary ILIKE '%vou te lembrar%'
            OR output_summary ILIKE '%te lembro%'
          )
      ) AS phantoms_24h,
      (SELECT count(*)::int FROM reminders
        WHERE created_at > NOW() - INTERVAL '24 hours'
          AND payload ? 'recovered_from_message_id'
      ) AS healed_24h,
      (SELECT count(*)::int FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.deleted_at IS NULL
          AND m.direction = 'inbound'
          AND m.created_at > NOW() - INTERVAL '48 hours'
          AND m.body_text ~* '(me lembra|me lembre|lembrar|lembrete)'
          AND m.body_text !~* 'n[aã]o\\s+(me\\s+)?lembr'
          AND m.body_text !~* 'n[aã]o\\s+tem\\s+(de|que)\\s+lembr'
          AND (m.body_text ~* '\\d{1,2}h\\d{2}' OR m.body_text ~* '\\d{1,2}:\\d{2}' OR m.body_text ~* '\\d{1,2}\\s*hs?')
          AND c.workspace_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM reminders r
            WHERE r.workspace_id = c.workspace_id
              AND r.deleted_at IS NULL
              AND (
                r.created_at BETWEEN m.created_at - INTERVAL '30 seconds'
                                AND m.created_at + INTERVAL '5 minutes'
                OR (r.payload->>'recovered_from_message_id') = m.id::text
              )
          )
      ) AS open_gaps_48h
  `);
  const row = (Array.isArray(stats) ? stats[0] : {}) as Record<string, number>;
  return {
    scheduled_future: Number(row.scheduled_future || 0),
    overdue_stuck: Number(row.overdue_stuck || 0),
    delivered_24h: Number(row.delivered_24h || 0),
    deliver_failed_24h: Number(row.deliver_failed_24h || 0),
    phantoms_24h: Number(row.phantoms_24h || 0),
    healed_24h: Number(row.healed_24h || 0),
    open_gaps_48h: Number(row.open_gaps_48h || 0),
  };
}
