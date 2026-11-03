import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { memories } from "@/db/schema";
import { getEmbeddingProvider } from "@/lib/ai/providers";
import {
  formatReceiptMoney,
  receiptLine,
  RECEIPT_WINDOW_MS,
  withinReceiptWindow,
} from "@/domain/receipt-undo";
import { registerTool } from "./registry";

const CATEGORY_EMOJI: Record<string, string> = {
  gasolina: "⛽",
  mercado: "🛒",
  correio: "📦",
  farmacia: "💊",
  restaurante: "🍽️",
  transporte: "🚗",
  servico: "🔧",
  saude: "🏥",
  moradia: "🏠",
  salario: "💰",
  freela: "💻",
  vendas: "🛍️",
  outro: "💸",
  receita: "💚",
};

function money(n: number) {
  return formatReceiptMoney(n);
}

function foldLedger(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

async function findLedgerEntry(
  ctx: { db: import("@/db/client").Db; workspaceId: string },
  opts: { id?: string; kind: "expense" | "income"; last?: boolean; phrase?: string }
) {
  const since = new Date(Date.now() - RECEIPT_WINDOW_MS);
  if (opts.id) {
    const row = await ctx.db.query.memories.findFirst({
      where: and(
        eq(memories.id, opts.id),
        eq(memories.workspaceId, ctx.workspaceId),
        eq(memories.sourceType, opts.kind),
        eq(memories.status, "active"),
        isNull(memories.deletedAt),
        gte(memories.createdAt, since)
      ),
    });
    if (!row || !withinReceiptWindow(row.createdAt)) return null;
    return row;
  }
  if (opts.last || opts.phrase) {
    const rows = await ctx.db.query.memories.findMany({
      where: and(
        eq(memories.workspaceId, ctx.workspaceId),
        eq(memories.sourceType, opts.kind),
        eq(memories.status, "active"),
        isNull(memories.deletedAt),
        gte(memories.createdAt, since)
      ),
      orderBy: [desc(memories.createdAt)],
      limit: 30,
    });
    const fresh = rows.filter((row) => withinReceiptWindow(row.createdAt));
    if (opts.phrase) {
      const q = foldLedger(opts.phrase);
      return (
        fresh.find((row) => {
          const meta = (row.metadata || {}) as Record<string, unknown>;
          const hay = `${row.content} ${meta.merchant || ""} ${meta.note || ""} ${meta.category || ""}`;
          return foldLedger(hay).includes(q);
        }) || null
      );
    }
    return fresh[0] || null;
  }
  return null;
}

registerTool({
  name: "undo_last_expense",
  description:
    "Desfaz o último gasto (ou expense_id). Use quando disserem 'desfaz', 'apaga o gasto', 'cancela o lançamento'.",
  inputSchema: {
    type: "object",
    properties: {
      expense_id: { type: "string" },
      phrase: { type: "string" },
    },
  },
  async handler(ctx, args) {
    const row = await findLedgerEntry(ctx, {
      id: args.expense_id ? String(args.expense_id) : undefined,
      kind: "expense",
      phrase: args.phrase ? String(args.phrase) : undefined,
      last: !args.expense_id,
    });
    if (!row) {
      return {
        ok: false,
        summary: "Não achei nada das últimas 24h para desfazer.",
        errorCode: "not_found",
      };
    }
    const meta = (row.metadata || {}) as Record<string, unknown>;
    await ctx.db
      .update(memories)
      .set({
        status: "deleted",
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(memories.id, row.id), eq(memories.workspaceId, ctx.workspaceId)));
    const amount = Number(meta.amount);
    const label = String(meta.merchant || meta.note || meta.category || "gasto");
    return {
      ok: true,
      summary: `Desfiz *${label}*${Number.isFinite(amount) ? ` · ${money(amount)}` : ""}.`,
      data: { expense_id: row.id },
    };
  },
});

registerTool({
  name: "update_expense",
  description:
    "Edita um gasto (valor, categoria, estabelecimento). Sem id, edita o último. Use quando a pessoa corrigir o valor ou a categoria.",
  inputSchema: {
    type: "object",
    properties: {
      expense_id: { type: "string" },
      amount: { type: "number" },
      category: { type: "string" },
      merchant: { type: "string" },
      note: { type: "string" },
      phrase: { type: "string" },
    },
  },
  async handler(ctx, args) {
    const row = await findLedgerEntry(ctx, {
      id: args.expense_id ? String(args.expense_id) : undefined,
      kind: "expense",
      phrase: args.phrase ? String(args.phrase) : undefined,
      last: !args.expense_id,
    });
    if (!row) {
      return {
        ok: false,
        summary: "Não achei nada das últimas 24h para corrigir.",
        errorCode: "not_found",
      };
    }
    const meta = { ...(row.metadata || {}) } as Record<string, unknown>;
    const changes: string[] = [];
    if (typeof args.amount === "number" && Number.isFinite(args.amount) && args.amount > 0) {
      meta.amount = args.amount;
      changes.push(`valor=${money(args.amount)}`);
    }
    if (args.category) {
      meta.category = String(args.category).toLowerCase().trim();
      changes.push(`categoria=${meta.category}`);
    }
    if (args.merchant) {
      meta.merchant = String(args.merchant).trim();
      changes.push(`local=${meta.merchant}`);
    }
    if (args.note) {
      meta.note = String(args.note).trim().slice(0, 300);
      changes.push("nota atualizada");
    }
    if (!changes.length) {
      return { ok: false, summary: "Diga o que mudar (valor, categoria…).", errorCode: "empty" };
    }
    const amount = Number(meta.amount) || 0;
    const category = String(meta.category || "outro");
    const content = [
      `Despesa ${category}: BRL ${amount.toFixed(2)}`,
      meta.merchant ? `em ${meta.merchant}` : null,
      meta.note ? `— ${meta.note}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    await ctx.db
      .update(memories)
      .set({ content, metadata: meta, updatedAt: new Date() })
      .where(and(eq(memories.id, row.id), eq(memories.workspaceId, ctx.workspaceId)));
    const label = String(meta.merchant || meta.note || category);
    const onlyValue = changes.length === 1 && changes[0].startsWith("valor=");
    return {
      ok: true,
      summary: onlyValue
        ? `Atualizei *${label}* para ${money(amount)}.`
        : `Atualizei o gasto: ${changes.join("; ")}`,
      data: { expense_id: row.id, ...meta },
    };
  },
});

registerTool({
  name: "save_income",
  description:
    "Registra uma receita/entrada de dinheiro (salário, freela, venda, pix recebido).",
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "number" },
      category: { type: "string" },
      source: { type: "string" },
      date: { type: "string" },
      note: { type: "string" },
    },
    required: ["amount"],
  },
  async handler(ctx, args) {
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, summary: "Valor inválido", errorCode: "invalid_amount" };
    }
    const category = String(args.category || "receita").toLowerCase().trim();
    const source = args.source ? String(args.source).trim() : "";
    const date = args.date ? String(args.date).trim() : "";
    const note = args.note ? String(args.note).trim() : "";
    const content = [
      `Receita ${category}: BRL ${amount.toFixed(2)}`,
      source && `de ${source}`,
      date && `(${date})`,
      note && `— ${note}`,
    ]
      .filter(Boolean)
      .join(" ");

    const embedder = getEmbeddingProvider();
    const [embedding] = await embedder.embed([content]);
    const [row] = await ctx.db
      .insert(memories)
      .values({
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.userId,
        conversationId: ctx.conversationId,
        type: "fact",
        content,
        sourceType: "income",
        embedding,
        embeddingModel:
          embedder.name === "openai" ? "text-embedding-3-small" : "local",
        status: "active",
        metadata: {
          kind: "income",
          category,
          amount,
          currency: "BRL",
          source: source || null,
          date: date || null,
          note: note || null,
        },
      })
      .returning();

    const emoji = CATEGORY_EMOJI[category] || "💚";
    const label = source || category;
    return {
      ok: true,
      summary: receiptLine(`${emoji} Anotei *${label}*: ${money(amount)}`, "income"),
      data: { income_id: row.id, amount, category },
    };
  },
});

registerTool({
  name: "list_income",
  description: "Lista e soma receitas do período (padrão: mês atual).",
  inputSchema: {
    type: "object",
    properties: {
      month: { type: "string" },
      limit: { type: "number" },
    },
  },
  async handler(ctx, args) {
    const luxon = await import("luxon");
    const tz = ctx.timezone || "America/Sao_Paulo";
    const now = luxon.DateTime.now().setZone(tz);
    let start = now.startOf("month");
    let end = now.endOf("month");
    const monthRaw = args.month ? String(args.month).trim() : "";
    if (/^\d{4}-\d{2}$/.test(monthRaw)) {
      start = luxon.DateTime.fromISO(`${monthRaw}-01`, { zone: tz }).startOf("month");
      end = start.endOf("month");
    }
    const rows = await ctx.db.query.memories.findMany({
      where: and(
        eq(memories.workspaceId, ctx.workspaceId),
        eq(memories.status, "active"),
        eq(memories.sourceType, "income"),
        isNull(memories.deletedAt)
      ),
      orderBy: [desc(memories.createdAt)],
      limit: 200,
    });
    const inPeriod = rows.filter((r) => {
      const meta = (r.metadata || {}) as Record<string, unknown>;
      let when = luxon.DateTime.fromJSDate(r.createdAt).setZone(tz);
      if (typeof meta.date === "string" && meta.date) {
        const iso = luxon.DateTime.fromISO(meta.date, { zone: tz });
        const br = luxon.DateTime.fromFormat(meta.date, "dd/MM/yyyy", { zone: tz });
        if (iso.isValid) when = iso;
        else if (br.isValid) when = br;
      }
      return when >= start && when <= end;
    });
    const limit = Math.min(Number(args.limit) || 40, 80);
    const sliced = inPeriod.slice(0, limit);
    let total = 0;
    const lines: string[] = [];
    for (const r of sliced) {
      const meta = (r.metadata || {}) as Record<string, unknown>;
      const amount = Number(meta.amount);
      if (Number.isFinite(amount)) total += amount;
      lines.push(
        `💚 ${Number.isFinite(amount) ? money(amount) : "?"} · ${meta.category || "receita"}${
          meta.source ? ` · ${meta.source}` : ""
        }`
      );
    }
    const label = start.toFormat("LLLL yyyy", { locale: "pt-BR" });
    if (!sliced.length) {
      return {
        ok: true,
        summary: `Nenhuma receita em ${label}. Diga “recebi 800 do freela”.`,
        data: { total: 0, count: 0 },
      };
    }
    return {
      ok: true,
      summary: [`Em ${label}: *${money(total)}* em ${sliced.length} receita(s)`, ...lines.slice(0, 12)].join(
        "\n"
      ),
      data: { total, count: sliced.length },
    };
  },
});

registerTool({
  name: "undo_last_income",
  description: "Desfaz a última receita registrada.",
  inputSchema: {
    type: "object",
    properties: { income_id: { type: "string" }, phrase: { type: "string" } },
  },
  async handler(ctx, args) {
    const row = await findLedgerEntry(ctx, {
      id: args.income_id ? String(args.income_id) : undefined,
      kind: "income",
      phrase: args.phrase ? String(args.phrase) : undefined,
      last: !args.income_id,
    });
    if (!row) {
      return {
        ok: false,
        summary: "Não achei nada das últimas 24h para desfazer.",
        errorCode: "not_found",
      };
    }
    await ctx.db
      .update(memories)
      .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(memories.id, row.id), eq(memories.workspaceId, ctx.workspaceId)));
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const label = String(meta.source || meta.category || "receita");
    const amount = Number(meta.amount);
    return {
      ok: true,
      summary: `Desfiz *${label}*${Number.isFinite(amount) ? ` · ${money(amount)}` : ""}.`,
      data: { income_id: row.id },
    };
  },
});

registerTool({
  name: "update_income",
  description: "Corrige o valor da receita gravada nas últimas 24h.",
  inputSchema: {
    type: "object",
    properties: {
      income_id: { type: "string" },
      amount: { type: "number" },
      phrase: { type: "string" },
    },
    required: ["amount"],
  },
  async handler(ctx, args) {
    const row = await findLedgerEntry(ctx, {
      id: args.income_id ? String(args.income_id) : undefined,
      kind: "income",
      phrase: args.phrase ? String(args.phrase) : undefined,
      last: !args.income_id,
    });
    if (!row) {
      return {
        ok: false,
        summary: "Não achei nada das últimas 24h para corrigir.",
        errorCode: "not_found",
      };
    }
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, summary: "Valor inválido", errorCode: "invalid_amount" };
    }
    const meta = { ...(row.metadata || {}) } as Record<string, unknown>;
    meta.amount = amount;
    const category = String(meta.category || "receita");
    const source = meta.source ? String(meta.source) : "";
    const content = [`Receita ${category}: BRL ${amount.toFixed(2)}`, source && `de ${source}`]
      .filter(Boolean)
      .join(" ");
    await ctx.db
      .update(memories)
      .set({ content, metadata: meta, updatedAt: new Date() })
      .where(and(eq(memories.id, row.id), eq(memories.workspaceId, ctx.workspaceId)));
    const label = source || category;
    return {
      ok: true,
      summary: `Atualizei *${label}* para ${money(amount)}.`,
      data: { income_id: row.id, amount },
    };
  },
});
