import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { requirePlatformAdminFromAuthHeader } from "@/domain/platform-admin";
import { adminAuditLogs } from "@/db/schema";

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
  const logs = await db.query.adminAuditLogs.findMany({
    orderBy: [desc(adminAuditLogs.createdAt)],
    limit: 100,
  });
  return NextResponse.json({ logs });
}
