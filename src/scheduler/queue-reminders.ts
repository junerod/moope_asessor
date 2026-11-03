import type { Db } from "@/db/client";
import {
  claimDueReminders,
  enqueueReminderDelivery,
  reclaimStuckReminders,
  runAlertWatchdog,
} from "@/domain/alert-delivery";
import { logger } from "@/lib/logger";

/**
 * Pipeline de alertas:
 * 1) reclaim stuck
 * 2) claim SKIP LOCKED dos devidos
 * 3) enqueue job + outbox
 * Nunca engole o tick inteiro se um item falhar.
 */
export async function queueDueReminders(db: Db) {
  let reclaimed = 0;
  try {
    reclaimed = await reclaimStuckReminders(db);
  } catch (err) {
    logger.warn("reminder_reclaim_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let claimed: Awaited<ReturnType<typeof claimDueReminders>> = [];
  try {
    claimed = await claimDueReminders(db, {
      limit: 150,
      lockerId: `sched:${process.pid}`,
    });
  } catch (err) {
    logger.error("reminder_claim_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { scanned: 0, queued: 0, reclaimed };
  }

  let queued = 0;
  for (const reminder of claimed) {
    try {
      const created = await enqueueReminderDelivery(db, reminder);
      if (created) queued += 1;
    } catch (err) {
      logger.error("reminder_enqueue_item_failed", {
        reminder_id: reminder.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // devolve para scheduled com backoff curto
      try {
        const { sql } = await import("drizzle-orm");
        await db.execute(sql`
          UPDATE reminders
          SET status = 'failed',
              next_attempt_at = NOW() + INTERVAL '2 minutes',
              last_error = ${String(err instanceof Error ? err.message : err).slice(0, 500)},
              locked_at = NULL,
              locked_by = NULL,
              updated_at = NOW()
          WHERE id = ${reminder.id}
        `);
      } catch {
        /* ignore */
      }
    }
  }

  return { scanned: claimed.length, queued, reclaimed };
}

export async function runAlertWatchdogTick(db: Db) {
  try {
    return await runAlertWatchdog(db);
  } catch (err) {
    logger.error("alert_watchdog_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { repaired: 0 };
  }
}
