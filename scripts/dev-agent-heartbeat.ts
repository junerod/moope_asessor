#!/usr/bin/env tsx
/**
 * Marca o agente Cursor como online (heartbeat).
 * O Assessor usa isso pra dizer "agente de (dev online" vs "fora do ar".
 *
 * Uso: npx tsx scripts/dev-agent-heartbeat.ts
 */
import { getDb, closeDb } from "@/db/client";
import { touchAgentHeartbeat } from "@/domain/dev-ajustes";

async function main() {
  const db = getDb();
  const { at } = await touchAgentHeartbeat(db, "cursor");
  console.log(JSON.stringify({ ok: true, at }));
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
