import type { Db } from "@/db/client";
import { getEnv } from "@/config/env";
import {
  downloadRemoteMediaProtected,
  ingestInboundDocument,
  processDocumentWithText,
} from "@/domain/documents";
import {
  detectVisionDocKind,
  formatVisionForAgent,
  memoryContentFromExtraction,
  parseVisionExtraction,
  visionPromptForKind,
  visionPromptLocadora,
  visionScenePrompt,
  type ExtractedVisionFields,
} from "@/domain/vision-extract";
import { memories } from "@/db/schema";
import { getEmbeddingProvider, resolveTranscriptionProvider, resolveVisionProvider } from "@/lib/ai/providers";
import { resolveProviderSecret } from "@/domain/providers";
import { logger } from "@/lib/logger";

async function resolveZernioApiKey(db: Db): Promise<string | null> {
  return (
    (await resolveProviderSecret(db, "zernio", "api_key")) ||
    getEnv().ZERNIO_API_KEY ||
    null
  );
}

const ALLOWED_MIME = new Set([
  "application/pdf",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "audio/opus",
  "audio/webm",
]);

export type InboundMediaResult =
  | {
      kind: "document";
      documentId: string;
      text?: string;
      extracted?: ExtractedVisionFields | null;
      /** Visão vazia/stub — não inventar com LLM */
      visionUnreadable?: boolean;
    }
  | { kind: "audio"; text: string }
  | { kind: "skipped"; reason: "video" | "unsupported" | "empty" };

function classifyMime(mime: string | null | undefined, contentType: string) {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  if (m && ALLOWED_MIME.has(m)) return m;
  const ct = contentType.toLowerCase();
  if (ct.includes("pdf")) return "application/pdf";
  if (ct.includes("image")) return "image/jpeg";
  if (ct.includes("audio") || ct.includes("voice") || ct.includes("ptt"))
    return "audio/ogg";
  if (ct.includes("video") || m.startsWith("video/")) return "video/unsupported";
  return m || null;
}

function assertSize(mime: string, size: number) {
  const env = getEnv();
  if (mime.startsWith("image/") && size > env.MAX_IMAGE_SIZE_BYTES) {
    throw new Error("MEDIA_TOO_LARGE");
  }
  if (mime.startsWith("audio/") && size > env.MAX_AUDIO_SIZE_BYTES) {
    throw new Error("MEDIA_TOO_LARGE");
  }
  if (
    (mime === "application/pdf" || mime === "text/plain" || mime.includes("word")) &&
    size > env.MAX_DOCUMENT_SIZE_BYTES
  ) {
    throw new Error("MEDIA_TOO_LARGE");
  }
}

async function persistVisionMemory(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
    documentId: string;
    content: string;
    metadata: Record<string, unknown>;
  }
) {
  try {
    const embedder = getEmbeddingProvider();
    const [embedding] = await embedder.embed([input.content]);
    await db.insert(memories).values({
      workspaceId: input.workspaceId,
      createdByUserId: input.userId,
      conversationId: input.conversationId,
      type: "fact",
      content: input.content,
      sourceType: "vision",
      sourceId: input.documentId,
      embedding,
      embeddingModel:
        embedder.name === "openai" ? "text-embedding-3-small" : "local",
      status: "active",
      metadata: input.metadata,
    });
  } catch (err) {
    logger.warn("vision_memory_save_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Download + validate inbound WhatsApp media.
 * Images/PDFs become documents; audio returns transcript text for the agent.
 */
export async function processInboundMedia(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
    messageId?: string | null;
    mediaUrl: string;
    mediaMimeType?: string | null;
    contentType: string;
    caption?: string | null;
    filenameHint?: string | null;
  }
): Promise<InboundMediaResult> {
  const mimeGuess = classifyMime(input.mediaMimeType, input.contentType);
  if (!mimeGuess) {
    logger.warn("inbound_media_mime_rejected", { content_type: input.contentType });
    return { kind: "skipped", reason: "unsupported" };
  }
  if (mimeGuess === "video/unsupported" || mimeGuess.startsWith("video/")) {
    return { kind: "skipped", reason: "video" };
  }
  if (
    mimeGuess.includes("executable") ||
    mimeGuess === "application/octet-stream"
  ) {
    throw new Error("MIME_REJECTED");
  }

  const zernioKey = (await resolveZernioApiKey(db)) || getEnv().ZERNIO_API_KEY;
  const { buffer, mimeType } = await downloadRemoteMediaProtected(input.mediaUrl, {
    authorization: zernioKey || null,
  });
  const mime = classifyMime(mimeType || input.mediaMimeType, input.contentType) || mimeGuess;
  if (mime === "video/unsupported" || mime.startsWith("video/")) {
    return { kind: "skipped", reason: "video" };
  }
  assertSize(mime, buffer.length);

  if (mime.startsWith("audio/")) {
    const provider = await resolveTranscriptionProvider(db);
    const result = await provider.transcribe({ buffer, mimeType: mime });
    return { kind: "audio", text: result.text || "" };
  }

  const filename =
    input.filenameHint ||
    (mime.includes("pdf")
      ? "documento.pdf"
      : mime.startsWith("image/")
        ? "imagem.jpg"
        : "arquivo.bin");

  const { isLocadoraInclusaoPhrase } = await import("@/domain/locadora-intent");
  const locadoraDoc = isLocadoraInclusaoPhrase(input.caption || "");
  const mandaAoMoope =
    locadoraDoc && (mime.startsWith("image/") || mime === "application/pdf");

  const doc = mandaAoMoope
    ? null
    : await ingestInboundDocument(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        filename,
        mimeType: mime,
        buffer,
        caption: input.caption,
      });

  let agentText: string | undefined;
  let extracted: ExtractedVisionFields | null = null;
  let visionUnreadable = false;

  if (mime.startsWith("image/")) {
    try {
      const asked =
        locadoraDoc ||
        /(anota|guarda|salva|lembra|lembre|me avisa|gastei|despesa|boleto|conta|resume|resumo|extrai|quanto|valor|cadastr|registr)/i.test(
          input.caption || ""
        );
      const kind = detectVisionDocKind(input.caption, filename);
      const vision = await resolveVisionProvider(db);
      const described = await vision.describe({
        buffer,
        mimeType: mime,
        prompt: locadoraDoc
          ? visionPromptLocadora()
          : asked
            ? visionPromptForKind(kind)
            : visionScenePrompt(),
      });
      if (described.mocked || !String(described.text || "").trim()) {
        visionUnreadable = true;
      } else if (described.text) {
        extracted = parseVisionExtraction(described.text, kind);
        agentText = formatVisionForAgent(extracted);
        if (doc) {
          await processDocumentWithText(db, doc.id, agentText, {
            sourceType: "vision",
            documentType: extracted.kind,
          });
        }
        const askedToKeep =
          /(anota|guarda|salva|lembra|gastei|despesa|boleto|conta)/i.test(
            input.caption || ""
          );
        if (doc && askedToKeep) {
          const memoryContent = memoryContentFromExtraction(
            extracted,
            input.caption
          );
          await persistVisionMemory(db, {
            workspaceId: input.workspaceId,
            userId: input.userId,
            conversationId: input.conversationId,
            documentId: doc.id,
            content: memoryContent,
            metadata: {
              document_id: doc.id,
              kind: extracted.kind,
              category: extracted.category,
              amount: extracted.amount,
              merchant: extracted.merchant,
              doctor: extracted.doctor,
              medicine: extracted.medicine,
            },
          });
        }
      }
    } catch (err) {
      visionUnreadable = true;
      logger.warn("vision_inline_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    kind: "document",
    documentId: doc?.id,
    text: agentText,
    extracted,
    visionUnreadable: mime.startsWith("image/") ? visionUnreadable : undefined,
    imageBase64: mandaAoMoope ? buffer.toString("base64") : undefined,
    imageMime: mandaAoMoope ? mime : undefined,
    imageName: mandaAoMoope ? filename : undefined,
  };
}
