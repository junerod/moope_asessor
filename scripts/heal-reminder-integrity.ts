#!/usr/bin/env tsx
/**
 * Varredura + cura de lembretes que o Assessor confirmou sem gravar.
 *
 * Uso:
 *   npx tsx scripts/heal-reminder-integrity.ts
 *   npx tsx scripts/heal-reminder-integrity.ts --dry-run
 *   npx tsx scripts/heal-reminder-integrity.ts --hours=168
 */
import { getDb, closeDb } from "@/db/client";
import {
  findReminderCreateGaps,
  healReminderCreateGaps,
} from "@/domain/reminder-integrity";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const hoursArg = args.find((a) => a.startsWith("--hours="));
  const sinceHours = hoursArg ? Number(hoursArg.split("=")[1]) : 168;

  const db = getDb();
  try {
    const gaps = await findReminderCreateGaps(db, {
      sinceHours,
      limit: 200,
    });
    console.log(
      JSON.stringify(
        {
          dry_run: dryRun,
          since_hours: sinceHours,
          gaps: gaps.map((g) => ({
            phone: g.phoneE164,
            at: g.messageAt.toISOString(),
            body: g.bodyText.slice(0, 120),
            message_id: g.messageId,
          })),
        },
        null,
        2
      )
    );

    const result = await healReminderCreateGaps(db, {
      sinceHours,
      limit: 200,
      dryRun,
    });
    console.log(JSON.stringify({ result }, null, 2));
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
