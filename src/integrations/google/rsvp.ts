/**
 * Responde convite do Google Agenda (sim / não / talvez) sem abrir o e-mail.
 */
import { and, eq, isNull } from "drizzle-orm";
import { google } from "googleapis";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { integrationConnections, memories } from "@/db/schema";
import { getAuthedGoogleClient } from "./oauth";
import { listGoogleHorizonEvents, type GoogleDayEvent } from "./pull";

export type GoogleRsvpStatus = "accepted" | "declined" | "tentative";

type RsvpChoice = { status: GoogleRsvpStatus; index: number | null; explicit: boolean };

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function parseGoogleRsvpChoice(text: string): RsvpChoice | null {
  const raw = String(text || "").trim();
  const folded = fold(raw).replace(/[.!?]+$/g, "");
  const explicit = /convite|google agenda|no google/.test(folded);
  const bare = folded.match(
    /^(sim|pode|aceito|aceita|confirmo|confirma|nao|recuso|recusar|talvez)(?:\s+(\d{1,2}))?$/
  );
  const loose = explicit
    ? folded.match(/\b(sim|aceito|aceita|confirma|confirmo|nao|recuso|talvez)\b(?:\s+(\d{1,2}))?/)
    : null;
  const hit = bare || loose;
  if (!hit) return null;
  const word = hit[1];
  const index = hit[2] ? Number(hit[2]) : null;
  const status: GoogleRsvpStatus =
    word === "nao" || word === "recuso" || word === "recusar"
      ? "declined"
      : word === "talvez"
        ? "tentative"
        : "accepted";
  return { status, index, explicit };
}

function whenLabel(ev: GoogleDayEvent, tz: string): string {
  const start = DateTime.fromJSDate(ev.start).setZone(tz).setLocale("pt-BR");
  const end = ev.end ? DateTime.fromJSDate(ev.end).setZone(tz).setLocale("pt-BR") : null;
  const day = start.toFormat("ccc dd/LL");
  if (end?.isValid && end.hasSame(start, "day")) {
    return `${day} · ${start.toFormat("HH:mm")}–${end.toFormat("HH:mm")}`;
  }
  return `${day} · ${start.toFormat("HH:mm")}`;
}

async function promptIsFresh(db: Db, workspaceId: string): Promise<boolean> {
  const conn = await db.query.integrationConnections.findFirst({
    where: and(
      eq(integrationConnections.workspaceId, workspaceId),
      eq(integrationConnections.provider, "google_calendar"),
      eq(integrationConnections.status, "connected"),
      isNull(integrationConnections.deletedAt)
    ),
  });
  const meta = (conn?.metadata || {}) as Record<string, unknown>;
  const at = Date.parse(String(meta.google_rsvp_prompted_at || ""));
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < 6 * 60 * 60 * 1000;
}

async function hasPendingBill(db: Db, workspaceId: string): Promise<boolean> {
  const row = await db.query.memories.findFirst({
    where: and(
      eq(memories.workspaceId, workspaceId),
      eq(memories.sourceType, "pending_bill"),
      isNull(memories.deletedAt)
    ),
  });
  return Boolean(row);
}

export async function respondGoogleInvite(
  db: Db,
  input: {
    workspaceId: string;
    eventId: string;
    status: GoogleRsvpStatus;
  }
): Promise<{ ok: boolean; error?: string }> {
  const auth = await getAuthedGoogleClient(db, input.workspaceId);
  if (!auth?.oauth2 || auth.mock) return { ok: false, error: "sem_google" };
  const calendar = google.calendar({ version: "v3", auth: auth.oauth2 });
  try {
    const current = await calendar.events.get({
      calendarId: "primary",
      eventId: input.eventId,
    });
    const attendees = (current.data.attendees || []).map((person) => ({ ...person }));
    const me = attendees.find((person) => person.self);
    if (!me) return { ok: false, error: "nao_e_convite" };
    me.responseStatus = input.status;
    await calendar.events.patch({
      calendarId: "primary",
      eventId: input.eventId,
      sendUpdates: "all",
      requestBody: { attendees },
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 160) : "patch_failed";
    return { ok: false, error: message };
  }
}

export const GOOGLE_INVITE_NOT_ON_CALENDAR =
  "Esse convite ainda não está na sua agenda do Google. Aceita lá ou liga ‘adicionar convites’ — daí eu respondo daqui.";

export async function answerGoogleInvite(
  db: Db,
  input: { workspaceId: string; text: string; timezone: string }
): Promise<string | null> {
  const choice = parseGoogleRsvpChoice(input.text);
  if (!choice) return null;
  const fresh = await promptIsFresh(db, input.workspaceId);
  if (!choice.explicit && !fresh) return null;
  if (!choice.explicit && (await hasPendingBill(db, input.workspaceId))) return null;

  const tz = input.timezone || "America/Sao_Paulo";
  let events = (await listGoogleHorizonEvents(db, {
    workspaceId: input.workspaceId,
    timezone: tz,
    days: 14,
  })).filter((ev) => ev.pendingRsvp && !ev.fromAssessor && !ev.declined);

  if (!events.length) {
    const { listHiddenGoogleInvites } = await import("./gmail-invites");
    events = await listHiddenGoogleInvites(db, {
      workspaceId: input.workspaceId,
      timezone: tz,
    });
  }

  if (!events.length) return GOOGLE_INVITE_NOT_ON_CALENDAR;

  let picked: GoogleDayEvent | undefined;
  if (choice.index && choice.index >= 1 && choice.index <= events.length) {
    picked = events[choice.index - 1];
  } else if (events.length === 1) {
    picked = events[0];
  } else {
    const lines = events.slice(0, 5).map((ev, i) => `*${i + 1}* · ${whenLabel(ev, tz)} · ${ev.summary}`);
    return [
      "Tem mais de um convite em aberto.",
      ...lines,
      "Responda *sim 1*, *não 2* ou *talvez 1*.",
    ].join("\n");
  }
  if (!picked) return null;

  const send = await respondGoogleInvite(db, {
    workspaceId: input.workspaceId,
    eventId: picked.id,
    status: choice.status,
  });
  if (!send.ok) {
    return "Não consegui marcar essa resposta no Google agora. Tenta de novo em instantes.";
  }
  const verb =
    choice.status === "accepted"
      ? "Confirmado no Google"
      : choice.status === "declined"
        ? "Recusado no Google"
        : "Marcado como talvez no Google";
  const who =
    picked.organizer && !picked.organizer.includes("@") && !picked.organizerSelf
      ? `\n${picked.organizer} recebe a sua resposta.`
      : "\nQuem convidou recebe a sua resposta.";
  return [`✅ *${verb}*`, `*${picked.summary}*`, `🗓️ ${whenLabel(picked, tz)}`, who.trim()].join("\n");
}
