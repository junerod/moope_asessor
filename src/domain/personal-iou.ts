/**
 * Vale pessoal. Não mistura com locadora nem com cobrança/aviso.
 */
import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { memories } from "@/db/schema";
import { formatDeskMoney } from "@/domain/desk-router";
import { appendVisualBoard } from "@/domain/visual-board";

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function parseAmount(text: string): number | null {
  const match = String(text || "").match(/(?:r\$\s*)?(\d{1,6}(?:[.,]\d{1,2})?)/i);
  if (!match?.[1]) return null;
  const raw = match[1].includes(",") ? match[1].replace(".", "").replace(",", ".") : match[1];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function cleanName(raw: string): string | null {
  const name = String(raw || "")
    .replace(/[?.!,]/g, "")
    .replace(/^(o|a|os|as|pro|pra|para o|para a|do|da|de)\s+/i, "")
    .trim();
  if (!name || name.length < 2 || name.length > 40) return null;
  if (/^(eu|me|mim|hoje|amanha|reais?)$/i.test(fold(name))) return null;
  return name.replace(/\s+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function looksLikeIouList(text: string): "they" | "i" | null {
  const t = fold(text);
  if (!t || t.length > 80) return null;
  if (/a quem eu devo|o que eu devo|minhas dividas/.test(t)) return "i";
  if (/quem me deve|quem esta me devendo|quem me deve dinheiro/.test(t)) return "they";
  return null;
}

export function looksLikeIouOpen(text: string): { name: string; amount: number; direction: "they" | "i" } | null {
  const raw = String(text || "").trim();
  const t = fold(raw);
  if (!raw || raw.length > 120) return null;
  if (/\b(locadora|locatario|aluguel)\b/.test(t)) return null;
  const amount = parseAmount(raw);
  if (amount == null) return null;

  const lend = raw.match(
    /(?:emprestei|emprestim[oa])\s+(?:r\$\s*)?\d[\d.,]*\s+(?:pro|pra|para o|para a|ao|a|o)\s+([A-Za-zÀ-ÿ]{2,40})/i
  );
  if (lend?.[1]) {
    const name = cleanName(lend[1]);
    return name ? { name, amount, direction: "they" } : null;
  }
  const they = raw.match(
    /(?:o|a)?\s*([A-Za-zÀ-ÿ]{2,40})\s+me deve\s+(?:r\$\s*)?\d/i
  );
  if (they?.[1]) {
    const name = cleanName(they[1]);
    return name ? { name, amount, direction: "they" } : null;
  }
  const iOwe = raw.match(
    /(?:eu\s+)?devo\s+(?:r\$\s*)?\d[\d.,]*\s+(?:pro|pra|para o|para a|ao|a)\s+([A-Za-zÀ-ÿ]{2,40})/i
  );
  if (iOwe?.[1]) {
    const name = cleanName(iOwe[1]);
    return name ? { name, amount, direction: "i" } : null;
  }
  return null;
}

export function looksLikeIouSettle(text: string): { name: string; amount: number | null } | null {
  const raw = String(text || "").trim();
  const t = fold(raw);
  if (!raw || raw.length > 120) return null;
  if (/\b(locadora|locatario|aluguel)\b/.test(t)) return null;
  const match = raw.match(
    /(?:recebi|pagou|quitou|baix[aei])\s+(?:r\$\s*)?(\d[\d.,]*)?\s*(?:reais\s*)?(?:do|da|de)\s+([A-Za-zÀ-ÿ]{2,40})/i
  );
  if (!match?.[2]) return null;
  const name = cleanName(match[2]);
  if (!name) return null;
  const amount = match[1] ? parseAmount(match[1]) : null;
  return { name, amount };
}

type IouRow = {
  id: string;
  name: string;
  amount: number;
  direction: "they" | "i";
  since: string;
};

function readRow(row: { id: string; metadata: unknown; createdAt: Date }): IouRow | null {
  const meta = (row.metadata || {}) as Record<string, unknown>;
  if (meta.kind !== "iou" || meta.status === "settled") return null;
  const amount = Number(meta.amount);
  const name = String(meta.name || "").trim();
  const direction = meta.direction === "i" ? "i" : "they";
  if (!name || !Number.isFinite(amount) || amount <= 0) return null;
  const since = typeof meta.since === "string" ? meta.since : row.createdAt.toISOString();
  return { id: row.id, name, amount, direction, since };
}

async function listOpen(db: Db, workspaceId: string): Promise<IouRow[]> {
  const rows = await db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, workspaceId),
      eq(memories.status, "active"),
      eq(memories.sourceType, "iou"),
      isNull(memories.deletedAt)
    ),
    limit: 200,
  });
  return rows.map(readRow).filter((item): item is IouRow => Boolean(item));
}

function money(amount: number): string {
  return formatDeskMoney(`R$ ${amount}`) || `R$ ${amount.toFixed(2).replace(".", ",")}`;
}

export async function recordIouFromText(
  db: Db,
  input: { workspaceId: string; userId: string; text: string }
): Promise<{ name: string; amount: number; direction: "they" | "i" } | null> {
  const open = looksLikeIouOpen(input.text);
  if (!open) return null;
  await db.insert(memories).values({
    workspaceId: input.workspaceId,
    createdByUserId: input.userId,
    type: "commitment",
    content:
      open.direction === "they"
        ? `${open.name} me deve ${money(open.amount)}`
        : `Eu devo ${money(open.amount)} a ${open.name}`,
    sourceType: "iou",
    status: "active",
    metadata: {
      kind: "iou",
      direction: open.direction,
      name: open.name,
      amount: open.amount,
      status: "open",
      since: new Date().toISOString(),
    },
  });
  return open;
}

export async function answerPersonalIou(
  db: Db,
  input: { workspaceId: string; userId: string; text: string; timezone: string }
): Promise<string | null> {
  const listKind = looksLikeIouList(input.text);
  const open = looksLikeIouOpen(input.text);
  const settle = looksLikeIouSettle(input.text);
  if (!listKind && !open && !settle) return null;

  if (open) {
    await recordIouFromText(db, input);
    return open.direction === "they"
      ? `*${open.name}* me deve ${money(open.amount)}. Diz *desfaz* ou *recebi ${open.amount} do ${open.name}*.`
      : `Eu devo ${money(open.amount)} a *${open.name}*. Diz *desfaz* se errei.`;
  }

  if (settle) {
    const rows = (await listOpen(db, input.workspaceId)).filter(
      (item) => fold(item.name) === fold(settle.name) && item.direction === "they"
    );
    if (!rows.length) {
      return `Não achei vale aberto de *${settle.name}*.`;
    }
    const target = settle.amount
      ? rows.find((item) => item.amount === settle.amount) || rows[0]
      : rows[0];
    const meta = { kind: "iou", status: "settled", name: target.name, amount: target.amount, direction: "they" };
    await db
      .update(memories)
      .set({
        status: "archived",
        metadata: meta,
        updatedAt: new Date(),
      })
      .where(eq(memories.id, target.id));
    return `Baixei o vale de *${target.name}*: ${money(target.amount)}.`;
  }

  const rows = (await listOpen(db, input.workspaceId)).filter(
    (item) => item.direction === listKind
  );
  if (!rows.length) {
    return listKind === "they" ? "Ninguém te deve nada agora." : "Você não deve para ninguém agora.";
  }
  const grouped = new Map<string, { name: string; amount: number; since: string }>();
  for (const row of rows) {
    const key = fold(row.name);
    const cur = grouped.get(key);
    if (cur) cur.amount += row.amount;
    else grouped.set(key, { name: row.name, amount: row.amount, since: row.since });
  }
  const people = [...grouped.values()].sort((a, b) => b.amount - a.amount);
  const total = people.reduce((sum, item) => sum + item.amount, 0);
  const head =
    listKind === "they"
      ? `Te devem ${money(total)}`
      : `Você deve ${money(total)}`;
  const lines = people.slice(0, 2).map((item) => `• *${item.name}* · ${money(item.amount)}`);
  let reply = [head, ...lines].join("\n");
  if (people.length >= 3) {
    reply = await appendVisualBoard(
      { db, workspaceId: input.workspaceId, userId: input.userId },
      reply,
      {
        kind: "pessoal",
        title: listKind === "they" ? "Quem me deve" : "A quem eu devo",
        kpis: [{ label: "Total", value: money(total), tone: "warn" }],
        bars: [],
        rows: [],
        alerts: [],
        table: {
          search: "",
          layout: "cards",
          columns: [
            { key: "nome", label: "Nome" },
            { key: "situacao", label: "Valor" },
          ],
          rows: people.map((item) => ({
            cells: {
              nome: item.name,
              situacao: money(item.amount),
              data: DateTime.fromISO(item.since).isValid
                ? DateTime.fromISO(item.since).setZone(input.timezone).toFormat("dd/LL")
                : "",
            },
          })),
        },
        note: "Só este vale. O link vale 24 horas.",
      }
    );
  }
  return reply;
}
