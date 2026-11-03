import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { requirePlatformAdminFromAuthHeader } from "@/domain/platform-admin";
import { webhookEvents } from "@/db/schema";
import { getEnv } from "@/config/env";

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
  const events = await db.query.webhookEvents.findMany({
    orderBy: [desc(webhookEvents.createdAt)],
    limit: 20,
  });
  return NextResponse.json({
    webhook_url: `${getEnv().APP_BASE_URL}/api/webhooks/zernio`,
    events: events.map((e) => ({
      id: e.id,
      event_type: e.eventType,
      status: e.status,
      created_at: e.createdAt,
      processed_at: e.processedAt,
    })),
  });
}
