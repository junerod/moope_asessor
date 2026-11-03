/**
 * Link público só com horários livres. Quem abre não vê o que já está marcado.
 */
import { randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { appointments, visualBoards } from "@/db/schema";
import { loadDayAgenda } from "@/domain/day-agenda";
import { hourHoles } from "@/domain/agenda-gaps";
import { publicAppBaseUrl } from "@/lib/public-url";
import { appendVisualBoard } from "@/domain/visual-board";
import { ownerPhoneE164 } from "@/domain/external-notice";
import { findConversationForPhone } from "@/domain/family-contacts";
import { sendProactiveMessage } from "@/channels/zernio/proactive";

const LIVRE_TTL_MS = 24 * 60 * 60 * 1000;

export type LivreSlot = { iso: string; label: string };

export type LivreShare = {
  token: string;
  expiresAt: string;
  timezone: string;
  workspaceId: string;
  userId: string;
  slots: LivreSlot[];
};

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function looksLikePublicSlotAsk(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 120) return false;
  return /link pra (a )?pessoa marcar|link para marcar|horarios da semana|me da um link/.test(
    t
  );
}

export function looksLikeTaskReport(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 80) return false;
  return /relatorio de tarefas|pdf das tarefas|excel das tarefas/.test(t);
}

function shareFromPayload(token: string, expiresAt: Date, payload: Record<string, unknown>): LivreShare | null {
  const raw = payload.livre as Record<string, unknown> | undefined;
  if (!raw || !Array.isArray(raw.slots)) return null;
  if (expiresAt.getTime() <= Date.now()) return null;
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    timezone: String(raw.timezone || "America/Sao_Paulo"),
    workspaceId: String(raw.workspaceId || ""),
    userId: String(raw.userId || ""),
    slots: raw.slots.filter((item): item is LivreSlot =>
      Boolean(item && typeof item === "object" && (item as LivreSlot).iso && (item as LivreSlot).label)
    ),
  };
}

async function writeShare(db: Db, share: LivreShare): Promise<void> {
  const existing = await db.query.visualBoards.findFirst({
    where: eq(visualBoards.token, share.token),
  });
  const payload = {
    kind: "pessoal",
    title: "Horários livres",
    livre: {
      timezone: share.timezone,
      workspaceId: share.workspaceId,
      userId: share.userId,
      slots: share.slots,
    },
  };
  if (existing) {
    await db
      .update(visualBoards)
      .set({ payload, expiresAt: new Date(share.expiresAt) })
      .where(eq(visualBoards.id, existing.id));
    return;
  }
  await db.insert(visualBoards).values({
    token: share.token,
    workspaceId: share.workspaceId,
    userId: share.userId,
    payload,
    expiresAt: new Date(share.expiresAt),
  });
}

export async function findLivreShare(db: Db, token: string): Promise<LivreShare | null> {
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(token)) return null;
  const row = await db.query.visualBoards.findFirst({
    where: and(eq(visualBoards.token, token)),
  });
  if (!row) return null;
  return shareFromPayload(token, row.expiresAt, (row.payload || {}) as Record<string, unknown>);
}

export async function buildWeekFreeSlots(
  db: Db,
  input: { workspaceId: string; userId: string; timezone: string }
): Promise<LivreSlot[]> {
  const zone = input.timezone || "America/Sao_Paulo";
  const start = DateTime.now().setZone(zone).startOf("day");
  const slots: LivreSlot[] = [];
  for (let day = 0; day < 5; day += 1) {
    const date = start.plus({ days: day });
    const agenda = await loadDayAgenda(db, input.workspaceId, zone, date.toISODate() || "");
    const busy = agenda.map((item) => ({ at: item.at, title: "ocupado" }));
    const holes = hourHoles(date, 8, 18, busy).filter((item) => item.state === "livre");
    for (const hole of holes) {
      const hour = Number(String(hole.hour).replace(/\D/g, "")) || 8;
      const at = date.set({ hour, minute: 0, second: 0, millisecond: 0 });
      slots.push({
        iso: at.toUTC().toISO() || "",
        label: `${hole.day} · ${hole.hour}`,
      });
    }
  }
  return slots.filter((item) => item.iso);
}

export async function answerPublicSlotAsk(
  db: Db,
  input: { workspaceId: string; userId: string; text: string; timezone: string }
): Promise<string | null> {
  if (!looksLikePublicSlotAsk(input.text)) return null;
  const slots = await buildWeekFreeSlots(db, input);
  if (!slots.length) return "Não achei horário livre nesta semana.";
  const token = randomBytes(18).toString("base64url");
  await writeShare(db, {
    token,
    expiresAt: new Date(Date.now() + LIVRE_TTL_MS).toISOString(),
    timezone: input.timezone,
    workspaceId: input.workspaceId,
    userId: input.userId,
    slots,
  });
  const url = `${publicAppBaseUrl()}/livre/${token}`;
  let reply = [
    "Link só com horários livres.",
    "Quem abre não vê o que você já tem marcado.",
    url,
  ].join("\n");
  if (slots.length >= 4) {
    reply = await appendVisualBoard(
      { db, workspaceId: input.workspaceId, userId: input.userId },
      reply,
      {
        kind: "pessoal",
        title: "Horários da semana",
        kpis: [{ label: "Livres", value: String(slots.length) }],
        bars: [],
        rows: [],
        alerts: [],
        table: {
          search: "",
          layout: "cards",
          columns: [
            { key: "nome", label: "Quando" },
            { key: "situacao", label: "Situação" },
          ],
          rows: slots.slice(0, 24).map((item) => ({
            cells: { nome: item.label, situacao: "livre" },
          })),
        },
        note: "Só os livres. O título do que já está marcado não aparece.",
      }
    );
  }
  return reply;
}

export async function bookPublicSlot(
  db: Db,
  input: { token: string; iso: string; guestName?: string }
): Promise<{ ok: boolean; message: string }> {
  const share = await findLivreShare(db, input.token);
  if (!share) return { ok: false, message: "Este link expirou." };
  const slot = share.slots.find((item) => item.iso === input.iso);
  if (!slot) return { ok: false, message: "Esse horário não está mais livre." };
  const startsAt = new Date(slot.iso);
  if (Number.isNaN(startsAt.getTime())) return { ok: false, message: "Horário inválido." };
  const guest = String(input.guestName || "Alguém").trim().slice(0, 40) || "Alguém";
  await db.insert(appointments).values({
    workspaceId: share.workspaceId,
    createdByUserId: share.userId,
    userId: share.userId,
    title: `Encontro com ${guest}`,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    timezone: share.timezone,
    status: "scheduled",
    metadata: { source: "livre_link", guest },
  });
  share.slots = share.slots.filter((item) => item.iso !== slot.iso);
  await writeShare(db, share);
  const phone = await ownerPhoneE164(db, share.userId);
  if (phone) {
    const conv = await findConversationForPhone(db, phone);
    if (conv) {
      await sendProactiveMessage(db, {
        conversationId: conv.externalConversationId,
        message: `*${guest}* marcou *${slot.label}* pelo seu link.`,
        idempotencyKey: `livre-book:${share.token}:${slot.iso}`,
        withinCustomerCareWindow: true,
        forceTemplate: false,
      });
    }
  }
  return { ok: true, message: `Horário reservado: ${slot.label}.` };
}
