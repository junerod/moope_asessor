import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { processHeartbeats } from "@/db/schema";
import { getEnv } from "@/config/env";

export async function beat(db: Db, processName: string, metadata: Record<string, unknown> = {}) {
  await db
    .insert(processHeartbeats)
    .values({
      processName,
      lastSeenAt: new Date(),
      metadata,
    })
    .onConflictDoUpdate({
      target: processHeartbeats.processName,
      set: {
        lastSeenAt: new Date(),
        metadata,
      },
    });
}

export async function getHeartbeatStatus(db: Db, processName: string) {
  const row = await db.query.processHeartbeats.findFirst({
    where: eq(processHeartbeats.processName, processName),
  });
  if (!row) return { status: "OFFLINE" as const, last_seen_at: null, age_seconds: null };
  const age = Math.floor((Date.now() - row.lastSeenAt.getTime()) / 1000);
  const stale = getEnv().HEARTBEAT_STALE_SECONDS;
  return {
    status: age <= stale ? ("ONLINE" as const) : ("OFFLINE" as const),
    last_seen_at: row.lastSeenAt.toISOString(),
    age_seconds: age,
  };
}

export async function databasePing(db: Db) {
  await db.execute(sql`select 1`);
  return true;
}
