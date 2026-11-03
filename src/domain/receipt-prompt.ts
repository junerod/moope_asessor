/**
 * Comprovante na hora — após lembrete de conta, pede foto e arquiva.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { memories, users } from "@/db/schema";
import { getEmbeddingProvider } from "@/lib/ai/providers";
import type { ReminderPayload } from "@/lib/reminder-copy";

const PENDING_TTL_MS = 36 * 60 * 60 * 1000; // 36h

export type ReceiptPending = {
  reminder_id: string;
  title: string;
  amount: number | null;
  asked_at: string; // ISO
};

function norm(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Conta / boleto / fatura — dispara pedido de comprovante. */
export function isBillLikeReminder(
  title: string,
  payload?: ReminderPayload | Record<string, unknown> | null
): boolean {
  const p = (payload || {}) as ReminderPayload;
  const kind = String(p.kind || "").toLowerCase();
  if (kind === "conta") return true;
  const t = norm(title);
  return /(conta|boleto|fatura|pagamento|pagar|condominio|luz|agua|internet|telefone|cartao|cartão|aluguel)/i.test(
    t
  );
}

export function receiptCtaLine(): string {
  return "📸 Manda a foto do *comprovante* que eu arquivo — ou diga *já paguei* / *depois*.";
}

export async function getReceiptPending(
  db: Db,
  userId: string
): Promise<ReceiptPending | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const profile = (user?.profileJson || {}) as Record<string, unknown>;
  const raw = profile.receipt_pending as ReceiptPending | null | undefined;
  if (!raw || !raw.reminder_id || !raw.asked_at) return null;
  const asked = Date.parse(raw.asked_at);
  if (!Number.isFinite(asked) || Date.now() - asked > PENDING_TTL_MS) {
    await clearReceiptPending(db, userId);
    return null;
  }
  return {
    reminder_id: String(raw.reminder_id),
    title: String(raw.title || "conta"),
    amount:
      typeof raw.amount === "number" && Number.isFinite(raw.amount)
        ? raw.amount
        : null,
    asked_at: raw.asked_at,
  };
}

export async function setReceiptPending(
  db: Db,
  userId: string,
  pending: Omit<ReceiptPending, "asked_at"> & { asked_at?: string }
): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return;
  const profile = {
    ...((user.profileJson || {}) as Record<string, unknown>),
    receipt_pending: {
      reminder_id: pending.reminder_id,
      title: pending.title.slice(0, 200),
      amount: pending.amount,
      asked_at: pending.asked_at || new Date().toISOString(),
    } satisfies ReceiptPending,
  };
  await db
    .update(users)
    .set({ profileJson: profile, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function clearReceiptPending(
  db: Db,
  userId: string
): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return;
  const profile = {
    ...((user.profileJson || {}) as Record<string, unknown>),
  };
  delete profile.receipt_pending;
  await db
    .update(users)
    .set({ profileJson: profile, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/** “já paguei o telefone” → telefone. “já paguei” sozinho → null (vale o comprovante que estava aberto). */
export function extractPaidSubject(text: string): string | null {
  const t = norm(text);
  const m = t.match(
    /^(?:ja\s+)?(?:paguei|pago|quitei)\s+(?:o|a|os|as|de|do|da|meu|minha)?\s*(.+)$/
  );
  if (!m?.[1]) return null;
  const subject = m[1].replace(/^(?:o|a|os|as|de|do|da|meu|minha)\s+/, "").trim();
  if (!subject || subject.length < 3) return null;
  if (/^(conta|boleto|fatura|isso|ele|ela|sim)$/.test(subject)) return null;
  return subject;
}

export function pendingTitleMatchesSubject(title: string, subject: string): boolean {
  const hay = norm(title);
  const words = norm(subject)
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !/^(conta|pagar|pagamento|boleto|fatura)$/.test(w));
  if (!words.length) return hay.includes(norm(subject));
  return words.every((w) => hay.includes(w));
}

export function looksLikeReceiptPaidText(text: string): boolean {
  const t = norm(text);
  if (!t || t.length > 80) return false;
  if (/^(ja\s+)?paguei\b/.test(t)) return true;
  if (/^paguei\s+(a\s+)?(conta|boleto|fatura)\b/.test(t)) return true;
  if (/^(sem\s+)?comprovante\b/.test(t)) return true;
  if (/^(depois|agora nao|nao tenho|pule|skip)\b/.test(t)) return true;
  if (/^arquivo(u|ado)?\b/.test(t)) return false;
  return false;
}

export function looksLikeReceiptSkip(text: string): boolean {
  const t = norm(text);
  return /^(depois|agora nao|nao tenho|pule|skip|sem comprovante)\b/.test(t);
}

function moneyBr(value: number): string {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

/** Texto: já paguei / depois — sem foto. */
export async function handleReceiptTextTurn(
  db: Db,
  input: { userId: string; workspaceId: string; text: string }
): Promise<string | null> {
  const pending = await getReceiptPending(db, input.userId);
  if (!pending) return null;
  if (!looksLikeReceiptPaidText(input.text)) return null;
  const subject = extractPaidSubject(input.text);
  if (subject && !pendingTitleMatchesSubject(pending.title, subject)) {
    return null;
  }

  await clearReceiptPending(db, input.userId);

  if (looksLikeReceiptSkip(input.text)) {
    return `Ok — deixo *${pending.title}* sem comprovante por agora. Quando tiver a foto, é só mandar.`;
  }

  // "já paguei" sem foto → marca gasto se tiver valor, senão só confirma
  if (pending.amount != null && pending.amount > 0) {
    await archivePaidWithoutPhoto(db, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      pending,
    });
    return `✅ Anotei *${pending.title}* como pago · ${moneyBr(pending.amount)}\n_(sem foto — se mandar o comprovante depois, eu arquivo)_`;
  }

  return `✅ Fechou — marquei *${pending.title}* como pago.\n_(se mandar a foto do comprovante depois, eu arquivo)_`;
}

async function archivePaidWithoutPhoto(
  db: Db,
  input: {
    userId: string;
    workspaceId: string;
    pending: ReceiptPending;
  }
): Promise<void> {
  const amount = input.pending.amount!;
  const content = `Despesa conta: BRL ${amount.toFixed(2)} — ${input.pending.title} (pago sem comprovante)`;
  const embedder = getEmbeddingProvider();
  const [embedding] = await embedder.embed([content]);
  await db.insert(memories).values({
    workspaceId: input.workspaceId,
    createdByUserId: input.userId,
    type: "fact",
    content,
    sourceType: "expense",
    sourceId: input.pending.reminder_id,
    embedding,
    embeddingModel:
      embedder.name === "openai" ? "text-embedding-3-small" : "local",
    status: "active",
    metadata: {
      kind: "expense",
      category: "conta",
      amount,
      currency: "BRL",
      merchant: input.pending.title,
      date: new Date().toISOString().slice(0, 10),
      reminder_id: input.pending.reminder_id,
      receipt: false,
    },
  });
}

/** Foto/PDF chegou enquanto aguardava comprovante. */
export async function handleReceiptMedia(
  db: Db,
  input: {
    userId: string;
    workspaceId: string;
    documentId: string;
    amount?: number | null;
    merchant?: string | null;
    summary?: string | null;
  }
): Promise<string | null> {
  const pending = await getReceiptPending(db, input.userId);
  if (!pending) return null;

  const amount =
    (typeof input.amount === "number" && input.amount > 0
      ? input.amount
      : null) ?? pending.amount;
  const merchant =
    (input.merchant && String(input.merchant).trim()) || pending.title;

  const content = [
    `Comprovante: ${merchant}`,
    amount != null ? `BRL ${amount.toFixed(2)}` : null,
    input.summary ? `— ${String(input.summary).slice(0, 120)}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const embedder = getEmbeddingProvider();
  const [embedding] = await embedder.embed([content]);

  await db.insert(memories).values({
    workspaceId: input.workspaceId,
    createdByUserId: input.userId,
    type: "fact",
    content,
    sourceType: amount != null && amount > 0 ? "expense" : "receipt",
    sourceId: input.documentId,
    embedding,
    embeddingModel:
      embedder.name === "openai" ? "text-embedding-3-small" : "local",
    status: "active",
    metadata: {
      kind: amount != null && amount > 0 ? "expense" : "receipt",
      category: "conta",
      amount: amount,
      currency: "BRL",
      merchant,
      date: new Date().toISOString().slice(0, 10),
      document_id: input.documentId,
      reminder_id: pending.reminder_id,
      reminder_title: pending.title,
      receipt: true,
    },
  });

  await clearReceiptPending(db, input.userId);

  const amountLine =
    amount != null && amount > 0 ? `\n💰 ${moneyBr(amount)}` : "";
  return [
    `🧾 *Comprovante arquivado*`,
    `*${pending.title}*${amountLine}`,
    "",
    "_Foto salva nos seus documentos. Dá pra buscar depois._",
  ].join("\n");
}
