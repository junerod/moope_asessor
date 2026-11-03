import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { memories } from "@/db/schema";
import { getEmbeddingProvider, embeddingToSqlLiteral } from "@/lib/ai/providers";

export async function searchMemoriesHybrid(
  db: Db,
  input: { workspaceId: string; query: string; limit?: number }
) {
  const limit = input.limit ?? 5;
  const embedder = getEmbeddingProvider();
  const [embedding] = await embedder.embed([input.query]);
  const literal = embeddingToSqlLiteral(embedding);

  const rows = await db.execute(sql`
    SELECT id, content, type,
      1 - (embedding <=> ${sql.raw(`'${literal}'::vector`)}) AS score
    FROM memories
    WHERE workspace_id = ${input.workspaceId}
      AND status = 'active'
      AND deleted_at IS NULL
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${sql.raw(`'${literal}'::vector`)}
    LIMIT ${limit}
  `);

  return (Array.isArray(rows) ? rows : []) as Array<{
    id: string;
    content: string;
    type: string;
    score: number;
  }>;
}

export async function assertMemoryWorkspaceIsolation(
  db: Db,
  workspaceId: string,
  memoryId: string
) {
  const row = await db.query.memories.findFirst({
    where: and(
      eq(memories.id, memoryId),
      eq(memories.workspaceId, workspaceId),
      isNull(memories.deletedAt)
    ),
  });
  return Boolean(row);
}
