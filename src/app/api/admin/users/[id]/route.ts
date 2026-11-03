import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { requirePlatformAdminFromAuthHeader } from "@/domain/platform-admin";
import {
  agentJobs,
  consentAcceptances,
  plans,
  subscriptions,
  users,
  whatsappIdentities,
  workspaces,
} from "@/db/schema";
import { getUsage } from "@/domain/entitlements";

function mask(value: string | null | undefined, keep = 4) {
  if (!value) return null;
  if (value.length <= keep + 2) return "****";
  return `${value.slice(0, keep)}****${value.slice(-2)}`;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const db = getDb();
  try {
    await requirePlatformAdminFromAuthHeader(
      db,
      req.headers.get("authorization")
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json(
      { error: msg },
      { status: msg === "forbidden" ? 403 : 401 }
    );
  }

  const { id } = await ctx.params;
  const user = await db.query.users.findFirst({
    where: eq(users.id, id),
  });
  if (!user || user.deletedAt) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const identities = await db.query.whatsappIdentities.findMany({
    where: eq(whatsappIdentities.userId, user.id),
  });
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.ownerUserId, user.id),
  });

  let subscription = null;
  if (ws) {
    const sub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.workspaceId, ws.id),
    });
    if (sub) {
      const plan = await db.query.plans.findFirst({
        where: eq(plans.id, sub.planId),
      });
      subscription = {
        id: sub.id,
        status: sub.status,
        plan: plan ? { id: plan.id, code: plan.code, name: plan.name } : null,
        trial_ends_at: sub.trialEndsAt,
        current_period_start: sub.currentPeriodStart,
        current_period_end: sub.currentPeriodEnd,
        provider: sub.provider,
      };
    }
  }

  const consents = await db.query.consentAcceptances.findMany({
    where: eq(consentAcceptances.userId, user.id),
  });

  const failedJobs = ws
    ? await db.query.agentJobs.findMany({
        where: eq(agentJobs.workspaceId, ws.id),
        limit: 20,
      })
    : [];
  const failed = failedJobs.filter(
    (j) => j.status === "failed" || j.deadAt != null
  );

  const usage = ws ? await getUsage(db, ws.id) : [];

  return NextResponse.json({
    account: {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.accountStatus || user.status,
      created_at: user.createdAt,
      last_activity_at:
        identities[0]?.lastSeenAt ?? user.updatedAt,
    },
    whatsapp: identities.map((i) => ({
      phone_masked: mask(i.phoneE164),
      bsuid_masked: mask(i.bsuid, 6),
      status: i.status,
      paired_at: i.pairedAt,
      provider: "zernio",
    })),
    plan: subscription,
    usage: Array.isArray(usage)
      ? Object.fromEntries(usage.map((r) => [r.metric, r.value]))
      : {},
    consents: consents.map((c) => ({
      terms_version: c.termsVersion,
      privacy_version: c.privacyVersion,
      accepted_at: c.acceptedAt,
      channel: c.channel,
    })),
    operation: {
      failed_jobs: failed.slice(0, 5).map((j) => ({
        id: j.id,
        job_type: j.jobType,
        status: j.status,
        last_error: j.lastError,
        dead_at: j.deadAt,
      })),
    },
    workspace_id: ws?.id ?? null,
  });
}
