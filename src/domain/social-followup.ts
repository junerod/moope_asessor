/**
 * Follow-up social — “cobrar Pedro em 2 dias se não responder”.
 * Cria lembrete com kind followup + título claro.
 */
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { reminders, users } from "@/db/schema";
import { ensureReminderOutbox, reminderOccurrenceKey } from "@/domain/alert-delivery";

function norm(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function looksLikeSocialFollowUp(text: string): boolean {
  const t = norm(text);
  if (!t || t.length > 220) return false;
  // Pagamento, dívida ou reunião com alguém é aviso para a pessoa, não lembrete para o dono.
  if (/\b(pagar|pagamento|deve|reais|reuni[aã]o)\b/.test(t) || /r\$/.test(t)) return false;
  // “Cobrar o Zé” é o portão do aviso, não follow-up. Só fica aqui “em N dias” ou “se não responder”.
  if (
    /\bcobrar\b/.test(t) &&
    !/\bem\s+\d+\s+dias?\b/.test(t) &&
    !/\b(se nao responder|se ele nao|se ela nao)\b/.test(t) &&
    !/^(me lembra de cobrar|lembra de cobrar)\b/.test(t)
  ) {
    return false;
  }
  if (/\b(se nao responder|se ele nao|se ela nao|follow.?up)\b/.test(t)) return true;
  if (/^(me lembra de cobrar|lembra de cobrar)\b/.test(t)) return true;
  if (/\bcobrar\b/.test(t) && /\bem\s+\d+\s+dias?\b/.test(t)) return true;
  return false;
}

function parseDays(text: string): number {
  const t = norm(text);
  const m = t.match(/em\s+(\d+)\s+dias?/);
  if (m) return Math.min(30, Math.max(1, Number(m[1])));
  if (/\bamanha\b/.test(t)) return 1;
  if (/\bdepois de amanha\b/.test(t)) return 2;
  return 2;
}

function parseWho(text: string): string {
  const m = text.match(
    /(?:cobrar|falar com|lembrar)\s+(?:o\s+|a\s+)?([A-Za-zÀ-ÿ]{2,40})/i
  );
  return m?.[1]?.trim() || "a pessoa";
}

export async function handleSocialFollowUp(
  db: Db,
  input: {
    userId: string;
    workspaceId: string;
    text: string;
    timezone?: string;
  }
): Promise<string> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, input.userId),
  });
  const tz = input.timezone || user?.timezone || "America/Sao_Paulo";
  const days = parseDays(input.text);
  const who = parseWho(input.text);
  const fireAt = DateTime.now()
    .setZone(tz)
    .plus({ days })
    .set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
    .toJSDate();

  const title = `Cobrar ${who} (follow-up)`.slice(0, 200);
  const [row] = await db
    .insert(reminders)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      title,
      fireAt,
      timezone: tz,
      status: "scheduled",
      deliveryChannel: "whatsapp",
      payload: {
        kind: "followup",
        note: `Se ${who} não respondeu — cobrar.`,
        social_followup: true,
      },
      nextAttemptAt: fireAt,
    })
    .returning();

  await ensureReminderOutbox(db, {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    title: row.title,
    fireAt: row.fireAt,
    payload: (row.payload || {}) as Record<string, unknown>,
  });
  await db
    .update(reminders)
    .set({
      occurrenceKey: reminderOccurrenceKey(row.id, row.fireAt),
      updatedAt: new Date(),
    })
    .where(eq(reminders.id, row.id));

  const when = DateTime.fromJSDate(fireAt).setZone(tz).toFormat("dd/LL · HH:mm");
  return [
    `🤝 *Follow-up social* anotado`,
    `Vou te lembrar de *cobrar ${who}* em *${days} dia(s)*`,
    `🗓️ ${when}`,
    "",
    "_Se ela responder antes, diga “baixa” na lista do dia._",
  ].join("\n");
}
