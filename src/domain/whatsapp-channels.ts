import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { whatsappChannels, type WhatsappChannel } from "@/db/schema";
import type { ZernioWhatsappNumber } from "@/channels/zernio/accounts";

export async function syncZernioChannels(
  db: Db,
  numbers: ZernioWhatsappNumber[]
) {
  const now = new Date();
  const synced: WhatsappChannel[] = [];
  for (const n of numbers) {
    const existing = await db.query.whatsappChannels.findFirst({
      where: and(
        eq(whatsappChannels.provider, "zernio"),
        eq(whatsappChannels.providerAccountId, n.account_id)
      ),
    });
    if (existing) {
      const [row] = await db
        .update(whatsappChannels)
        .set({
          phoneE164: n.phone || existing.phoneE164,
          displayName: n.name || n.label || existing.displayName,
          providerNumberId: n.profile_id || existing.providerNumberId,
          status: "online",
          lastSyncAt: now,
          metadata: {
            ...((existing.metadata as object) || {}),
            label: n.label,
          },
          updatedAt: now,
        })
        .where(eq(whatsappChannels.id, existing.id))
        .returning();
      synced.push(row);
    } else {
      const [row] = await db
        .insert(whatsappChannels)
        .values({
          provider: "zernio",
          providerAccountId: n.account_id,
          providerNumberId: n.profile_id || null,
          phoneE164: n.phone || null,
          displayName: n.name || n.label,
          status: "online",
          purpose: "OTHER",
          isActive: false,
          lastSyncAt: now,
          metadata: { label: n.label },
        })
        .returning();
      synced.push(row);
    }
  }
  return synced;
}

/** Transactional: only one ASSISTANT+active at a time. */
export async function setAssistantChannel(
  db: Db,
  input: {
    providerAccountId: string;
    actorUserId?: string;
    phone?: string;
    displayName?: string;
    profileId?: string;
  }
) {
  return db.transaction(async (tx) => {
    await tx
      .update(whatsappChannels)
      .set({
        purpose: "OTHER",
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(whatsappChannels.purpose, "ASSISTANT"));

    const existing = await tx
      .select()
      .from(whatsappChannels)
      .where(
        and(
          eq(whatsappChannels.provider, "zernio"),
          eq(whatsappChannels.providerAccountId, input.providerAccountId)
        )
      )
      .limit(1);

    let row: WhatsappChannel;
    if (!existing[0]) {
      const [created] = await tx
        .insert(whatsappChannels)
        .values({
          provider: "zernio",
          providerAccountId: input.providerAccountId,
          providerNumberId: input.profileId || null,
          phoneE164: input.phone || null,
          displayName: input.displayName || null,
          status: "online",
          purpose: "ASSISTANT",
          isActive: true,
          lastSyncAt: new Date(),
        })
        .returning();
      row = created;
    } else {
      const [updated] = await tx
        .update(whatsappChannels)
        .set({
          purpose: "ASSISTANT",
          isActive: true,
          phoneE164: input.phone || existing[0].phoneE164,
          displayName: input.displayName || existing[0].displayName,
          providerNumberId: input.profileId || existing[0].providerNumberId,
          status: "online",
          updatedAt: new Date(),
        })
        .where(eq(whatsappChannels.id, existing[0].id))
        .returning();
      row = updated;
    }

    if (input.actorUserId) {
      const { adminAuditLogs } = await import("@/db/schema");
      await tx.insert(adminAuditLogs).values({
        actorUserId: input.actorUserId,
        action: "whatsapp_channel.assistant_set",
        resourceType: "whatsapp_channel",
        resourceId: row.id,
        metadata: {
          provider_account_id: input.providerAccountId,
          phone: input.phone || null,
        },
      });
    }

    return row;
  });
}

export async function getActiveAssistantChannel(db: Db) {
  return db.query.whatsappChannels.findFirst({
    where: and(
      eq(whatsappChannels.purpose, "ASSISTANT"),
      eq(whatsappChannels.isActive, true)
    ),
  });
}

export async function findChannelByProviderAccountId(
  db: Db,
  providerAccountId: string
) {
  return db.query.whatsappChannels.findFirst({
    where: and(
      eq(whatsappChannels.provider, "zernio"),
      eq(whatsappChannels.providerAccountId, providerAccountId)
    ),
  });
}

export async function listChannels(db: Db) {
  return db.query.whatsappChannels.findMany({
    orderBy: (c, { desc }) => [desc(c.isActive), desc(c.updatedAt)],
  });
}

/**
 * Inbound gate: only ASSISTANT+active receives Meu Assessor traffic.
 * If no ASSISTANT is configured yet:
 *   - production → reject
 *   - test/dev → allow bootstrap (channel null) so onboarding still works
 */
export async function resolveInboundAssistantChannel(
  db: Db,
  providerAccountId: string | null
): Promise<
  | { ok: true; channel: WhatsappChannel | null; bootstrap: boolean }
  | { ok: false; reason: "no_assistant" | "not_assistant" }
> {
  const { isProductionEnv } = await import("@/config/env");
  const assistant = await getActiveAssistantChannel(db);

  if (!assistant) {
    if (isProductionEnv()) return { ok: false, reason: "no_assistant" };
    return { ok: true, channel: null, bootstrap: true };
  }

  if (!providerAccountId) {
    return { ok: true, channel: assistant, bootstrap: false };
  }

  if (assistant.providerAccountId === providerAccountId) {
    return { ok: true, channel: assistant, bootstrap: false };
  }

  const incoming = await findChannelByProviderAccountId(db, providerAccountId);
  if (incoming?.purpose === "ASSISTANT" && incoming.isActive) {
    return { ok: true, channel: incoming, bootstrap: false };
  }
  return { ok: false, reason: "not_assistant" };
}

export async function ensureDefaultSubscription(
  db: Db,
  workspaceId: string
) {
  const { plans, subscriptions } = await import("@/db/schema");
  const existing = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.workspaceId, workspaceId),
  });
  if (existing) return existing;

  let plan = await db.query.plans.findFirst({
    where: eq(plans.code, "individual"),
  });
  if (!plan) {
    const [created] = await db
      .insert(plans)
      .values({
        code: "individual",
        name: "Individual",
        status: "active",
        limitsJson: { messages: 1000 },
        featuresJson: { whatsapp: true },
      })
      .returning();
    plan = created;
  }

  const [sub] = await db
    .insert(subscriptions)
    .values({
      workspaceId,
      planId: plan.id,
      status: "trialing",
      provider: "manual",
      trialEndsAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
      currentPeriodStart: new Date(),
    })
    .returning();
  return sub;
}

/** Used by unique index helper in rare races */
export async function countActiveAssistants(db: Db) {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS c
    FROM whatsapp_channels
    WHERE purpose = 'ASSISTANT' AND is_active = true
  `);
  const row = (Array.isArray(rows) ? rows[0] : null) as { c?: number } | null;
  return Number(row?.c ?? 0);
}
