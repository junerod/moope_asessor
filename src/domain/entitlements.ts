import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { plans, subscriptions, usageCounters } from "@/db/schema";
import {
  isPaywallEnforced,
  isWorkspaceWhitelisted,
} from "@/domain/access-whitelist";

function periodKey(d = new Date()) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function incrementUsage(
  db: Db,
  input: { workspaceId: string; metric: string; amount?: number }
) {
  const amount = input.amount ?? 1;
  const key = periodKey();
  await db.execute(sql`
    INSERT INTO usage_counters (workspace_id, period_key, metric, value, updated_at)
    VALUES (${input.workspaceId}, ${key}, ${input.metric}, ${amount}, NOW())
    ON CONFLICT (workspace_id, period_key, metric)
    DO UPDATE SET value = usage_counters.value + ${amount}, updated_at = NOW()
  `);
}

export async function getUsage(
  db: Db,
  workspaceId: string,
  metric?: string
) {
  const key = periodKey();
  if (metric) {
    return db.query.usageCounters.findFirst({
      where: and(
        eq(usageCounters.workspaceId, workspaceId),
        eq(usageCounters.periodKey, key),
        eq(usageCounters.metric, metric)
      ),
    });
  }
  return db.query.usageCounters.findMany({
    where: and(
      eq(usageCounters.workspaceId, workspaceId),
      eq(usageCounters.periodKey, key)
    ),
  });
}

export async function getWorkspaceSubscription(db: Db, workspaceId: string) {
  const sub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.workspaceId, workspaceId),
  });
  if (!sub) return null;
  const plan = await db.query.plans.findFirst({
    where: eq(plans.id, sub.planId),
  });
  return { subscription: sub, plan };
}

export async function canUseFeature(
  db: Db,
  input: { workspaceId: string; feature: string }
): Promise<boolean> {
  if (await isWorkspaceWhitelisted(db, input.workspaceId)) return true;

  const pack = await getWorkspaceSubscription(db, input.workspaceId);
  const paywall = await isPaywallEnforced(db);

  if (!pack) {
    // Sem assinatura: libera só enquanto paywall estiver desligado (homologação).
    return !paywall;
  }

  const status = pack.subscription.status;
  if (status === "comped") return true;
  if (status === "suspended" || status === "cancelled") return false;
  if (status === "past_due" && paywall) return false;

  const features = (pack.plan?.featuresJson || {}) as Record<string, unknown>;
  if (input.feature in features) return Boolean(features[input.feature]);
  return true;
}

export async function getLimit(
  db: Db,
  input: { workspaceId: string; metric: string }
): Promise<number | null> {
  if (await isWorkspaceWhitelisted(db, input.workspaceId)) return null;
  const pack = await getWorkspaceSubscription(db, input.workspaceId);
  if (!pack) return null;
  const limits = (pack.plan?.limitsJson || {}) as Record<string, unknown>;
  const v = limits[input.metric];
  return typeof v === "number" ? v : null;
}

/** Entitlement — whitelist e status comped sempre liberam. */
export async function assertEntitled(
  db: Db,
  input: { workspaceId: string; capability: string }
) {
  return canUseFeature(db, {
    workspaceId: input.workspaceId,
    feature: input.capability,
  });
}
