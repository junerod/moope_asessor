import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { conversations, messages } from "@/db/schema";

export type DigestCandidate<T> = T & {
  externalConversationId: string;
  score: number;
  personal?: boolean;
};

/** Um Zap, um resumo. Pessoal ganha; se empatar, fica o com mais conteúdo. */
export function pickRichestByConversation<T>(
  rows: DigestCandidate<T>[]
): DigestCandidate<T>[] {
  const best = new Map<string, DigestCandidate<T>>();
  for (const row of rows) {
    const key = String(row.externalConversationId || "").trim();
    if (!key) continue;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, row);
      continue;
    }
    const rowPersonal = Boolean(row.personal);
    const prevPersonal = Boolean(prev.personal);
    if (rowPersonal && !prevPersonal) {
      best.set(key, row);
      continue;
    }
    if (rowPersonal === prevPersonal && row.score > prev.score) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}

/** Já saiu este digest hoje nesta conversa WhatsApp (qualquer workspace). */
export async function alreadySentDigestOnChat(
  db: Db,
  externalConversationId: string,
  correlationId: string
): Promise<boolean> {
  const ext = String(externalConversationId || "").trim();
  const corr = String(correlationId || "").trim();
  if (!ext || !corr) return false;
  const twins = await db.query.conversations.findMany({
    where: eq(conversations.externalConversationId, ext),
  });
  for (const twin of twins) {
    const prior = await db.query.messages.findFirst({
      where: and(
        eq(messages.conversationId, twin.id),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
        eq(messages.correlationId, corr)
      ),
    });
    if (prior) return true;
  }
  return false;
}

export function reminderShadowsAppointment(
  reminder: { title: string; payload?: unknown },
  appointmentIds: Set<string>,
  appointmentTitles: Set<string>
): boolean {
  const payload = (reminder.payload || {}) as { appointment_id?: string };
  if (payload.appointment_id && appointmentIds.has(String(payload.appointment_id))) {
    return true;
  }
  const title = String(reminder.title || "")
    .replace(/^(lembrete|compromisso)\s*:\s*/i, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return Boolean(title) && appointmentTitles.has(title);
}
