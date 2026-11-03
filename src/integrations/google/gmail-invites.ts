/**
 * Convites que o Google ainda esconde (fromGmail / convite oculto).
 * Usa só o OAuth de agenda. Não pede Gmail.
 */
import { google } from "googleapis";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { logger } from "@/lib/logger";
import { getAuthedGoogleClient } from "./oauth";
import { listGoogleHorizonEvents, type GoogleDayEvent } from "./pull";

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function looksLikeInvitePull(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 90) return false;
  if (/puxa (o )?convite|adiciona (o )?convite/.test(t)) return true;
  return /convite (do |no )?(gmail|e-mail|email|google)/.test(t);
}

function mapEvent(
  ev: {
    id?: string | null;
    status?: string | null;
    summary?: string | null;
    start?: { dateTime?: string | null; date?: string | null } | null;
    end?: { dateTime?: string | null; date?: string | null } | null;
    htmlLink?: string | null;
    organizer?: { displayName?: string | null; email?: string | null; self?: boolean | null } | null;
    attendees?: Array<{ self?: boolean | null; responseStatus?: string | null }> | null;
  },
  tz: string
): GoogleDayEvent | null {
  if (!ev.id || ev.status === "cancelled") return null;
  const startRaw = ev.start?.dateTime || ev.start?.date;
  if (!startRaw) return null;
  const start = DateTime.fromISO(startRaw, { zone: tz });
  if (!start.isValid) return null;
  const endRaw = ev.end?.dateTime || ev.end?.date;
  const end = endRaw ? DateTime.fromISO(endRaw, { zone: tz }) : null;
  const selfAttendee = (ev.attendees || []).find((person) => person.self);
  return {
    id: ev.id,
    summary: String(ev.summary || "Convite").slice(0, 200),
    start: start.toJSDate(),
    end: end?.isValid ? end.toJSDate() : null,
    fromAssessor: false,
    htmlLink: ev.htmlLink || null,
    organizer: ev.organizer?.displayName || ev.organizer?.email || null,
    organizerSelf: Boolean(ev.organizer?.self),
    pendingRsvp:
      Boolean(selfAttendee) &&
      !ev.organizer?.self &&
      (selfAttendee?.responseStatus === "needsAction" || !selfAttendee?.responseStatus),
  };
}

export async function listHiddenGoogleInvites(
  db: Db,
  input: { workspaceId: string; timezone: string }
): Promise<GoogleDayEvent[]> {
  const tz = input.timezone || "America/Sao_Paulo";
  const horizon = await listGoogleHorizonEvents(db, {
    workspaceId: input.workspaceId,
    timezone: tz,
    days: 30,
  });
  const pending = horizon.filter((ev) => ev.pendingRsvp && !ev.fromAssessor && !ev.declined);
  try {
    const auth = await getAuthedGoogleClient(db, input.workspaceId);
    if (!auth?.oauth2 || auth.mock) return pending;
    const now = DateTime.now().setZone(tz);
    const calendar = google.calendar({ version: "v3", auth: auth.oauth2 });
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toUTC().toISO()!,
      timeMax: now.plus({ days: 30 }).endOf("day").toUTC().toISO()!,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20,
      showHiddenInvitations: true,
      eventTypes: ["fromGmail"],
    });
    const extra: GoogleDayEvent[] = [];
    for (const ev of res.data.items || []) {
      const mapped = mapEvent(ev, tz);
      if (mapped) extra.push(mapped);
    }
    const seen = new Set(pending.map((item) => item.id));
    return [...pending, ...extra.filter((item) => !seen.has(item.id))];
  } catch (err) {
    logger.warn("google_fromgmail_list_failed", {
      error: err instanceof Error ? err.message.slice(0, 160) : "list_failed",
    });
    return pending;
  }
}

export async function answerInvitePull(
  db: Db,
  input: { workspaceId: string; timezone: string; text: string }
): Promise<string | null> {
  if (!looksLikeInvitePull(input.text)) return null;
  const tz = input.timezone || "America/Sao_Paulo";
  const invites = await listHiddenGoogleInvites(db, input);
  if (!invites.length) {
    return "Não achei convite escondido na agenda. Aceita no Google ou liga ‘adicionar convites’.";
  }
  const lines = invites.slice(0, 5).map((ev, index) => {
    const when = DateTime.fromJSDate(ev.start).setZone(tz).toFormat("ccc dd/LL · HH:mm");
    return `*${index + 1}* · ${when} · ${ev.summary}`;
  });
  return [
    "Achei estes convites:",
    ...lines,
    "Responda *sim 1* ou *não 1*.",
  ].join("\n");
}
