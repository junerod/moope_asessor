import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { alertOutbox, reminders } from "@/db/schema";
import { enqueueAgentJob } from "@/domain/jobs";
import { logger } from "@/lib/logger";

export function reminderOccurrenceKey(reminderId: string, fireAt: Date): string {
  return `reminder:${reminderId}:${fireAt.toISOString()}`;
}

export function reminderJobKey(reminderId: string, fireAt: Date, attempt = 0): string {
  const base = `reminder_delivery:${reminderId}:${fireAt.toISOString()}`;
  return attempt > 0 ? `${base}:a${attempt}` : base;
}

/** Garante linha na outbox para a ocorrência atual do lembrete. */
export async function ensureReminderOutbox(
  db: Db,
  reminder: {
    id: string;
    workspaceId: string;
    userId: string;
    title: string;
    fireAt: Date;
    payload?: Record<string, unknown> | null;
  }
) {
  const occurrenceKey = reminderOccurrenceKey(reminder.id, reminder.fireAt);
  const jobKey = reminderJobKey(reminder.id, reminder.fireAt, 0);
  await db
    .insert(alertOutbox)
    .values({
      workspaceId: reminder.workspaceId,
      userId: reminder.userId,
      sourceType: "reminder",
      sourceId: reminder.id,
      occurrenceKey,
      fireAt: reminder.fireAt,
      title: reminder.title.slice(0, 500),
      payload: reminder.payload || {},
      status: "pending",
      nextAttemptAt: reminder.fireAt,
      jobIdempotencyKey: jobKey,
    })
    .onConflictDoNothing({ target: alertOutbox.occurrenceKey });
  await db
    .update(reminders)
    .set({ occurrenceKey, updatedAt: new Date() })
    .where(and(eq(reminders.id, reminder.id)));
  return { occurrenceKey, jobKey };
}

type ClaimedReminder = {
  id: string;
  workspace_id: string;
  user_id: string;
  title: string;
  fire_at: Date | string;
  timezone: string;
  delivery_channel: string;
  requires_template: boolean;
  template_name: string | null;
  recurrence_rule: string | null;
  payload: Record<string, unknown> | null;
  attempt_count: number;
};

/**
 * Claim atômico com FOR UPDATE SKIP LOCKED — seguro com N schedulers.
 */
export async function claimDueReminders(
  db: Db,
  input: { limit?: number; lockerId?: string } = {}
): Promise<ClaimedReminder[]> {
  const limit = Math.min(200, Math.max(1, input.limit ?? 100));
  const locker = input.lockerId || `sched:${process.pid}`;
  const result = await db.execute(sql`
    UPDATE reminders
    SET
      status = 'queued',
      locked_at = NOW(),
      locked_by = ${locker},
      attempt_count = COALESCE(attempt_count, 0) + 1,
      updated_at = NOW()
    WHERE id IN (
      SELECT id FROM reminders
      WHERE deleted_at IS NULL
        AND status IN ('scheduled', 'failed')
        AND fire_at <= NOW()
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY fire_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING
      id, workspace_id, user_id, title, fire_at, timezone,
      delivery_channel, requires_template, template_name,
      recurrence_rule, payload, attempt_count
  `);
  return (Array.isArray(result) ? result : []) as ClaimedReminder[];
}

/** Reabre queued travados (>3 min sem entrega). */
export async function reclaimStuckReminders(db: Db) {
  const result = await db.execute(sql`
    UPDATE reminders
    SET
      status = 'scheduled',
      locked_at = NULL,
      locked_by = NULL,
      next_attempt_at = NOW(),
      updated_at = NOW()
    WHERE deleted_at IS NULL
      AND status = 'queued'
      AND COALESCE(locked_at, updated_at) < NOW() - INTERVAL '3 minutes'
    RETURNING id
  `);
  const n = Array.isArray(result) ? result.length : 0;
  if (n > 0) logger.warn("reminders_reclaimed_stuck", { count: n });
  return n;
}

export async function enqueueReminderDelivery(
  db: Db,
  reminder: ClaimedReminder
): Promise<boolean> {
  const fireAt =
    reminder.fire_at instanceof Date
      ? reminder.fire_at
      : new Date(reminder.fire_at);
  const attempt = Number(reminder.attempt_count || 1);
  await ensureReminderOutbox(db, {
    id: reminder.id,
    workspaceId: reminder.workspace_id,
    userId: reminder.user_id,
    title: reminder.title,
    fireAt,
    payload: reminder.payload,
  });

  // Tentativa 1 usa chave estável; retries usam sufixo para não colidir com job completed
  const idempotencyKey = reminderJobKey(reminder.id, fireAt, Math.max(0, attempt - 1));

  const { created, job } = await enqueueAgentJob(db, {
    jobType: "deliver_reminder",
    workspaceId: reminder.workspace_id,
    idempotencyKey,
    maxAttempts: 8,
    payload: {
      reminder_id: reminder.id,
      title: reminder.title,
      delivery_channel: reminder.delivery_channel,
      requires_template: reminder.requires_template,
      template_name: reminder.template_name,
      user_id: reminder.user_id,
      occurrence_key: reminderOccurrenceKey(reminder.id, fireAt),
      fire_at: fireAt.toISOString(),
      attempt,
    },
  });

  await db.execute(sql`
    UPDATE alert_outbox
    SET
      status = 'processing',
      attempt_count = GREATEST(attempt_count, ${attempt}),
      job_idempotency_key = ${idempotencyKey},
      locked_at = NOW(),
      updated_at = NOW()
    WHERE occurrence_key = ${reminderOccurrenceKey(reminder.id, fireAt)}
      AND status IN ('pending', 'failed', 'processing')
  `);

  if (created) {
    logger.info("reminder_queued", {
      reminder_id: reminder.id,
      workspace_id: reminder.workspace_id,
      fire_at: fireAt.toISOString(),
      attempt,
      job_id: job.id,
    });
  } else if (job.status === "completed" || job.status === "failed") {
    // Job antigo morto sem delivery → marca failed curto para watchdog reabrir
    if (job.status === "completed") {
      // pode ter entregue: deixa watchdog/outbox decidir
      logger.warn("reminder_job_already_exists", {
        reminder_id: reminder.id,
        job_status: job.status,
        idempotency_key: idempotencyKey,
      });
    }
  }
  return created;
}

/**
 * Watchdog: só corrige invariante quebrada. Não reabre o que o claim já possui.
 *
 * Dono de cada situação:
 * - lembrete sent, cancelado ou apagado com outbox aberta → esta função cancela a outbox uma vez
 * - queued com lock > 3 min → reclaimStuckReminders
 * - outbox processing com lock > 5 min e lembrete ainda ativo → esta função devolve ao claim
 * - lembrete devido sem nenhuma linha de outbox → esta função cria a outbox
 * - lembrete scheduled/failed devido, com outbox pending → claimDueReminders (a cada poll)
 *
 * `repaired` conta só transição real. Reescrever pending→pending não conta e não se repete.
 */
export async function runAlertWatchdog(db: Db) {
  let repaired = 0;

  const closed = await db.execute(sql`
    UPDATE alert_outbox o
    SET
      status = 'cancelled',
      locked_at = NULL,
      locked_by = NULL,
      updated_at = NOW()
    FROM reminders r
    WHERE o.source_type = 'reminder'
      AND o.source_id = r.id
      AND o.status IN ('pending', 'processing', 'failed')
      AND o.delivered_at IS NULL
      AND (r.status IN ('cancelled', 'sent') OR r.deleted_at IS NOT NULL)
    RETURNING o.id
  `);
  const closedCount = Array.isArray(closed) ? closed.length : 0;
  if (closedCount > 0) {
    logger.info("alert_outbox_closed_with_reminder", { count: closedCount });
  }

  const reopened = await db.execute(sql`
    WITH stale AS (
      UPDATE alert_outbox o
      SET
        status = 'pending',
        next_attempt_at = NOW(),
        locked_at = NULL,
        locked_by = NULL,
        updated_at = NOW()
      FROM reminders r
      WHERE o.source_type = 'reminder'
        AND o.source_id = r.id
        AND r.deleted_at IS NULL
        AND r.status IN ('scheduled', 'queued', 'failed')
        AND o.status = 'processing'
        AND o.delivered_at IS NULL
        AND o.attempt_count < o.max_attempts
        AND o.fire_at <= NOW() - INTERVAL '30 seconds'
        AND (o.locked_at IS NULL OR o.locked_at < NOW() - INTERVAL '5 minutes')
      RETURNING o.source_id
    )
    UPDATE reminders
    SET
      status = 'scheduled',
      next_attempt_at = NOW(),
      locked_at = NULL,
      locked_by = NULL,
      updated_at = NOW()
    WHERE id IN (SELECT source_id FROM stale)
      AND deleted_at IS NULL
      AND status IN ('queued', 'failed', 'scheduled')
    RETURNING id
  `);
  repaired += Array.isArray(reopened) ? reopened.length : 0;

  const missing = await db.execute(sql`
    SELECT r.id, r.workspace_id, r.user_id, r.title, r.fire_at, r.payload
    FROM reminders r
    WHERE r.deleted_at IS NULL
      AND r.status IN ('scheduled', 'queued', 'failed')
      AND r.fire_at <= NOW() - INTERVAL '1 minute'
      AND NOT EXISTS (
        SELECT 1 FROM alert_outbox o
        WHERE o.source_type = 'reminder'
          AND o.source_id = r.id
          AND o.fire_at = r.fire_at
      )
    LIMIT 100
  `);
  for (const row of (Array.isArray(missing) ? missing : []) as Array<{
    id: string;
    workspace_id: string;
    user_id: string;
    title: string;
    fire_at: Date | string;
    payload: Record<string, unknown> | null;
  }>) {
    const fireAt =
      row.fire_at instanceof Date ? row.fire_at : new Date(row.fire_at);
    await ensureReminderOutbox(db, {
      id: row.id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      title: row.title,
      fireAt,
      payload: row.payload,
    });
    await db.execute(sql`
      UPDATE reminders
      SET status = 'scheduled', next_attempt_at = NOW(), updated_at = NOW(),
          locked_at = NULL, locked_by = NULL
      WHERE id = ${row.id}
        AND deleted_at IS NULL
        AND status IN ('scheduled', 'queued', 'failed')
    `);
    repaired += 1;
  }

  if (repaired > 0) {
    logger.warn("alert_watchdog_repaired", { repaired });
  }
  return { repaired, closed: closedCount };
}

export async function markOutboxDelivered(
  db: Db,
  input: {
    occurrenceKey: string;
    messageId?: string | null;
  }
) {
  await db.execute(sql`
    UPDATE alert_outbox
    SET
      status = 'delivered',
      delivered_at = NOW(),
      delivered_message_id = ${input.messageId ?? null},
      locked_at = NULL,
      locked_by = NULL,
      last_error = NULL,
      updated_at = NOW()
    WHERE occurrence_key = ${input.occurrenceKey}
  `);
  // Cancela irmãos pending do mesmo source (ex.: fire_at ajustado em retry)
  await db.execute(sql`
    UPDATE alert_outbox
    SET status = 'cancelled', updated_at = NOW(), locked_at = NULL, locked_by = NULL
    WHERE source_type = 'reminder'
      AND source_id = (
        SELECT source_id FROM alert_outbox
        WHERE occurrence_key = ${input.occurrenceKey}
        LIMIT 1
      )
      AND occurrence_key <> ${input.occurrenceKey}
      AND status IN ('pending', 'processing', 'failed')
      AND delivered_at IS NULL
  `);
}

export async function markOutboxFailed(
  db: Db,
  input: {
    occurrenceKey: string;
    error: string;
    retryInSeconds?: number;
  }
) {
  const delay = Math.min(Math.max(input.retryInSeconds ?? 120, 30), 3600);
  await db.execute(sql`
    UPDATE alert_outbox
    SET
      status = CASE
        WHEN attempt_count + 1 >= max_attempts THEN 'failed'::alert_outbox_status
        ELSE 'pending'::alert_outbox_status
      END,
      attempt_count = attempt_count + 1,
      next_attempt_at = NOW() + make_interval(secs => ${delay}),
      last_error = ${input.error.slice(0, 2000)},
      locked_at = NULL,
      locked_by = NULL,
      updated_at = NOW()
    WHERE occurrence_key = ${input.occurrenceKey}
  `);
}
