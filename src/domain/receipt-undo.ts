/**
 * Recibo de 24h: desfaz ou corrige o que acabou de ser gravado.
 * Não apaga o que passou da janela. Não mexe no fuso.
 */
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, memories, reminders } from "@/db/schema";
import { hasExplicitClockTime } from "@/lib/datetime";

export const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ReceiptKind = "expense" | "income" | "appointment" | "reminder";

export function withinReceiptWindow(createdAt: Date, now = Date.now()): boolean {
  const age = now - createdAt.getTime();
  return age >= 0 && age <= RECEIPT_WINDOW_MS;
}

export function formatReceiptMoney(amount: number): string {
  const [ints, dec] = amount.toFixed(2).split(".");
  const grouped = ints.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${grouped},${dec}`;
}

/** Confirma só o que foi gravado. Gasto não leva valor de exemplo. */
export function receiptLine(what: string, kind: ReceiptKind = "expense"): string {
  const base = String(what || "").replace(/\s+$/, "");
  const withDot = /[.!?]$/.test(base) ? base : `${base}.`;
  if (kind === "expense" || kind === "income") return withDot;
  if (kind === "appointment") {
    return `${withDot} Diz *desfaz* se o horário ou o assunto estiver errado.`;
  }
  return `${withDot} Diz *desfaz* se o horário ou o texto estiver errado.`;
}

/** Tira o exemplo fixo que vazava em toda confirmação de gasto. */
export function scrubFakeValueHint(text: string): string {
  const next = String(text || "")
    .replace(/\s*Diz\s+\*?desfaz\*? ou \*?o valor é\s*55\*?\.?/gi, "")
    .replace(/👉\s*ou ajuste:\s*[“"]o valor é\s*612,90[”"]/gi, "👉 ou manda o valor certo")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return next;
}

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function parseAmount(raw: string): number | null {
  const t = String(raw || "").trim();
  if (!t) return null;
  const numeric = t.includes(",")
    ? t.replace(/\./g, "").replace(",", ".")
    : /^\d{1,3}(\.\d{3})+$/.test(t)
      ? t.replace(/\./g, "")
      : t;
  const value = Number(numeric);
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) return null;
  return value;
}

export function spendCategory(label: string): string {
  const t = fold(label);
  if (/almoco|jantar|lanche|restaurante|cafe/.test(t)) return "restaurante";
  if (/mercado|feira|supermercado/.test(t)) return "mercado";
  if (/gasolina|combustivel|etanol|posto/.test(t)) return "gasolina";
  if (/farmacia|remedio/.test(t)) return "farmacia";
  if (/uber|taxi|onibus|transporte/.test(t)) return "transporte";
  return "outro";
}

const SPEND_LABEL =
  "(?:almo[cç]o|jantar|lanche|restaurante|caf[eé]|padaria|mercado|feira|supermercado|gasolina|combust[ií]vel|etanol|posto|farm[aá]cia|rem[eé]dio|uber|t[aá]xi|[oô]nibus|transporte|ifood|delivery|estacionamento|ped[aá]gio|correio|sedex)";

function cleanSpendText(text: string): string {
  return String(text || "")
    .trim()
    .replace(/[.!?…]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function spendFrom(
  amountRaw: string,
  labelRaw: string
): { amount: number; label: string; category: string } | null {
  const amount = parseAmount(amountRaw);
  if (amount == null) return null;
  const label = String(labelRaw || "gasto").replace(/[?.!]+$/g, "").trim() || "gasto";
  return { amount, label, category: spendCategory(label) };
}

/**
 * Lançamento pessoal: “gastei 100 com gasolina” ou só “Mercado 250”.
 * Não é lembrete e não inventa horário.
 */
export function looksLikeSpend(
  text: string
): { amount: number; label: string; category: string } | null {
  const raw = cleanSpendText(text);
  if (!raw || raw.length > 160) return null;
  if (/\b(quanto|extrato|lista de|balan[cç]o|relat[oó]rio)\b/i.test(raw)) return null;

  const verbAmount = raw.match(
    /^(?:eu\s+)?(?:gastei|paguei)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)\s*(?:reais\s*)?(?:(?:no|na|em|de|com|pra|para)\s+(.+))?$/i
  );
  if (verbAmount?.[1]) return spendFrom(verbAmount[1], verbAmount[2] || "gasto");

  const verbLabel = raw.match(
    /^(?:eu\s+)?(?:gastei|paguei)\s+(?:(?:no|na|em|de|com|pra|para)\s+)?(.+?)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)(?:\s*reais)?$/i
  );
  if (verbLabel?.[2]) {
    const label = String(verbLabel[1] || "").trim();
    if (label && label.length <= 40 && !/\d/.test(label)) {
      return spendFrom(verbLabel[2], label);
    }
  }

  if (hasExplicitClockTime(raw)) return null;
  if (
    /\b(me lembra|me lembre|lembrete|me avisa|avise|agendar|marcar|marque|compromisso|reuni[aã]o)\b/i.test(
      raw
    )
  ) {
    return null;
  }

  const labelFirst = raw.match(
    new RegExp(
      `^(?:(?:no|na|em|de|com|pra|para)(?:\\s+[oa])?\\s+)?(${SPEND_LABEL})\\s*[,:\\-–]?\\s*(?:de\\s+|r\\$\\s*)?(\\d+(?:[.,]\\d{1,2})?)(?:\\s*reais)?$`,
      "i"
    )
  );
  if (labelFirst?.[1] && labelFirst[2]) return spendFrom(labelFirst[2], labelFirst[1]);

  const amountFirst = raw.match(
    new RegExp(
      `^(?:r\\$\\s*)?(\\d+(?:[.,]\\d{1,2})?)(?:\\s*reais)?\\s+(?:(?:no|na|em|de|com|pra|para|do|da)\\s+)?(${SPEND_LABEL})$`,
      "i"
    )
  );
  if (amountFirst?.[1] && amountFirst[2]) return spendFrom(amountFirst[1], amountFirst[2]);

  return null;
}

export function looksLikeUndo(text: string): { phrase: string | null } | null {
  const raw = fold(text);
  if (!raw || raw.length > 120) return null;
  const match = raw.match(
    /^(?:desfaz|desfazer|apaga o gasto|cancela o lancamento)(?:\s+(?:(?:o|a|os|as)\s+)?(.+))?$/
  );
  if (!match) return null;
  const phrase = String(match[1] || "").trim();
  return { phrase: phrase || null };
}

export function looksLikeValueFix(
  text: string
): { amount: number; phrase: string | null } | null {
  const raw = fold(text);
  if (!raw || raw.length > 120) return null;
  const match = raw.match(
    /^(?:o\s+)?valor(?:\s+d[oa]\s+(.+?))?\s+e\s*(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)$/
  );
  if (!match?.[2]) return null;
  const amount = parseAmount(match[2]);
  if (amount == null) return null;
  const phrase = String(match[1] || "").trim();
  return { amount, phrase: phrase || null };
}

function matchesPhrase(hay: string, phrase: string | null): boolean {
  if (!phrase) return true;
  return fold(hay).includes(fold(phrase));
}

export async function findNewestReceipt(
  db: Db,
  workspaceId: string,
  phrase: string | null,
  kinds: ReceiptKind[] = ["expense", "income", "appointment", "reminder"]
): Promise<{ kind: ReceiptKind; id: string; createdAt: Date } | null> {
  const since = new Date(Date.now() - RECEIPT_WINDOW_MS);
  const hits: Array<{ kind: ReceiptKind; id: string; createdAt: Date }> = [];

  if (kinds.includes("expense") || kinds.includes("income")) {
    const wanted = kinds.filter((kind) => kind === "expense" || kind === "income");
    const rows = await db.query.memories.findMany({
      where: and(
        eq(memories.workspaceId, workspaceId),
        eq(memories.status, "active"),
        isNull(memories.deletedAt),
        gte(memories.createdAt, since)
      ),
      orderBy: [desc(memories.createdAt)],
      limit: 40,
    });
    for (const row of rows) {
      const source = String(row.sourceType || "");
      if (source !== "expense" && source !== "income") continue;
      if (!wanted.includes(source)) continue;
      if (!withinReceiptWindow(row.createdAt)) continue;
      const meta = (row.metadata || {}) as Record<string, unknown>;
      const hay = `${row.content} ${meta.merchant || ""} ${meta.note || ""} ${meta.category || ""}`;
      if (!matchesPhrase(hay, phrase)) continue;
      hits.push({
        kind: source,
        id: row.id,
        createdAt: row.createdAt,
      });
    }
  }

  if (kinds.includes("appointment")) {
    const rows = await db.query.appointments.findMany({
      where: and(
        eq(appointments.workspaceId, workspaceId),
        eq(appointments.status, "scheduled"),
        isNull(appointments.deletedAt),
        gte(appointments.createdAt, since)
      ),
      orderBy: [desc(appointments.createdAt)],
      limit: 20,
    });
    for (const row of rows) {
      if (!withinReceiptWindow(row.createdAt)) continue;
      if (!matchesPhrase(row.title, phrase)) continue;
      hits.push({ kind: "appointment", id: row.id, createdAt: row.createdAt });
    }
  }

  if (kinds.includes("reminder")) {
    const rows = await db.query.reminders.findMany({
      where: and(
        eq(reminders.workspaceId, workspaceId),
        eq(reminders.status, "scheduled"),
        isNull(reminders.deletedAt),
        gte(reminders.createdAt, since)
      ),
      orderBy: [desc(reminders.createdAt)],
      limit: 20,
    });
    for (const row of rows) {
      if (!withinReceiptWindow(row.createdAt)) continue;
      if (!matchesPhrase(row.title, phrase)) continue;
      hits.push({ kind: "reminder", id: row.id, createdAt: row.createdAt });
    }
  }

  hits.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return hits[0] || null;
}
