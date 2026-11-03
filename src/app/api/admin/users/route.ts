import { NextRequest, NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { requirePlatformAdminFromAuthHeader } from "@/domain/platform-admin";
import {
  plans,
  subscriptions,
  users,
  whatsappIdentities,
  workspaces,
} from "@/db/schema";
import { getUsage } from "@/domain/entitlements";

function maskPhone(phone: string | null | undefined) {
  if (!phone) return null;
  return phone.length > 6
    ? `${phone.slice(0, 4)}****${phone.slice(-2)}`
    : "****";
}

export async function GET(req: NextRequest) {
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

  const q = (req.nextUrl.searchParams.get("q") || "").trim().toLowerCase();

  const rows = await db.query.users.findMany({
    where: sql`deleted_at is null`,
    orderBy: [desc(users.createdAt)],
    limit: 500,
  });

  const out = [];
  for (const u of rows) {
    const identity = await db.query.whatsappIdentities.findFirst({
      where: eq(whatsappIdentities.userId, u.id),
    });
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.ownerUserId, u.id),
    });
    let planName: string | null = null;
    let subscriptionStatus: string | null = null;
    if (ws) {
      const sub = await db.query.subscriptions.findFirst({
        where: eq(subscriptions.workspaceId, ws.id),
      });
      if (sub) {
        subscriptionStatus = sub.status;
        const plan = await db.query.plans.findFirst({
          where: eq(plans.id, sub.planId),
        });
        planName = plan?.name ?? null;
      }
    }

    const usageRows = ws ? await getUsage(db, ws.id) : [];
    const usageSummary = Array.isArray(usageRows)
      ? Object.fromEntries(usageRows.map((r) => [r.metric, r.value]))
      : {};

    const phone = identity?.phoneE164 || null;
    const row = {
      id: u.id,
      name: u.name,
      email: u.email,
      whatsapp_masked: maskPhone(phone),
      status: u.accountStatus || u.status,
      plan: planName,
      subscription_status: subscriptionStatus,
      onboarding: identity?.status ?? null,
      created_at: u.createdAt,
      last_activity_at: identity?.lastSeenAt ?? u.updatedAt,
      workspace_id: ws?.id ?? null,
      usage: usageSummary,
    };

    if (q) {
      const hay = [row.name, row.email, row.id, phone, row.whatsapp_masked]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) continue;
    }

    out.push(row);
    if (out.length >= 200) break;
  }

  return NextResponse.json({ users: out, clients: out });
}
