#!/usr/bin/env tsx
/**
 * Smoke de confiabilidade: cria lembrete → claim → (opcional) delivery check.
 *
 * Uso (no worker):
 *   npx tsx scripts/smoke-reminder-pipeline.ts
 *   npx tsx scripts/smoke-reminder-pipeline.ts --deliver
 *
 * Falha com exit 1 se qualquer etapa quebrar.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb, closeDb } from "@/db/client";
import { reminders, whatsappIdentities, conversations } from "@/db/schema";
import {
  claimDueReminders,
  enqueueReminderDelivery,
  ensureReminderOutbox,
  reminderOccurrenceKey,
} from "@/domain/alert-delivery";
import { getEnv } from "@/config/env";

async function main() {
  const wantDeliver = process.argv.includes("--deliver");
  const db = getDb();
  const env = getEnv();
  const phone =
    process.env.SMOKE_REMINDER_PHONE ||
    process.env.DEV_NOTIFY_PHONE ||
    "+5561996715985";

  try {
    const identity = await db.query.whatsappIdentities.findFirst({
      where: and(
        eq(whatsappIdentities.phoneE164, phone),
        isNull(whatsappIdentities.deletedAt)
      ),
    });
    if (!identity?.userId) throw new Error(`identity_not_found:${phone}`);

    const conv = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.whatsappIdentityId, identity.id),
        isNull(conversations.deletedAt)
      ),
    });
    if (!conv?.workspaceId) throw new Error("conversation_not_found");

    const fireAt = DateTime.now()
      .setZone(env.DEFAULT_TIMEZONE || "America/Sao_Paulo")
      .plus({ seconds: 5 })
      .toJSDate();

    const [row] = await db
      .insert(reminders)
      .values({
        workspaceId: conv.workspaceId,
        userId: identity.userId,
        title: "🔧 Smoke confiabilidade alertas",
        fireAt,
        timezone: env.DEFAULT_TIMEZONE || "America/Sao_Paulo",
        status: "scheduled",
        deliveryChannel: "whatsapp",
        payload: {
          kind: "geral",
          note: "__internal_test__ smoke_alert",
          emoji: "🔧",
        },
        nextAttemptAt: fireAt,
      })
      .returning();

    await ensureReminderOutbox(db, {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      title: row.title,
      fireAt: row.fireAt,
      payload: row.payload as Record<string, unknown>,
    });
    await db
      .update(reminders)
      .set({
        occurrenceKey: reminderOccurrenceKey(row.id, row.fireAt),
        updatedAt: new Date(),
      })
      .where(eq(reminders.id, row.id));

    // Espera fire_at
    await new Promise((r) => setTimeout(r, 6000));

    const claimed = await claimDueReminders(db, {
      limit: 50,
      lockerId: "smoke-reminder",
    });
    const mine = claimed.find((c) => c.id === row.id);
    if (!mine) {
      // força status scheduled com fire passado
      await db.execute(sql`
          UPDATE reminders SET fire_at = NOW() - INTERVAL '1 second',
            status = 'scheduled', next_attempt_at = NOW(),
            locked_at = NULL, locked_by = NULL
          WHERE id = ${row.id}
        `);
      const claimed2 = await claimDueReminders(db, {
        limit: 50,
        lockerId: "smoke-reminder-2",
      });
      const mine2 = claimed2.find((c) => c.id === row.id);
      if (!mine2) throw new Error("claim_failed");
      const queued = await enqueueReminderDelivery(db, mine2);
      if (!queued && wantDeliver) throw new Error("enqueue_failed");
      console.log(
        JSON.stringify({
          ok: true,
          step: "claim_retry",
          reminder_id: row.id,
          queued,
          deliver: wantDeliver,
        })
      );
    } else {
      const queued = await enqueueReminderDelivery(db, mine);
      console.log(
        JSON.stringify({
          ok: true,
          step: "claim",
          reminder_id: row.id,
          queued,
          deliver: wantDeliver,
        })
      );
    }

    // Não apaga — marcador interno; listagens filtram isInternalTestReminder
    process.exit(0);
  } catch (err) {
    console.error(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    process.exit(1);
  } finally {
    await closeDb();
  }
}

main();
