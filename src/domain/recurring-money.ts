/**
 * Série de dinheiro + teto. Sem extrato de banco.
 */
import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { memories } from "@/db/schema";
import { getTool, type ToolContext } from "@/agent/tools/registry";
import { formatDeskMoney } from "@/domain/desk-router";
import { checkSpendingLimitAlert, sumMonthExpenses } from "@/agent/tools/goals";
import { appendVisualBoard } from "@/domain/visual-board";

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function parseAmount(text: string): number | null {
  const match = String(text || "").match(/(\d{1,6}(?:[.,]\d{1,2})?)/);
  if (!match?.[1]) return null;
  const raw = match[1].includes(",") ? match[1].replace(".", "").replace(",", ".") : match[1];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function money(amount: number): string {
  return formatDeskMoney(`R$ ${amount}`) || `R$ ${amount.toFixed(2).replace(".", ",")}`;
}

export function looksLikeRecurringMoney(text: string): {
  label: string;
  amount: number;
  rule: "monthly" | "weekly";
  count?: number;
} | null {
  const raw = String(text || "").trim();
  const t = fold(raw);
  if (!raw || raw.length > 140) return null;
  if (/\b(cobrar|locadora|locatario)\b/.test(t)) return null;
  const install = raw.match(
    /^(.+?)\s+em\s+(\d{1,2})\s*x\s+(?:de\s+)?(?:r\$\s*)?(\d[\d.,]*)/i
  );
  if (install?.[1] && install[2] && install[3]) {
    const count = Number(install[2]);
    const parcel = parseAmount(install[3]);
    if (!Number.isFinite(count) || count < 2 || count > 60 || parcel == null) return null;
    const label = install[1].replace(/^(a|o|as|os)\s+/i, "").trim();
    if (!label) return null;
    return { label, amount: parcel, rule: "monthly", count };
  }

  const amount = parseAmount(raw);
  if (amount == null) return null;

  if (!/\b(todo mes|todo mês|mensal|toda semana|semanal)\b/.test(t)) return null;
  const label = raw
    .replace(/(?:r\$\s*)?\d[\d.,]*.*$/i, "")
    .replace(/[?.!]/g, "")
    .trim();
  if (!label || label.length < 2) return null;
  return {
    label,
    amount,
    rule: /\btoda semana|semanal\b/.test(t) ? "weekly" : "monthly",
  };
}

export function looksLikeBillAhead(text: string): { label: string; amount: number; when: string } | null {
  const raw = String(text || "").trim();
  const t = fold(raw);
  if (!/\b(ipva|seguro)\b/.test(t)) return null;
  const amount = parseAmount(raw);
  if (amount == null) return null;
  const label = /\bipva\b/.test(t) ? "IPVA" : "Seguro";
  return { label, amount, when: raw };
}

export function looksLikeCeilingAsk(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 80) return false;
  return /como esta o teto|teto do mes|gastos do mes|como estou de gastos/.test(t);
}

export async function answerRecurringMoney(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    text: string;
    timezone: string;
    toolCtx: ToolContext;
  }
): Promise<string | null> {
  if (looksLikeCeilingAsk(input.text)) {
    return answerCeiling(db, input);
  }

  const series = looksLikeRecurringMoney(input.text);
  if (series) {
    await db.insert(memories).values({
      workspaceId: input.workspaceId,
      createdByUserId: input.userId,
      type: "commitment",
      content: `${series.label} ${money(series.amount)} ${series.rule === "weekly" ? "toda semana" : "todo mês"}`,
      sourceType: "recurring_expense",
      status: "active",
      metadata: {
        kind: "recurring_expense",
        label: series.label,
        amount: series.amount,
        rule: series.rule,
        count: series.count || null,
      },
    });
    const tool = getTool("create_reminder");
    if (tool) {
      const fire = DateTime.now().setZone(input.timezone).plus({ days: 1 }).set({
        hour: 9,
        minute: 0,
        second: 0,
        millisecond: 0,
      });
      await tool.handler(input.toolCtx, {
        title: `${series.label} ${money(series.amount)}`,
        fire_at_iso: fire.toUTC().toISO(),
        timezone: input.timezone,
        recurrence_rule: series.rule === "weekly" ? "weekly" : "monthly",
      });
    }
    if (series.count) {
      return `Anotei *${series.label}* em *${series.count}x* de ${money(series.amount)}. Te lembro todo mês.`;
    }
    return `Anotei *${series.label}* de ${money(series.amount)} ${series.rule === "weekly" ? "toda semana" : "todo mês"}.`;
  }

  const bill = looksLikeBillAhead(input.text);
  if (bill) {
    const when = (await import("@/lib/datetime")).parseNaturalDateTime(input.text, input.timezone);
    if (!when?.isValid) {
      return `Que dia vence o *${bill.label}*?`;
    }
    const fire = when.minus({ days: 15 });
    const tool = getTool("create_reminder");
    if (tool) {
      await tool.handler(input.toolCtx, {
        title: `${bill.label} ${money(bill.amount)}`,
        fire_at_iso: fire.toUTC().toISO(),
        timezone: input.timezone,
      });
    }
    return `Te lembro *${bill.label}* ${money(bill.amount)} 15 dias antes.`;
  }

  return null;
}

async function answerCeiling(
  db: Db,
  input: { workspaceId: string; userId: string; timezone: string; toolCtx: ToolContext }
): Promise<string> {
  const { total, monthLabel } = await sumMonthExpenses({
    db,
    workspaceId: input.workspaceId,
    timezone: input.timezone,
  });
  const alert = await checkSpendingLimitAlert(input.toolCtx);
  const avg = await averageLastMonths(db, input.workspaceId, input.timezone);
  const lines = [
    `*${monthLabel}* · ${money(total)}`,
    alert || "",
    avg ? `Média dos últimos meses: ${money(avg)}.` : "",
  ].filter(Boolean);
  const rows = await categoryBars(db, input.workspaceId, input.timezone);
  if (rows.length >= 4) {
    return appendVisualBoard(
      { db, workspaceId: input.workspaceId, userId: input.userId },
      lines.join("\n"),
      {
        kind: "pessoal",
        title: "Teto do mês",
        kpis: [
          { label: "Gasto", value: money(total), tone: total ? "warn" : "ok" },
          { label: "Faixa", value: "70%", tone: "warn" },
        ],
        bars: rows,
        barsTitle: "Por categoria",
        rows: [],
        alerts: [],
        note: "Só este mês. O link vale 24 horas.",
      }
    );
  }
  return lines.join("\n") || "Ainda não tem gasto neste mês.";
}

async function categoryBars(db: Db, workspaceId: string, timezone: string) {
  const tz = timezone || "America/Sao_Paulo";
  const now = DateTime.now().setZone(tz);
  const start = now.startOf("month");
  const end = now.endOf("month");
  const rows = await db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, workspaceId),
      eq(memories.status, "active"),
      eq(memories.sourceType, "expense"),
      isNull(memories.deletedAt)
    ),
    limit: 400,
  });
  const map = new Map<string, number>();
  for (const row of rows) {
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const amount = Number(meta.amount);
    if (!Number.isFinite(amount)) continue;
    let when = DateTime.fromJSDate(row.createdAt).setZone(tz);
    if (typeof meta.date === "string") {
      const iso = DateTime.fromISO(meta.date, { zone: tz });
      if (iso.isValid) when = iso;
    }
    if (when < start || when > end) continue;
    const cat = String(meta.category || "outro");
    map.set(cat, (map.get(cat) || 0) + amount);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value, display: money(value) }));
}

async function averageLastMonths(db: Db, workspaceId: string, timezone: string): Promise<number | null> {
  const tz = timezone || "America/Sao_Paulo";
  const now = DateTime.now().setZone(tz);
  const rows = await db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, workspaceId),
      eq(memories.status, "active"),
      eq(memories.sourceType, "expense"),
      isNull(memories.deletedAt)
    ),
    limit: 800,
  });
  const months = new Map<string, number>();
  for (const row of rows) {
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const amount = Number(meta.amount);
    if (!Number.isFinite(amount)) continue;
    let when = DateTime.fromJSDate(row.createdAt).setZone(tz);
    if (typeof meta.date === "string") {
      const iso = DateTime.fromISO(meta.date, { zone: tz });
      if (iso.isValid) when = iso;
    }
    if (when > now || when < now.minus({ months: 6 })) continue;
    const key = when.toFormat("yyyy-MM");
    months.set(key, (months.get(key) || 0) + amount);
  }
  if (months.size < 2) return null;
  const vals = [...months.values()];
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
