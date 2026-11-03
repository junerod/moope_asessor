import { and, eq, isNull, sql } from "drizzle-orm";
import { memories } from "@/db/schema";
import { getEmbeddingProvider, embeddingToSqlLiteral } from "@/lib/ai/providers";
import { formatReceiptMoney, receiptLine } from "@/domain/receipt-undo";
import { registerTool } from "./registry";
import { CATEGORY_EMOJI } from "@/domain/vision-extract";

/** Cadastro de grupo, CRM ou família não é fato pessoal do bom dia. */
function looksLikeGroupRoster(content: string): boolean {
  const t = content
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/\b(no|na|do|da|ao|a|pro|para o|para a)\s+grupo\b/.test(t)) return true;
  if (/\bgrupo\s+(de\s+)?(familia|crm|trabalho|contatos?)\b/.test(t)) return true;
  if (
    /\b(adicionei|adiciona|inclui|incluido|incluida|esta|coloquei|removi|tirei|membro)\b/.test(
      t
    ) &&
    /\bgrupo\b/.test(t)
  ) {
    return true;
  }
  if (/\bcrm\b/.test(t) && /\b(grupo|contato|membro|whatsapp|telefone|zap)\b/.test(t)) {
    return true;
  }
  return false;
}

registerTool({
  name: "save_memory",
  description: "Salva uma memória/fato pessoal do usuário no workspace atual.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string" },
      type: {
        type: "string",
        enum: [
          "fact",
          "preference",
          "person",
          "company",
          "decision",
          "commitment",
          "note",
        ],
      },
      source_id: { type: "string" },
      source_type: { type: "string" },
      metadata: { type: "object" },
    },
    required: ["content"],
  },
  async handler(ctx, args) {
    const content = String(args.content || "").trim();
    if (!content) {
      return { ok: false, summary: "Conteúdo vazio", errorCode: "empty_content" };
    }
    if (
      /mensagem pedindo|documento analisado|pela imagem|conte[uú]do da imagem|analisad[oa] pela/i.test(
        content
      )
    ) {
      return {
        ok: true,
        summary: "Isso é conversa, não um fato pra lembrar.",
        data: { skipped: true },
      };
    }
    if (/meu nome|pode ser sempre|me chama de|me chame de|chame de/i.test(content)) {
      return {
        ok: false,
        summary: "Nome não vai para a memória do dia. Peça: meu nome é JUNE.",
        errorCode: "name_is_profile",
      };
    }
    if (looksLikeGroupRoster(content)) {
      return {
        ok: true,
        summary: "Isso fica no grupo, não na memória.",
        data: { skipped: true },
      };
    }
    const type = String(args.type || "note");
    const sourceId = args.source_id ? String(args.source_id) : null;
    const sourceType = args.source_type ? String(args.source_type) : "conversation";
    const metadata =
      args.metadata && typeof args.metadata === "object"
        ? (args.metadata as Record<string, unknown>)
        : {};
    const embedder = getEmbeddingProvider();
    const [embedding] = await embedder.embed([content]);

    const [row] = await ctx.db
      .insert(memories)
      .values({
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.userId,
        conversationId: ctx.conversationId,
        type,
        content,
        sourceType,
        sourceId,
        embedding,
        embeddingModel: embedder.name === "openai" ? "text-embedding-3-small" : "local",
        status: "active",
        metadata,
      })
      .returning();

    return {
      ok: true,
      summary: `Memória salva: ${content}`,
      data: { memory_id: row.id, type },
    };
  },
});

registerTool({
  name: "search_memory",
  description: "Busca memórias do workspace do usuário por similaridade e texto.",
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
      SELECT id, content, type,
        1 - (embedding <=> ${sql.raw(`'${literal}'::vector`)}) AS score
      FROM memories
      WHERE workspace_id = ${ctx.workspaceId}
        AND status = 'active'
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${sql.raw(`'${literal}'::vector`)}
      LIMIT ${limit}
    `);

    const list = (Array.isArray(rows) ? rows : []) as Array<{
      id: string;
      content: string;
      type: string;
      score: number;
    }>;

    let results = list.filter((r) => Number(r.score) > 0.05);
    if (!results.length) {
      const lexical = await ctx.db.query.memories.findMany({
        where: and(
          eq(memories.workspaceId, ctx.workspaceId),
          eq(memories.status, "active"),
          isNull(memories.deletedAt)
        ),
        limit: 50,
      });
      const q = query.toLowerCase();
      results = lexical
        .filter((m) => m.content.toLowerCase().includes(q.split(/\s+/).find((w) => w.length > 3) || q))
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          content: m.content,
          type: m.type,
          score: 0.5,
        }));
      if (!results.length) {
        const tokens = q.split(/\s+/).filter((t) => t.length > 3);
        results = lexical
          .map((m) => ({
            id: m.id,
            content: m.content,
            type: m.type,
            score: tokens.filter((t) => m.content.toLowerCase().includes(t)).length,
          }))
          .filter((m) => m.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      }
    }

    return {
      ok: true,
      summary: results.length
        ? results.map((r) => r.content).join(" | ")
        : "Nenhuma memória encontrada.",
      data: { results },
    };
  },
});

registerTool({
  name: "save_expense",
  description:
    "Registra uma despesa pessoal (gasolina, mercado, correio, etc.) com valor e categoria, ligada ao documento/foto se houver.",
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "number" },
      category: { type: "string" },
      merchant: { type: "string" },
      date: { type: "string" },
      note: { type: "string" },
      document_id: { type: "string" },
      currency: { type: "string" },
    },
    required: ["amount", "category"],
  },
  async handler(ctx, args) {
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, summary: "Valor inválido", errorCode: "invalid_amount" };
    }
    const category = String(args.category || "outro").toLowerCase().trim();
    const merchant = args.merchant ? String(args.merchant).trim() : "";
    const date = args.date ? String(args.date).trim() : "";
    const note = args.note ? String(args.note).trim() : "";
    const documentId =
      (args.document_id ? String(args.document_id) : null) ||
      ctx.relatedDocumentId ||
      null;
    const currency = String(args.currency || "BRL");
    const emoji = CATEGORY_EMOJI[category] || "💸";
    const content = [
      `Despesa ${category}: ${currency} ${amount.toFixed(2)}`,
      merchant && `em ${merchant}`,
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
        sourceType: "expense",
        sourceId: documentId,
        embedding,
        embeddingModel:
          embedder.name === "openai" ? "text-embedding-3-small" : "local",
        status: "active",
        metadata: {
          kind: "expense",
          category,
          amount,
          currency,
          merchant: merchant || null,
          date: date || null,
          document_id: documentId,
        },
      })
      .returning();

    const label = merchant || note || category;
    return {
      ok: true,
      summary: receiptLine(
        `${emoji} Anotei *${label}*: ${formatReceiptMoney(amount)}`,
        "expense"
      ),
      data: { memory_id: row.id, category, amount, document_id: documentId },
    };
  },
});

registerTool({
  name: "list_expenses",
  description:
    "Lista e soma despesas do usuário no período (padrão: mês atual). Use para 'quanto gastei', 'gastos do mês', extrato.",
  inputSchema: {
    type: "object",
    properties: {
      month: { type: "string", description: "YYYY-MM opcional" },
      category: { type: "string" },
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
      start = luxon.DateTime.fromISO(`${monthRaw}-01`, { zone: tz }).startOf(
        "month"
      );
      end = start.endOf("month");
    }
    const categoryFilter = args.category
      ? String(args.category).toLowerCase().trim()
      : "";
    const limit = Math.min(Number(args.limit) || 40, 80);

    const rows = await ctx.db.query.memories.findMany({
      where: and(
        eq(memories.workspaceId, ctx.workspaceId),
        eq(memories.status, "active"),
        eq(memories.sourceType, "expense"),
        isNull(memories.deletedAt)
      ),
      orderBy: (m, { desc }) => [desc(m.createdAt)],
      limit: 200,
    });

    const inPeriod = rows.filter((r) => {
      const meta = (r.metadata || {}) as Record<string, unknown>;
      let when = luxon.DateTime.fromJSDate(r.createdAt).setZone(tz);
      if (typeof meta.date === "string" && meta.date) {
        const iso = luxon.DateTime.fromISO(meta.date, { zone: tz });
        const br = luxon.DateTime.fromFormat(meta.date, "dd/MM/yyyy", {
          zone: tz,
        });
        if (iso.isValid) when = iso;
        else if (br.isValid) when = br;
      }
      if (when < start || when > end) return false;
      if (categoryFilter) {
        const cat = String(meta.category || "").toLowerCase();
        if (cat !== categoryFilter) return false;
      }
      return true;
    });

    const sliced = inPeriod.slice(0, limit);
    let total = 0;
    const byCat: Record<string, number> = {};
    const lines: string[] = [];
    for (const r of sliced) {
      const meta = (r.metadata || {}) as Record<string, unknown>;
      const amount = Number(meta.amount);
      const cat = String(meta.category || "outro");
      const merchant = meta.merchant ? String(meta.merchant) : "";
      if (Number.isFinite(amount)) {
        total += amount;
        byCat[cat] = (byCat[cat] || 0) + amount;
      }
      const emoji = CATEGORY_EMOJI[cat] || "💸";
      lines.push(
        `${emoji} R$ ${Number.isFinite(amount) ? amount.toFixed(2) : "?"} · ${cat}${
          merchant ? ` · ${merchant}` : ""
        }`
      );
    }

    const label = start.toFormat("LLLL yyyy", { locale: "pt-BR" });
    if (!sliced.length) {
      return {
        ok: true,
        summary: `Ainda não anotei nenhum gasto em ${label} 💸 Manda uma nota ou diga “gastei R$ X de mercado”.`,
        data: { total: 0, count: 0, month: start.toFormat("yyyy-MM") },
      };
    }

    const breakdown = Object.entries(byCat)
      .sort((a, b) => b[1] - a[1])
      .map(([c, v]) => `${CATEGORY_EMOJI[c] || "💸"} ${c} R$ ${v.toFixed(2)}`)
      .join(" · ");

    const { maybeAppendReportOffer } = await import("@/lib/report-pdf");
    return {
      ok: true,
      summary: maybeAppendReportOffer(
        [
          `Em ${label}: *R$ ${total.toFixed(2)}* em ${sliced.length} gasto(s)`,
          breakdown ? `Por categoria: ${breakdown}` : null,
          lines.slice(0, 12).join("\n"),
          sliced.length > 12 ? `…e mais ${sliced.length - 12}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        500
      ),
      data: {
        total,
        count: sliced.length,
        month: start.toFormat("yyyy-MM"),
        by_category: byCat,
      },
    };
  },
});

registerTool({
  name: "coach_spending",
  description:
    "Explica como o usuário controla gastos e guarda receitas no Assessor (quando perguntar 'como controlo meus gastos').",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string" },
    },
  },
  async handler(_ctx, args) {
    const topic = String(args.topic || "gastos").toLowerCase();
    if (/receita|rem[eé]dio|m[eé]dico/.test(topic)) {
      return {
        ok: true,
        summary:
          "💊 Pra guardar receita: manda a *foto* aqui. Eu leio médico, remédio e dose. Depois é só perguntar “qual o nome do médico?” ou “mostra a receita”. Também posso te lembrar de tomar o remédio.",
      };
    }
    if (/geral|ajuda|fun[cç]|menu|capac/.test(topic)) {
      return {
        ok: true,
        summary: [
          "Posso te ajudar no WhatsApp assim:",
          "☀️ Briefing — “bom dia” / “o que tenho hoje?”",
          "💸 Cobrar agora — “José me deve R$ 50 cobre ele agora”",
          "📒 Quem me deve — “emprestei 200 pro Lucas” · “quem me deve?”",
          "📅 Livre / choque — “sexta de manhã livre?” · “tem choque na agenda?”",
          "💼 Balanço — “balanço do mês” / “como está o teto”",
          "📄 Relatório — “me manda o relatório” → *PDF + Excel*",
          "💸 Gastos — foto da nota ou “gastei R$ 80…”",
          "🎯 Metas — “quero gastar no máximo R$ 3000” · aviso em 70%",
          "📝 Ata · pasta · atraso — “faz a ata” · “tarefas atrasadas”",
          "🌤️ Tempo — “como está o tempo?”",
          "💱 Câmbio — “cotação do dólar”",
          "🛒 Lista de mercado · 💊 receitas (foto)",
          "",
          "📘 *Manuais:*",
          "acessar: Manual pessoal → https://assessor.moope.com.br/ajuda/pessoal",
          "acessar: Manual locadora → https://assessor.moope.com.br/ajuda/locadora",
          "acessar: Manual Facejus → https://assessor.moope.com.br/ajuda/facejus",
          "acessar: Central de ajuda → https://assessor.moope.com.br/ajuda",
          "",
          "Se sua locadora liberou seu número no MOOPE Gestão de Frotas e Locação:",
          "acessar: Gestão de frotas → https://frotas.moope.com.br",
          "",
          "É só escrever naturalmente. Por onde começamos?",
        ].join("\n"),
      };
    }
    return {
      ok: true,
      summary: [
        "Dois jeitos simples de controlar seus gastos comigo:",
        "1️⃣ Manda a *foto da nota/recibo* (gasolina, mercado, correio…)",
        "2️⃣ Ou escreve: *gastei R$ 80 de gasolina*",
        "Depois: *quanto gastei esse mês?* ou *me manda a planilha* 📊",
        "Receita médica: manda a foto que eu guardo 💊",
      ].join("\n"),
    };
  },
});
