import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { documents, documentChunks } from "@/db/schema";
import { putPrivateObject, getPrivateObject } from "@/lib/storage/private";
import {
  getEmbeddingProvider,
  resolveEmbeddingProvider,
  resolveVisionProvider,
} from "@/lib/ai/providers";
import { assertSafeRemoteUrl } from "@/channels/zernio/media";
import { enqueueAgentJob } from "@/domain/jobs";
import { getEnv } from "@/config/env";

async function extractPdfText(buffer: Buffer): Promise<string> {
  const mod: any = await import("pdf-parse");
  // pdf-parse v2 exposes PDFParse class; older versions export a function
  if (typeof mod.PDFParse === "function") {
    const parser = new mod.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return String(result?.text || "").trim();
    } finally {
      await parser.destroy?.();
    }
  }
  const pdfParse = mod.default || mod;
  if (typeof pdfParse !== "function") {
    throw new Error("pdf_parse_unavailable");
  }
  const parsed = await pdfParse(buffer);
  return String(parsed?.text || "").trim();
}

function chunkText(text: string, size = 800, overlap = 100): string[] {
  const chunks: string[] = [];
  if (!text) return chunks;
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += Math.max(size - overlap, 1);
  }
  return chunks;
}

function assertAllowedMime(mimeType: string) {
  const allowed = [
    "application/pdf",
    "text/plain",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    "image/webp",
  ];
  const m = mimeType.toLowerCase().split(";")[0].trim();
  if (!allowed.includes(m)) throw new Error("MIME_REJECTED");
  if (m.includes("executable") || m === "application/x-msdownload") {
    throw new Error("MIME_REJECTED");
  }
}

export async function ingestInboundDocument(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
    messageId?: string | null;
    filename: string;
    mimeType: string;
    buffer: Buffer;
    caption?: string | null;
    sourceType?: string;
  }
) {
  assertAllowedMime(input.mimeType);
  const { folderForNewDocument } = await import("@/domain/doc-folders");
  const folder = folderForNewDocument(input.filename, input.caption);
  const env = getEnv();
  if (input.buffer.length > env.MAX_DOCUMENT_SIZE_BYTES) {
    throw new Error("MEDIA_TOO_LARGE");
  }

  const stored = await putPrivateObject({
    key: `${input.workspaceId}/${Date.now()}_${input.filename}`,
    buffer: input.buffer,
    mimeType: input.mimeType,
  });

  const [doc] = await db
    .insert(documents)
    .values({
      workspaceId: input.workspaceId,
      uploadedByUserId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      originalFilename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: stored.size,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      source: "whatsapp",
      sourceType: input.sourceType || "whatsapp",
      status: "processing",
      classification: folder,
      metadata: { caption: input.caption || null, folder },
    })
    .returning();

  await enqueueAgentJob(db, {
    jobType: "process_document",
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: input.messageId ?? null,
    idempotencyKey: `process_document:${doc.id}`,
    payload: { document_id: doc.id },
  });

  return doc;
}

export async function processDocumentWithText(
  db: Db,
  documentId: string,
  text: string,
  opts?: { sourceType?: string; documentType?: string }
): Promise<void> {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!doc) throw new Error("document_not_found");

  const parts = chunkText(text);
  let embedder;
  try {
    embedder = await resolveEmbeddingProvider(db);
  } catch {
    embedder = getEmbeddingProvider();
  }
  const embeddings = parts.length ? await embedder.embed(parts) : [];
  const model =
    embedder.name === "openai" ? "text-embedding-3-small" : "local";
  const dimensions = embeddings[0]?.length || (model === "local" ? 64 : 1536);

  await db.delete(documentChunks).where(eq(documentChunks.documentId, doc.id));

  for (let i = 0; i < parts.length; i++) {
    await db.insert(documentChunks).values({
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      chunkIndex: i,
      content: parts[i],
      embedding: embeddings[i],
      embeddingModel: model,
      embeddingProvider: embedder.name,
      embeddingDimensions: dimensions,
      metadata: {},
    });
  }

  await db
    .update(documents)
    .set({
      status: "indexed",
      sourceType: opts?.sourceType || doc.sourceType,
      documentType: opts?.documentType || doc.documentType,
      embeddingProvider: embedder.name,
      embeddingDimensions: dimensions,
      metadata: {
        ...((doc.metadata as object) || {}),
        extracted_chars: text.length,
        empty_extraction: !text,
      },
      updatedAt: new Date(),
    })
    .where(eq(documents.id, doc.id));
}

export async function processDocumentJob(
  db: Db,
  documentId: string
): Promise<void> {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!doc) throw new Error("document_not_found");

  try {
    const buffer = await getPrivateObject(doc.storageKey);
    let text = "";
    const mime = (doc.mimeType || "").toLowerCase();

    if (mime.includes("pdf") || doc.originalFilename?.toLowerCase().endsWith(".pdf")) {
      text = await extractPdfText(buffer);
      if (!text) {
        // Empty PDF — try vision/OCR fallback when configured
        try {
          const vision = await resolveVisionProvider(db);
          const described = await vision.describe({
            buffer,
            mimeType: "application/pdf",
            prompt:
              "Este PDF não tem texto extraível. Se houver conteúdo visual legível, descreva-o. Não invente.",
          });
          text = described.text || "";
        } catch {
          text = "";
        }
      }
    } else if (mime.startsWith("image/")) {
      const vision = await resolveVisionProvider(db);
      const described = await vision.describe({ buffer, mimeType: mime });
      text = described.text || "";
    } else {
      text = buffer.toString("utf8");
    }

    await processDocumentWithText(db, documentId, text, {
      sourceType: mime.startsWith("image/") ? "vision" : "document",
      documentType: mime.includes("pdf")
        ? "pdf"
        : mime.startsWith("image/")
          ? "image"
          : "text",
    });
  } catch (err) {
    await db
      .update(documents)
      .set({
        status: "failed",
        metadata: {
          ...((doc.metadata as object) || {}),
          error: err instanceof Error ? err.message : "process_failed",
        },
        updatedAt: new Date(),
      })
      .where(eq(documents.id, doc.id));
    throw err;
  }
}

export async function downloadRemoteMediaProtected(
  url: string,
  opts?: { authorization?: string | null }
): Promise<{ buffer: Buffer; mimeType: string | null }> {
  await assertSafeRemoteUrl(url);
  const headers: Record<string, string> = {};
  if (opts?.authorization) {
    headers.Authorization = opts.authorization.startsWith("Bearer ")
      ? opts.authorization
      : `Bearer ${opts.authorization}`;
  } else {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host.includes("zernio.com")) {
        const key = getEnv().ZERNIO_API_KEY;
        if (key) headers.Authorization = `Bearer ${key}`;
      }
    } catch {
      // ignore
    }
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`media_download_failed:${res.status}`);
  const mimeType = res.headers.get("content-type");
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType };
}

export async function findLatestDocumentForConversation(
  db: Db,
  input: { workspaceId: string; conversationId: string }
) {
  return db.query.documents.findFirst({
    where: and(
      eq(documents.workspaceId, input.workspaceId),
      eq(documents.conversationId, input.conversationId)
    ),
    orderBy: (d, { desc }) => [desc(d.createdAt)],
  });
}
