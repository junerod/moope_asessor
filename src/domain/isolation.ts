import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  conversations,
  memories,
  messages,
  tasks,
  reminders,
  documents,
  documentChunks,
} from "@/db/schema";

/**
 * Workspace isolation helpers used by tools and tests.
 * Vector / text search MUST filter workspace_id in SQL, never post-filter.
 */
export async function searchMemoriesInWorkspace(
  db: Db,
  input: { workspaceId: string; query: string; limit?: number }
) {
  const rows = await db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, input.workspaceId),
      eq(memories.status, "active"),
      isNull(memories.deletedAt)
    ),
    limit: input.limit ?? 20,
  });
  const q = input.query.toLowerCase();
  return rows.filter((r) => r.content.toLowerCase().includes(q));
}

export async function saveMemoryInWorkspace(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    content: string;
    conversationId?: string | null;
  }
) {
  const [row] = await db
    .insert(memories)
    .values({
      workspaceId: input.workspaceId,
      createdByUserId: input.userId,
      conversationId: input.conversationId ?? null,
      content: input.content,
      status: "active",
    })
    .returning();
  return row;
}

export async function searchTasksInWorkspace(
  db: Db,
  input: { workspaceId: string; query?: string }
) {
  const rows = await db.query.tasks.findMany({
    where: and(
      eq(tasks.workspaceId, input.workspaceId),
      isNull(tasks.deletedAt),
      ne(tasks.status, "cancelled")
    ),
  });
  if (!input.query) return rows;
  const q = input.query.toLowerCase();
  return rows.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      (t.description || "").toLowerCase().includes(q)
  );
}

export async function searchRemindersInWorkspace(
  db: Db,
  input: { workspaceId: string; query?: string }
) {
  const rows = await db.query.reminders.findMany({
    where: and(
      eq(reminders.workspaceId, input.workspaceId),
      isNull(reminders.deletedAt)
    ),
  });
  if (!input.query) return rows;
  const q = input.query.toLowerCase();
  return rows.filter((r) => r.title.toLowerCase().includes(q));
}

export async function searchDocumentChunksInWorkspace(
  db: Db,
  input: { workspaceId: string; query: string; limit?: number }
) {
  // Foundation: lexical filter with workspace_id in WHERE (not post-filter).
  // Vector similarity will replace this once embeddings pipeline is live.
  const rows = await db.query.documentChunks.findMany({
    where: and(
      eq(documentChunks.workspaceId, input.workspaceId),
      isNull(documentChunks.deletedAt)
    ),
    limit: input.limit ?? 50,
  });
  const q = input.query.toLowerCase();
  return rows.filter((c) => c.content.toLowerCase().includes(q));
}

export async function assertMessageBelongsToWorkspace(
  db: Db,
  input: { messageId: string; workspaceId: string }
) {
  const msg = await db.query.messages.findFirst({
    where: and(
      eq(messages.id, input.messageId),
      eq(messages.workspaceId, input.workspaceId)
    ),
  });
  return Boolean(msg);
}

export async function getConversationWorkspace(
  db: Db,
  conversationId: string
) {
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  return conversation?.workspaceId ?? null;
}

export async function createDocumentWithChunk(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    filename: string;
    content: string;
    storageKey: string;
  }
) {
  const [doc] = await db
    .insert(documents)
    .values({
      workspaceId: input.workspaceId,
      uploadedByUserId: input.userId,
      originalFilename: input.filename,
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(input.content, "utf8"),
      storageKey: input.storageKey,
      source: "test",
      status: "indexed",
    })
    .returning();

  const [chunk] = await db
    .insert(documentChunks)
    .values({
      workspaceId: input.workspaceId,
      documentId: doc.id,
      chunkIndex: 0,
      content: input.content,
    })
    .returning();

  return { document: doc, chunk };
}
