import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requirePlatformAdminFromAuthHeader } from "@/domain/platform-admin";
import {
  getReliabilitySnapshot,
  runReliabilityAlertTick,
} from "@/domain/reliability-alerts";
import { healReminderCreateGaps } from "@/domain/reminder-integrity";
import { getHeartbeatStatus } from "@/domain/health";

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

  const snapshot = await getReliabilitySnapshot(db);
  const worker = await getHeartbeatStatus(db, "worker");
  const scheduler = await getHeartbeatStatus(db, "scheduler");
  const lastAlert = await getHeartbeatStatus(db, "reliability_alert");

  return NextResponse.json({
    snapshot,
    heartbeats: { worker, scheduler, reliability_alert: lastAlert },
  });
}

export async function POST(req: NextRequest) {
  const db = getDb();
  try {
    const { admin } = await requirePlatformAdminFromAuthHeader(
      db,
      req.headers.get("authorization")
    );
    if (admin.role !== "super_admin") {
      return NextResponse.json({ error: "super_admin_required" }, { status: 403 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json(
      { error: msg },
      { status: msg === "forbidden" ? 403 : 401 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action === "heal") {
    const result = await healReminderCreateGaps(db, {
      sinceHours: 168,
      limit: 100,
    });
    return NextResponse.json({ ok: true, action: "heal", result });
  }
  if (body.action === "alert_check") {
    const result = await runReliabilityAlertTick(db);
    return NextResponse.json({ ok: true, action: "alert_check", result });
  }
  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
