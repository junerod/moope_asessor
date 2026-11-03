import { and, desc, eq, isNull } from "drizzle-orm";
import { memories } from "@/db/schema";
import { getEmbeddingProvider } from "@/lib/ai/providers";
import { registerTool } from "./registry";

type PendingMeta = {
  kind: "pending_bill";
  entry_type: "expense" | "income";
  amount: number;
  category: string;
  merchant?: string | null;
  due_date?: string | null;
  barcode?: string | null;
  note?: string | null;
  document_id?: string | null;
};

function money(n: number) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

registerTool({
  name: "propose_bill",
  description:
    "Propõe conta a pagar/lançamento a partir de boleto/nota. NÃO grava de verdade — espera confirm_pending_bill.",
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "number" },
      category: { type: "string" },
      merchant: { type: "string" },
      due_date: { type: "string" },
      note: { type: "string" },
      entry_type: { type: "string", description: "expense | income" },
      document_id: { type: "string" },
    },
    required: ["amount"],
  },
  async handler(ctx, args) {
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, summary: "Valor inválido", errorCode: "invalid_amount" };
    }
    const entryType =
      String(args.entry_type || "expense").toLowerCase() === "income"
        ? "income"
        : "expense";
    const category = String(args.category || (entryType === "income" ? "receita" : "conta"))
      .toLowerCase()
      .trim();
    const merchant = args.merchant ? String(args.merchant).trim() : null;
    const due = args.due_date ? String(args.due_date).trim() : null;
    const note = args.note ? String(args.note).trim() : null;
    const documentId =
      (args.document_id ? String(args.document_id) : null) ||
      ctx.relatedDocumentId ||
      null;

    const content = `PENDENTE ${entryType}: ${money(amount)} ${category}${
      merchant ? ` · ${merchant}` : ""
    }${due ? ` vence ${due}` : ""}`;
    const metadata: PendingMeta = {
      kind: "pending_bill",
      entry_type: entryType,
      amount,
      category,
      merchant,
      due_date: due,
      note,
      document_id: documentId,
    };

    // Soft-delete previous pendings in workspace (one active proposal)
    const old = await ctx.db.query.memories.findMany({
      where: and(
        eq(memories.workspaceId, ctx.workspaceId),
        eq(memories.sourceType, "pending_bill"),
        eq(memories.status, "active"),
        isNull(memories.deletedAt)
      ),
      limit: 10,
    });
    for (const o of old) {
      await ctx.db
        .update(memories)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(memories.id, o.id));
    }

    const embedder = getEmbeddingProvider();
    const [embedding] = await embedder.embed([content]);
    const [row] = await ctx.db
      .insert(memories)
      .values({
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.userId,
        conversationId: ctx.conversationId,
        type: "note",
        content,
        sourceType: "pending_bill",
        sourceId: documentId,
        embedding,
        embeddingModel:
          embedder.name === "openai" ? "text-embedding-3-small" : "local",
        status: "active",
        metadata,
      })
      .returning();

    return {
      ok: true,
      summary: [
        `📄 *Confere pra mim?*`,
        ``,
        `• Valor: *${money(amount)}*`,
        `• Tipo: ${entryType === "income" ? "receita" : "conta/gasto"}`,
        `• Categoria: ${category}`,
        merchant ? `• Quem: ${merchant}` : null,
        due ? `• Vencimento: ${due}` : null,
        ``,
        `👉 Responda *sim* pra gravar`,
        `👉 *não* pra cancelar`,
        `👉 ou manda o valor certo`,
      ]
        .filter((l) => l !== null)
        .join("\n"),
      data: { pending_id: row.id, ...metadata },
    };
  },
});

registerTool({
  name: "confirm_pending_bill",
  description:
    "Confirma a conta/boleto pendente e grava como gasto ou receita. Use quando disserem sim, confirma, pode, ok.",
  inputSchema: {
    type: "object",
    properties: {
      pending_id: { type: "string" },
      amount: { type: "number", description: "Opcional: ajustar valor na confirmação" },
      category: { type: "string" },
    },
  },
  async handler(ctx, args) {
    let row = null as Awaited<ReturnType<typeof findPending>>;
    async function findPending(id?: string) {
      if (id) {
        return (
          (await ctx.db.query.memories.findFirst({
            where: and(
              eq(memories.id, id),
              eq(memories.workspaceId, ctx.workspaceId),
              eq(memories.sourceType, "pending_bill"),
              eq(memories.status, "active"),
              isNull(memories.deletedAt)
            ),
          })) || null
        );
      }
      const rows = await ctx.db.query.memories.findMany({
        where: and(
          eq(memories.workspaceId, ctx.workspaceId),
          eq(memories.sourceType, "pending_bill"),
          eq(memories.status, "active"),
          isNull(memories.deletedAt)
        ),
        orderBy: [desc(memories.createdAt)],
        limit: 1,
      });
      return rows[0] || null;
    }
    row = await findPending(args.pending_id ? String(args.pending_id) : undefined);
    if (!row) {
      return {
        ok: false,
        summary: "Não há proposta pendente. Mande a foto do boleto/nota de novo.",
        errorCode: "not_found",
      };
    }
    const meta = { ...(row.metadata || {}) } as PendingMeta;
    if (typeof args.amount === "number" && args.amount > 0) meta.amount = args.amount;
    if (args.category) meta.category = String(args.category).toLowerCase().trim();

    const isIncome = meta.entry_type === "income";
    const content = isIncome
      ? `Receita ${meta.category}: BRL ${meta.amount.toFixed(2)}${
          meta.merchant ? ` de ${meta.merchant}` : ""
        }`
      : `Despesa ${meta.category}: BRL ${meta.amount.toFixed(2)}${
          meta.merchant ? ` em ${meta.merchant}` : ""
        }`;

    const embedder = getEmbeddingProvider();
    const [embedding] = await embedder.embed([content]);
    const [saved] = await ctx.db
      .insert(memories)
      .values({
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.userId,
        conversationId: ctx.conversationId,
        type: "fact",
        content,
        sourceType: isIncome ? "income" : "expense",
        sourceId: meta.document_id || null,
        embedding,
        embeddingModel:
          embedder.name === "openai" ? "text-embedding-3-small" : "local",
        status: "active",
        metadata: {
          kind: isIncome ? "income" : "expense",
          category: meta.category,
          amount: meta.amount,
          currency: "BRL",
          merchant: meta.merchant || null,
          source: meta.merchant || null,
          date: meta.due_date || null,
          document_id: meta.document_id || null,
          from_pending: row.id,
        },
      })
      .returning();

    await ctx.db
      .update(memories)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(memories.id, row.id));

    return {
      ok: true,
      summary: `✅ Confirmado! ${isIncome ? "Receita" : "Gasto"} de *${money(
        meta.amount
      )}* em ${meta.category}${meta.merchant ? ` · ${meta.merchant}` : ""}.`,
      data: { entry_id: saved.id, amount: meta.amount },
    };
  },
});

registerTool({
  name: "reject_pending_bill",
  description: "Cancela a proposta de boleto/conta pendente.",
  inputSchema: {
    type: "object",
    properties: { pending_id: { type: "string" } },
  },
  async handler(ctx, args) {
    const rows = await ctx.db.query.memories.findMany({
      where: and(
        eq(memories.workspaceId, ctx.workspaceId),
        eq(memories.sourceType, "pending_bill"),
        eq(memories.status, "active"),
        isNull(memories.deletedAt)
      ),
      orderBy: [desc(memories.createdAt)],
      limit: 5,
    });
    const row = args.pending_id
      ? rows.find((r) => r.id === String(args.pending_id))
      : rows[0];
    if (!row) {
      return { ok: true, summary: "Não havia proposta pendente." };
    }
    await ctx.db
      .update(memories)
      .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(memories.id, row.id));
    return { ok: true, summary: "Ok, cancelei a proposta. Nada foi lançado." };
  },
});
