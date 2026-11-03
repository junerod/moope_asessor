import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { databasePing, getHeartbeatStatus } from "@/domain/health";

export async function GET() {
  try {
    const db = getDb();
    await databasePing(db);
    return NextResponse.json({
      ok: true,
      service: "moope-assessor",
      phase: 3,
      database: "ONLINE",
    });
  } catch {
    return NextResponse.json({ ok: false, database: "OFFLINE" }, { status: 503 });
  }
}
