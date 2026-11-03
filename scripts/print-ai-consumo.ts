#!/usr/bin/env tsx
import { getDb, closeDb } from "@/db/client";
import { formatAiConsumoReport } from "@/domain/ai-consumo";

async function main() {
  const db = getDb();
  const text = await formatAiConsumoReport(db);
  console.log(text);
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
