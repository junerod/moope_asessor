#!/usr/bin/env tsx
/**
 * Lista / reivindica pedidos /ajuste pendentes (DEV master).
 *
 * Uso:
 *   npx tsx scripts/dev-ajustes-pull.ts          # lista pending
 *   npx tsx scripts/dev-ajustes-pull.ts --claim  # marca todos pending → in_progress
 *   npx tsx scripts/dev-ajustes-pull.ts --claim 3
 */
import { getDb, closeDb } from "@/db/client";
import {
  claimAjuste,
  listAjustesHoje,
  listPendingAjustes,
  touchAgentHeartbeat,
} from "@/domain/dev-ajustes";

async function main() {
  const args = process.argv.slice(2);
  const claim = args.includes("--claim");
  const idArg = args.find((a) => /^\d+$/.test(a));
  const db = getDb();
  await touchAgentHeartbeat(db, "cursor");

  if (claim && idArg) {
    const it = await claimAjuste(db, Number(idArg));
    console.log(JSON.stringify({ claimed: it }, null, 2));
    await closeDb();
    return;
  }

  const pending = await listPendingAjustes(db);
  const claimed = [];
  if (claim) {
    for (const it of pending) {
      const c = await claimAjuste(db, it.id);
      if (c) claimed.push(c);
    }
  }

  console.log(
    JSON.stringify(
      {
        pending_count: claim ? 0 : pending.length,
        pending: claim ? [] : pending,
        claimed: claim ? claimed : undefined,
        list_preview: await listAjustesHoje(db),
      },
      null,
      2
    )
  );
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
