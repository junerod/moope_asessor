import { and, eq, isNull, sql, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  appointments,
  memories,
  reminders,
  tasks,
  whatsappIdentities,
  conversations,
  workspaces,
} from "@/db/schema";
import { logger } from "@/lib/logger";

/**
 * Foundation for LGPD export/delete. Full UI comes later.
 */
export async function exportUserData(db: Db, userId: string) {
  const identity = await db.query.whatsappIdentities.findFirst({
    where: and(
      eq(whatsappIdentities.userId, userId),
      isNull(whatsappIdentities.deletedAt)
    ),
  });
  const convs = await db.query.conversations.findMany({
    where: eq(conversations.userId, userId),
  });
  return {
    user_id: userId,
    identity: identity
      ? {
          phone_masked: identity.phoneE164
            ? `${identity.phoneE164.slice(0, 4)}****`
            : null,
          status: identity.status,
        }
      : null,
    conversation_ids: convs.map((c) => c.id),
    exported_at: new Date().toISOString(),
    note: "Conteúdo sensível omitido neste export resumido; export completo será fase posterior.",
  };
}

/**
 * Soft-delete strategy for user data. Hard storage purge is async follow-up.
 */
export async function deleteUserData(db: Db, userId: string) {
  const now = new Date();
  const owned = await db.query.workspaces.findMany({
    where: eq(workspaces.ownerUserId, userId),
  });
  const workspaceIds = owned.map((w) => w.id);

  await db
    .update(whatsappIdentities)
    .set({ deletedAt: now, status: "unpaired", updatedAt: now })
    .where(eq(whatsappIdentities.userId, userId));
  await db
    .update(conversations)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(conversations.userId, userId));

  if (workspaceIds.length) {
    await db
      .update(memories)
      .set({ deletedAt: now, status: "deleted", updatedAt: now })
      .where(inArray(memories.workspaceId, workspaceIds));
    await db
      .update(tasks)
      .set({ deletedAt: now, updatedAt: now })
      .where(inArray(tasks.workspaceId, workspaceIds));
  }

  await db
    .update(appointments)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(appointments.userId, userId));
  await db
    .update(reminders)
    .set({ deletedAt: now, status: "cancelled", updatedAt: now })
    .where(eq(reminders.userId, userId));

  logger.info("user_data_delete_requested", { user_id: userId });
  return { ok: true };
}

/** Retention cleanup for ephemeral operational data */
export async function runRetentionCleanup(db: Db) {
  await db.execute(sql`
    DELETE FROM webhook_events
    WHERE created_at < NOW() - INTERVAL '30 days'
      AND status IN ('processed', 'ignored')
  `);
  await db.execute(sql`
    UPDATE whatsapp_identities
    SET verification_code_hash = NULL,
        verification_expires_at = NULL
    WHERE verification_expires_at IS NOT NULL
      AND verification_expires_at < NOW() - INTERVAL '1 day'
  `);
  logger.info("retention_cleanup_completed");
}
