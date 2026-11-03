import { and, eq, isNull, sql } from "drizzle-orm";
import { documentChunks, documents, conversations } from "@/db/schema";
import { getEmbeddingProvider, embeddingToSqlLiteral } from "@/lib/ai/providers";
import { getPrivateObject } from "@/lib/storage/private";
import { registerTool } from "./registry";
import { createZernioClient } from "@/channels/zernio";
import { resolveZernioRuntimeConfig } from "@/domain/providers";

registerTool({
  name: "search_documents",
  description:
    "Busca trechos de documentos do workspace por similaridade semântica.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
  async handler(ctx, args) {
    const query = String(args.query || "").trim();
    const limit = Math.min(Number(args.limit) || 5, 20);
    if (!query) {
      return { ok: false, summary: "Query vazia", errorCode: "empty_query" };
    }
    const embedder = getEmbeddingProvider();
    const [embedding] = await embedder.embed([query]);
    const literal = embeddingToSqlLiteral(embedding);

    const rows = await ctx.db.execute(sql`
      SELECT dc.id, dc.document_id, dc.content, d.original_filename,
        1 - (dc.embedding <=> ${sql.raw(`'${literal}'::vector`)}) AS score
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
      WHERE dc.workspace_id = ${ctx.workspaceId}
        AND dc.deleted_at IS NULL
        AND d.deleted_at IS NULL
        AND dc.embedding IS NOT NULL
      ORDER BY dc.embedding <=> ${sql.raw(`'${literal}'::vector`)}
      LIMIT ${limit}
    `);

    const list = (Array.isArray(rows) ? rows : []) as Array<{
      id: string;
      document_id: string;
      content: string;
      original_filename: string | null;
      score: number;
    }>;

    return {
      ok: true,
      summary: list.length
        ? list
            .map(
              (r) =>
                `[${r.original_filename || r.document_id}] ${r.content.slice(0, 240)}`
            )
            .join("\n---\n")
        : "Não achei documento indexado ainda 📎 Se acabou de mandar a foto, me reenvie ou diga 'resume o documento'.",
      data: { results: list },
    };
  },
});

registerTool({
  name: "summarize_document",
  description:
    "Resume o documento relacionado ao turno atual. Se não houver documento inequívoco, pede clarificação.",
  inputSchema: {
    type: "object",
    properties: {
      document_id: { type: "string" },
    },
  },
  async handler(ctx, args) {
    const documentId =
      (args.document_id ? String(args.document_id) : null) ||
      ctx.relatedDocumentId ||
      null;

    if (!documentId) {
      return {
        ok: false,
        summary:
          "Não identifiquei qual PDF resumir. Envie o arquivo novamente ou diga o nome do documento.",
        errorCode: "ambiguous_document",
      };
    }

    const doc = await ctx.db.query.documents.findFirst({
      where: and(
        eq(documents.id, documentId),
        eq(documents.workspaceId, ctx.workspaceId),
        isNull(documents.deletedAt)
      ),
    });
    if (!doc) {
      return {
        ok: false,
        summary: "Documento não encontrado neste workspace.",
        errorCode: "not_found",
      };
    }

    const chunks = await ctx.db.query.documentChunks.findMany({
      where: and(
        eq(documentChunks.documentId, doc.id),
        eq(documentChunks.workspaceId, ctx.workspaceId),
        isNull(documentChunks.deletedAt)
      ),
      orderBy: (c, { asc }) => [asc(c.chunkIndex)],
      limit: 20,
    });

    const text = chunks.map((c) => c.content).join("\n");
    if (!text) {
      return {
        ok: false,
        summary: "Documento ainda sem texto extraído.",
        errorCode: "not_ready",
      };
    }

    const summary = text.length > 800 ? `${text.slice(0, 800)}…` : text;

    return {
      ok: true,
      summary: `Resumo de ${doc.originalFilename || "documento"}:\n${summary}`,
      data: { document_id: doc.id },
    };
  },
});

registerTool({
  name: "resend_document_media",
  description:
    "Reenvia a foto/arquivo do documento mais recente (ou document_id) no WhatsApp. Use quando pedirem 'mostra a imagem/foto da receita'.",
  inputSchema: {
    type: "object",
    properties: {
      document_id: { type: "string" },
      caption: { type: "string" },
    },
  },
  async handler(ctx, args) {
    const rawId = args.document_id ? String(args.document_id).trim() : "";
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const documentId =
      (rawId && uuidRe.test(rawId) ? rawId : null) ||
      ctx.relatedDocumentId ||
      null;

    let doc = documentId
      ? await ctx.db.query.documents.findFirst({
          where: and(
            eq(documents.id, documentId),
            eq(documents.workspaceId, ctx.workspaceId),
            isNull(documents.deletedAt)
          ),
        })
      : null;

    if (!doc && rawId && !uuidRe.test(rawId)) {
      // LLM sometimes passa o filename — busca por nome
      doc = await ctx.db.query.documents.findFirst({
        where: and(
          eq(documents.workspaceId, ctx.workspaceId),
          eq(documents.originalFilename, rawId),
          isNull(documents.deletedAt)
        ),
        orderBy: (d, { desc }) => [desc(d.createdAt)],
      });
    }

    if (!doc) {
      doc = await ctx.db.query.documents.findFirst({
        where: and(
          eq(documents.workspaceId, ctx.workspaceId),
          eq(documents.conversationId, ctx.conversationId),
          isNull(documents.deletedAt)
        ),
        orderBy: (d, { desc }) => [desc(d.createdAt)],
      });
    }
    if (!doc) {
      doc = await ctx.db.query.documents.findFirst({
        where: and(
          eq(documents.workspaceId, ctx.workspaceId),
          isNull(documents.deletedAt)
        ),
        orderBy: (d, { desc }) => [desc(d.createdAt)],
      });
    }
    if (!doc) {
      return {
        ok: false,
        summary:
          "Não achei a foto guardada. Me manda de novo a imagem da receita/nota 📎",
        errorCode: "not_found",
      };
    }

    const conversation = await ctx.db.query.conversations.findFirst({
      where: eq(conversations.id, ctx.conversationId),
    });
    const externalId = conversation?.externalConversationId;
    if (!externalId) {
      return {
        ok: false,
        summary: "Não consegui reenviar a imagem agora (conversa sem canal).",
        errorCode: "no_channel",
      };
    }

    let buffer: Buffer;
    try {
      buffer = await getPrivateObject(doc.storageKey);
    } catch {
      return {
        ok: false,
        summary:
          "Guardei os dados da receita, mas o arquivo da foto não está acessível agora. Posso te dizer o que estava nela pelo texto.",
        errorCode: "storage_missing",
      };
    }

    const mime = (doc.mimeType || "image/jpeg").toLowerCase();
    const filename = doc.originalFilename || "documento.jpg";
    const cfg = await resolveZernioRuntimeConfig(ctx.db);
    const client = createZernioClient({
      mock: cfg.mock,
      apiKey: cfg.apiKey,
      apiUrl: cfg.apiUrl,
      accountId: cfg.accountId,
    });

    const uploaded = await client.uploadMedia({
      buffer,
      filename,
      mimeType: mime,
    });
    if (!uploaded.ok || !uploaded.url) {
      const chunks = await ctx.db.query.documentChunks.findMany({
        where: and(
          eq(documentChunks.documentId, doc.id),
          isNull(documentChunks.deletedAt)
        ),
        orderBy: (c, { asc }) => [asc(c.chunkIndex)],
        limit: 5,
      });
      const text = chunks.map((c) => c.content).join("\n").slice(0, 600);
      return {
        ok: true,
        summary: text
          ? `Não consegui reenviar a imagem agora 📎 Pelo que guardei:\n${text}`
          : "Não consegui reenviar a imagem agora. Me manda a foto de novo 📎",
        data: { document_id: doc.id, resent: false },
      };
    }

    const attachmentType = mime.startsWith("audio/")
      ? "audio"
      : mime.startsWith("video/")
        ? "video"
        : mime.includes("pdf")
          ? "file"
          : "image";

    const caption =
      String(args.caption || "").trim() ||
      "Aqui está a foto que você mandou 📎";

    const send = await client.sendMedia({
      conversationId: externalId,
      attachmentUrl: uploaded.url,
      attachmentType,
      message: caption,
      attachmentName: filename,
      idempotencyKey: `resend:${doc.id}:${Date.now()}`,
      accountId: cfg.accountId || undefined,
    });

    if (!send.ok) {
      return {
        ok: false,
        summary:
          "Tentei reenviar a foto, mas o WhatsApp não aceitou agora. Quer que eu te diga o que estava nela?",
        errorCode: "send_failed",
      };
    }

    return {
      ok: true,
      summary: "Pronto ✅ reenviei a foto aqui no chat.",
      data: { document_id: doc.id, resent: true },
    };
  },
});
