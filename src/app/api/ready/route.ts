import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { databasePing, getHeartbeatStatus } from "@/domain/health";

export async function GET() {
  try {
    const db = getDb();
    await databasePing(db);
    const worker = await getHeartbeatStatus(db, "worker");
    const scheduler = await getHeartbeatStatus(db, "scheduler");
    const ready = worker.status === "ONLINE" || process.env.NODE_ENV === "test";
    return NextResponse.json(
      {
        ready,
        database: "ONLINE",
        worker: worker.status,
        scheduler: scheduler.status,
      },
      { status: ready ? 200 : 503 }
    );
  } catch {
    return NextResponse.json({ ready: false }, { status: 503 });
  }
}
