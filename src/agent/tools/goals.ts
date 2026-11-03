import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import { memories } from "@/db/schema";
import { registerTool } from "./registry";
import type { ToolContext } from "./registry";

const CATEGORY_EMOJI: Record<string, string> = {
  gasolina: "⛽",
  mercado: "🛒",
  moradia: "🏠",
  luz: "💡",
  internet: "🌐",
  telefone: "📱",
  farmacia: "💊",
  saude: "🩺",
  transporte: "🚌",
  alimentacao: "🍽️",
  lazer: "🎬",
  outro: "💸",
};

function moneyBr(n: number) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function findGoalMemory(ctx: ToolContext) {
  const rows = await ctx.db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, ctx.workspaceId),
      eq(memories.status, "active"),
      eq(memories.sourceType, "goal"),
      isNull(memories.deletedAt)
    ),
    orderBy: (m, { desc }) => [desc(m.updatedAt)],
    limit: 20,
  });
  return rows.find((r) => {
    const meta = (r.metadata || {}) as Record<string, unknown>;
    return meta.kind === "spending_limit";
  });
}

export async function sumMonthExpenses(
  ctx: { db: ToolContext["db"]; workspaceId: string; timezone: string },
  category?: string
) {
  const tz = ctx.timezone || "America/Sao_Paulo";
  const now = DateTime.now().setZone(tz);
  const start = now.startOf("month");
  const end = now.endOf("month");
  const rows = await ctx.db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, ctx.workspaceId),
      eq(memories.status, "active"),
      eq(memories.sourceType, "expense"),
      isNull(memories.deletedAt)
    ),
    limit: 400,
  });
  let total = 0;
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
    if (category) {
      const cat = String(meta.category || "").toLowerCase();
      if (cat !== category.toLowerCase()) continue;
    }
    const amount = Number(meta.amount);
    if (Number.isFinite(amount)) total += amount;
  }
  return { total, monthLabel: start.toFormat("LLLL yyyy", { locale: "pt-BR" }) };
}

/** Chamado após save_expense — retorna alerta se estourou meta. */
export async function checkSpendingLimitAlert(
  ctx: ToolContext
): Promise<string | null> {
  const goal = await findGoalMemory(ctx);
  if (!goal) return null;
  const meta = (goal.metadata || {}) as Record<string, unknown>;
  const limit = Number(meta.monthly_limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const category =
    typeof meta.category === "string" && meta.category
      ? String(meta.category)
      : undefined;
  const { total, monthLabel } = await sumMonthExpenses(ctx, category);
  const pct = (total / limit) * 100;
  const scope = category
    ? `${CATEGORY_EMOJI[category] || "💸"} ${category}`
    : "gastos do mês";

  if (total > limit) {
    return `🚨 Meta estourada: ${scope} em ${monthLabel}\nGasto ${moneyBr(total)} / limite ${moneyBr(limit)} (*${pct.toFixed(0)}%*)`;
  }
  if (pct >= 80) {
    return `⚠️ Atenção à meta: ${scope}\n${moneyBr(total)} de ${moneyBr(limit)} (*${pct.toFixed(0)}%*)`;
  }
  // Radar ~70%: avisa cedo com dias restantes no mês
  if (pct >= 70) {
    const now = DateTime.now().setZone(ctx.timezone || "America/Sao_Paulo");
    const daysLeft = Math.max(0, Math.ceil(now.endOf("month").diff(now, "days").days));
    return `💸 *Radar de gasto:* você já usou *${pct.toFixed(0)}%* da meta (${moneyBr(total)} / ${moneyBr(limit)}) e ainda faltam *${daysLeft}* dia(s) no mês.`;
  }
  return null;
}

registerTool({
  name: "set_spending_goal",
  description:
    "Define meta/limite mensal de gastos (opcional por categoria). Use para 'quero gastar no máximo X', 'limite de R$ Y', 'meta de gastos'.",
  inputSchema: {
    type: "object",
    properties: {
      monthly_limit: { type: "number" },
      category: { type: "string" },
    },
    required: ["monthly_limit"],
  },
  async handler(ctx, args) {
    const limit = Number(args.monthly_limit);
    if (!Number.isFinite(limit) || limit <= 0) {
      return { ok: false, summary: "Limite inválido", errorCode: "invalid_limit" };
    }
    const category = args.category
      ? String(args.category).toLowerCase().trim()
      : null;
    const content = category
      ? `Meta mensal ${category}: R$ ${limit.toFixed(2)}`
      : `Meta mensal de gastos: R$ ${limit.toFixed(2)}`;

    const existing = await findGoalMemory(ctx);
    if (existing) {
      await ctx.db
        .update(memories)
        .set({
          content,
          metadata: {
            kind: "spending_limit",
            monthly_limit: limit,
            category,
          },
          updatedAt: new Date(),
        })
        .where(eq(memories.id, existing.id));
    } else {
      await ctx.db.insert(memories).values({
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.userId,
        conversationId: ctx.conversationId,
        type: "fact",
        content,
        sourceType: "goal",
        status: "active",
        metadata: {
          kind: "spending_limit",
          monthly_limit: limit,
          category,
        },
      });
    }

    const { total, monthLabel } = await sumMonthExpenses(
      ctx,
      category || undefined
    );
    const pct = limit > 0 ? (total / limit) * 100 : 0;
    const emoji = category ? CATEGORY_EMOJI[category] || "🎯" : "🎯";
    return {
      ok: true,
      summary: [
        `${emoji} Meta salva: *${moneyBr(limit)}*/mês${
          category ? ` em ${category}` : ""
        }`,
        `Em ${monthLabel} você já vai em ${moneyBr(total)} (*${pct.toFixed(0)}%*).`,
        pct >= 100
          ? "🚨 Já passou do limite."
          : pct >= 80
            ? "⚠️ Perto do limite — vou te avisar nos próximos gastos."
            : "Te aviso se chegar em 80% ou estourar.",
      ].join("\n"),
      data: { monthly_limit: limit, category, spent: total },
    };
  },
});

registerTool({
  name: "check_spending_goal",
  description:
    "Consulta progresso da meta de gastos do mês. Use para 'como estou na meta', 'limite do mês'.",
  inputSchema: { type: "object", properties: {} },
  async handler(ctx) {
    const goal = await findGoalMemory(ctx);
    if (!goal) {
      return {
        ok: true,
        summary:
          "Você ainda não tem meta. Ex.: “quero gastar no máximo R$ 3000 esse mês”.",
        data: { has_goal: false },
      };
    }
    const meta = (goal.metadata || {}) as Record<string, unknown>;
    const limit = Number(meta.monthly_limit);
    const category =
      typeof meta.category === "string" && meta.category
        ? String(meta.category)
        : undefined;
    const { total, monthLabel } = await sumMonthExpenses(ctx, category);
    const pct = limit > 0 ? (total / limit) * 100 : 0;
    const bar =
      pct >= 100 ? "🚨" : pct >= 80 ? "⚠️" : pct >= 50 ? "🟡" : "🟢";
    return {
      ok: true,
      summary: [
        `${bar} Meta ${monthLabel}${category ? ` · ${category}` : ""}`,
        `${moneyBr(total)} / ${moneyBr(limit)} (*${pct.toFixed(0)}%*)`,
        `Restante: ${moneyBr(Math.max(0, limit - total))}`,
      ].join("\n"),
      data: { spent: total, limit, pct, category },
    };
  },
});
