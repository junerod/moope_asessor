/**
 * Reindex document embeddings for a workspace (or all).
 * Idempotent: deletes existing chunks per document then re-embeds.
 *
 * Usage:
 *   npm run embeddings:reindex -- --workspace=<uuid>
 *   npm run embeddings:reindex -- --all
 */
import { eq } from "drizzle-orm";
import { getDb, closeDb } from "@/db/client";
import { documents } from "@/db/schema";
import { processDocumentJob } from "@/domain/documents";
import { logger } from "@/lib/logger";

async function main() {
  const args = process.argv.slice(2);
  const workspaceArg = args.find((a) => a.startsWith("--workspace="));
  const all = args.includes("--all");
  if (!workspaceArg && !all) {
    console.error("Pass --workspace=<uuid> or --all");
    process.exit(1);
  }

  const db = getDb();
  const rows = workspaceArg
    ? await db.query.documents.findMany({
        where: eq(documents.workspaceId, workspaceArg.split("=")[1]),
      })
    : await db.query.documents.findMany({ limit: 5000 });

  let ok = 0;
  let failed = 0;
  for (const doc of rows) {
    try {
      await processDocumentJob(db, doc.id);
      ok += 1;
      logger.info("reindex_doc_ok", { document_id: doc.id, progress: `${ok + failed}/${rows.length}` });
    } catch (err) {
      failed += 1;
      logger.error("reindex_doc_failed", {
        document_id: doc.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(JSON.stringify({ total: rows.length, ok, failed }));
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
