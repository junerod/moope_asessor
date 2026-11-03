/**
 * Assistente pessoal (fora locadora): balanço do mês + insight de gastos.
 */
import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import { memories } from "@/db/schema";
import { maybeAppendReportOffer } from "@/lib/report-pdf";
import { appendVisualBoard, emptyBoard } from "@/domain/visual-board";
import { registerTool } from "./registry";

function moneyBr(n: number) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function loadBySource(
  ctx: { db: import("@/db/client").Db; workspaceId: string; timezone: string },
  sourceType: "expense" | "income",
  month?: string
) {
  const tz = ctx.timezone || "America/Sao_Paulo";
  const now = DateTime.now().setZone(tz);
  let start = now.startOf("month");
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    start = DateTime.fromISO(`${month}-01`, { zone: tz }).startOf("month");
  }
  const end = start.endOf("month");
  const rows = await ctx.db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, ctx.workspaceId),
      eq(memories.status, "active"),
      eq(memories.sourceType, sourceType),
      isNull(memories.deletedAt)
    ),
    orderBy: (m, { desc }) => [desc(m.createdAt)],
    limit: 500,
  });
  const items: Array<{
    date: string;
    category: string;
    amount: number;
    label: string;
  }> = [];
  for (const r of rows) {
    const meta = (r.metadata || {}) as Record<string, unknown>;
    let when = DateTime.fromJSDate(r.createdAt).setZone(tz);
    if (typeof meta.date === "string" && meta.date) {
      const iso = DateTime.fromISO(meta.date, { zone: tz });
      const br = DateTime.fromFormat(meta.date, "dd/MM/yyyy", { zone: tz });
      if (iso.isValid) when = iso;
      else if (br.isValid) when = br;
    }
    if (when < start || when > end) continue;
    const amount = Number(meta.amount);
    if (!Number.isFinite(amount)) continue;
    items.push({
      date: when.toFormat("dd/LL/yyyy"),
      category: String(meta.category || (sourceType === "income" ? "receita" : "outro")),
      amount,
      label: String(
        meta.merchant || meta.source || meta.note || r.content || ""
      ).slice(0, 60),
    });
  }
  return {
    start,
    end,
    label: start.toFormat("LLLL yyyy", { locale: "pt-BR" }),
    monthKey: start.toFormat("yyyy-MM"),
    items,
    total: items.reduce((s, i) => s + i.amount, 0),
  };
}

registerTool({
  name: "monthly_balance",
  description:
    "Balanço pessoal do mês: receitas − despesas = saldo. Use para 'balanço', 'quanto sobrou', 'saldo do mês', 'fechamento'.",
  inputSchema: {
    type: "object",
    properties: {
      month: { type: "string", description: "YYYY-MM opcional" },
    },
  },
  async handler(ctx, args) {
    const month = args.month ? String(args.month).trim() : undefined;
    const expenses = await loadBySource(ctx, "expense", month);
    const income = await loadBySource(ctx, "income", month);
    const balance = income.total - expenses.total;
    const emoji = balance >= 0 ? "✅" : "⚠️";
    const byCat = new Map<string, number>();
    for (const i of expenses.items) {
      byCat.set(i.category, (byCat.get(i.category) || 0) + i.amount);
    }
    const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);

    const text = maybeAppendReportOffer(
      [
        `💼 *Balanço — ${expenses.label}*`,
        "",
        `💚 Receitas: *${moneyBr(income.total)}* (${income.items.length})`,
        `💸 Despesas: *${moneyBr(expenses.total)}* (${expenses.items.length})`,
        `${emoji} Saldo: *${moneyBr(balance)}*`,
        top.length
          ? `\n*Top gastos:*\n${top.map(([c, v]) => `• ${c}: ${moneyBr(v)}`).join("\n")}`
          : "",
        "",
        income.items.length === 0
          ? "_Dica:_ diga “recebi 2000 do salário” pra o balanço ficar completo."
          : "_Dica:_ “me manda o relatório de gastos” → PDF + Excel.",
      ]
        .filter(Boolean)
        .join("\n"),
      400
    );
    const summary = await appendVisualBoard(
      ctx,
      text,
      emptyBoard({
        kind: "pessoal",
        title: `Balanço — ${expenses.label}`,
        org: "Pessoal",
        subtitle: "Receitas, despesas e o que pesou no mês",
        kpis: [
          { label: "Receitas", value: moneyBr(income.total), tone: "ok" },
          { label: "Despesas", value: moneyBr(expenses.total), tone: "warn" },
          {
            label: "Saldo",
            value: moneyBr(balance),
            tone: balance >= 0 ? "ok" : "warn",
          },
          { label: "Lançamentos", value: String(expenses.items.length) },
        ],
        bars: top.map(([c, v]) => ({
          label: c,
          value: v,
          display: moneyBr(v),
        })),
        rows: expenses.items.slice(0, 12).map((i) => ({
          title: i.label || i.category,
          detail: `${i.date} · ${i.category}`,
          value: moneyBr(i.amount),
        })),
        note: "Só os números desta consulta. O link vale 24 horas.",
      })
    );

    return {
      ok: true,
      summary,
      data: {
        income: income.total,
        expenses: expenses.total,
        balance,
        month: expenses.monthKey,
      },
    };
  },
});

registerTool({
  name: "spending_insight",
  description:
    "Insight pessoal de gastos: compara com o mês anterior, destaca categoria campeã e dá uma dica prática. Use para 'como estou de gastos', 'insight', 'onde estou gastando mais'.",
  inputSchema: {
    type: "object",
    properties: {
      month: { type: "string" },
    },
  },
  async handler(ctx, args) {
    const month = args.month ? String(args.month).trim() : undefined;
    const current = await loadBySource(ctx, "expense", month);
    const prevKey = current.start.minus({ months: 1 }).toFormat("yyyy-MM");
    const previous = await loadBySource(ctx, "expense", prevKey);

    const byCat = new Map<string, number>();
    for (const i of current.items) {
      byCat.set(i.category, (byCat.get(i.category) || 0) + i.amount);
    }
    const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    const champ = top[0];
    const delta = current.total - previous.total;
    const pct =
      previous.total > 0 ? Math.round((delta / previous.total) * 100) : null;

    let tip = "Anote cada gasto (foto da nota ou “gastei R$ …”): em 7 dias o insight fica bem mais útil.";
    if (champ && current.total > 0 && champ[1] / current.total >= 0.4) {
      tip = `Quase ${Math.round((champ[1] / current.total) * 100)}% foi em *${champ[0]}*. Quer meta só nessa categoria? Diga “meta de gasto R$ …”`;
    } else if (pct !== null && pct >= 20) {
      tip = `Subiu ${pct}% vs ${previous.label}. Vale revisar o top 3 ou definir uma meta do mês.`;
    } else if (pct !== null && pct <= -10) {
      tip = `Boa: caiu ${Math.abs(pct)}% vs ${previous.label}. Quer travar isso com uma meta?`;
    } else if (current.items.length >= 5) {
      tip = `Ticket médio ${moneyBr(current.total / current.items.length)}. “me manda o relatório” gera PDF + Excel.`;
    }

    const text = [
      `🔎 *Insight de gastos — ${current.label}*`,
      "",
      `• Este mês: *${moneyBr(current.total)}* (${current.items.length} lançamentos)`,
      `• Mês anterior (${previous.label}): *${moneyBr(previous.total)}*`,
      pct === null
        ? "• Sem base no mês passado pra comparar ainda"
        : `• Variação: *${delta >= 0 ? "+" : ""}${moneyBr(delta)}* (${pct >= 0 ? "+" : ""}${pct}%)`,
      champ ? `• Campeã: *${champ[0]}* · ${moneyBr(champ[1])}` : null,
      top.length > 1
        ? `• Em seguida: ${top
            .slice(1, 3)
            .map(([c, v]) => `${c} ${moneyBr(v)}`)
            .join(" · ")}`
        : null,
      "",
      `💡 ${tip}`,
    ]
      .filter(Boolean)
      .join("\n");
    const summary = await appendVisualBoard(
      ctx,
      text,
      emptyBoard({
        kind: "pessoal",
        title: `Gastos — ${current.label}`,
        org: "Pessoal",
        subtitle: "Comparado com o mês anterior",
        kpis: [
          { label: "Este mês", value: moneyBr(current.total), tone: "warn" },
          { label: "Mês anterior", value: moneyBr(previous.total), tone: "muted" },
          {
            label: "Variação",
            value: `${delta >= 0 ? "+" : ""}${moneyBr(delta)}`,
            tone: delta > 0 ? "warn" : "ok",
          },
          {
            label: "Campeã",
            value: champ ? champ[0] : "—",
          },
        ],
        bars: top.slice(0, 6).map(([c, v]) => ({
          label: c,
          value: v,
          display: moneyBr(v),
        })),
        rows: current.items.slice(0, 12).map((i) => ({
          title: i.label || i.category,
          detail: `${i.date} · ${i.category}`,
          value: moneyBr(i.amount),
        })),
        note: "Só os números desta consulta. O link vale 24 horas.",
      })
    );

    return {
      ok: true,
      summary,
      data: {
        current: current.total,
        previous: previous.total,
        delta,
        top_category: champ?.[0] || null,
      },
    };
  },
});
