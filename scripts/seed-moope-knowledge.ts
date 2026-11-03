#!/usr/bin/env tsx
import { getDb, closeDb } from "@/db/client";
import { upsertMoopeKnowledgeSeed } from "@/domain/moope-knowledge";

async function main() {
  const db = getDb();
  const result = await upsertMoopeKnowledgeSeed(db);
  console.log("moope_knowledge_seeded", result);
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
