/**
 * Gasto do dia fora do padrão do que a pessoa lançou. Sem banco.
 */
import { and, eq, gte, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { memories } from "@/db/schema";
import { formatDeskMoney } from "@/domain/desk-router";

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function looksLikeAnomalyAsk(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 80) return false;
  return /saiu do padrao|fora do padrao|gasto estranho|gastos estranhos/.test(t);
}

function amountOf(row: { content?: string | null; metadata?: unknown }): number {
  const meta = (row.metadata || {}) as Record<string, unknown>;
  const n = Number(meta.amount ?? meta.value);
  if (Number.isFinite(n) && n > 0) return n;
  const match = String(row.content || "").match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!match) return 0;
  return Number(match[1].replace(",", ".")) || 0;
}

function categoryOf(row: { content?: string | null; metadata?: unknown }): string {
  const meta = (row.metadata || {}) as Record<string, unknown>;
  const raw = String(meta.category || meta.merchant || "").trim();
  if (raw) return raw;
  const content = String(row.content || "");
  const after = content.replace(/.*?r\$\s*[\d.,]+/i, "").replace(/^[\s\-–—:]+/, "").trim();
  return after.slice(0, 40) || "gasto";
}

export async function detectSpendAnomaly(
  db: Db,
  input: { workspaceId: string; timezone: string }
): Promise<string | null> {
  const tz = input.timezone || "America/Sao_Paulo";
  const now = DateTime.now().setZone(tz);
  const todayStart = now.startOf("day").toJSDate();
  const since = now.minus({ days: 14 }).startOf("day").toJSDate();
  const rows = await db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, input.workspaceId),
      eq(memories.sourceType, "expense"),
      isNull(memories.deletedAt),
      gte(memories.createdAt, since)
    ),
    limit: 200,
  });
  const today = rows.filter((row) => row.createdAt && row.createdAt >= todayStart);
  const prior = rows.filter((row) => row.createdAt && row.createdAt < todayStart);
  if (!today.length || prior.length < 2) return null;

  const todayTotal = today.reduce((sum, row) => sum + amountOf(row), 0);
  const priorDays = new Map<string, number>();
  for (const row of prior) {
    if (!row.createdAt) continue;
    const key = DateTime.fromJSDate(row.createdAt).setZone(tz).toFormat("yyyy-LL-dd");
    priorDays.set(key, (priorDays.get(key) || 0) + amountOf(row));
  }
  const dayAvg =
    [...priorDays.values()].reduce((sum, value) => sum + value, 0) / Math.max(priorDays.size, 1);
  if (dayAvg > 0 && todayTotal >= dayAvg * 2 && todayTotal >= 40) {
    const shown = formatDeskMoney(`R$ ${todayTotal}`) || `R$ ${todayTotal}`;
    const usual = formatDeskMoney(`R$ ${dayAvg}`) || `R$ ${dayAvg}`;
    return `Hoje saiu do padrão: *${shown}* (normal ~ ${usual}).`;
  }

  const byCatToday = new Map<string, number>();
  for (const row of today) {
    const cat = fold(categoryOf(row));
    byCatToday.set(cat, (byCatToday.get(cat) || 0) + amountOf(row));
  }
  const byCatPrior = new Map<string, number[]>();
  for (const row of prior) {
    const cat = fold(categoryOf(row));
    const list = byCatPrior.get(cat) || [];
    list.push(amountOf(row));
    byCatPrior.set(cat, list);
  }
  for (const [cat, total] of byCatToday) {
    const hist = byCatPrior.get(cat) || [];
    if (hist.length < 2) continue;
    const avg = hist.reduce((sum, value) => sum + value, 0) / hist.length;
    if (avg > 0 && total >= avg * 2.5 && total >= 30) {
      const shown = formatDeskMoney(`R$ ${total}`) || `R$ ${total}`;
      const usual = formatDeskMoney(`R$ ${avg}`) || `R$ ${avg}`;
      return `Hoje saiu do padrão: *${cat}* ${shown} (normal ~ ${usual}).`;
    }
  }
  return null;
}

export async function answerSpendAnomaly(
  db: Db,
  input: { workspaceId: string; timezone: string; text: string }
): Promise<string | null> {
  if (!looksLikeAnomalyAsk(input.text)) return null;
  const hit = await detectSpendAnomaly(db, input);
  return hit || "Hoje está no padrão do que você lança.";
}
