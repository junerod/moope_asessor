/**
 * Lê eventos do Google Calendar (Assessor ← Google).
 * Usa o mesmo OAuth calendar.events (já permite list).
 */
import { google } from "googleapis";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { logger } from "@/lib/logger";
import { getAuthedGoogleClient } from "./oauth";

export type GoogleDayEvent = {
  id: string;
  summary: string;
  start: Date;
  end: Date | null;
  fromAssessor: boolean;
  htmlLink?: string | null;
  organizer?: string | null;
  organizerSelf?: boolean;
  meetUrl?: string | null;
  created?: Date | null;
  declined?: boolean;
  pendingRsvp?: boolean;
};

export async function listGoogleDayEvents(
  db: Db,
  input: {
    workspaceId: string;
    timezone: string;
    dayIso?: string; // YYYY-MM-DD
  }
): Promise<{ ok: boolean; events: GoogleDayEvent[]; skipped?: boolean }> {
  try {
    const auth = await getAuthedGoogleClient(db, input.workspaceId);
    if (!auth?.oauth2 || auth.mock) {
      return { ok: false, events: [], skipped: true };
    }
    const tz = input.timezone || "America/Sao_Paulo";
    const day = input.dayIso
      ? DateTime.fromISO(input.dayIso, { zone: tz })
      : DateTime.now().setZone(tz);
    if (!day.isValid) return { ok: false, events: [] };
    const timeMin = day.startOf("day").toUTC().toISO();
    const timeMax = day.endOf("day").toUTC().toISO();
    if (!timeMin || !timeMax) return { ok: false, events: [] };

    const calendar = google.calendar({ version: "v3", auth: auth.oauth2 });
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 40,
      showHiddenInvitations: true,
    });

    const events: GoogleDayEvent[] = [];
    for (const ev of res.data.items || []) {
      if (!ev.id || ev.status === "cancelled") continue;
      const startRaw = ev.start?.dateTime || ev.start?.date;
      if (!startRaw) continue;
      const start = DateTime.fromISO(startRaw, { zone: tz });
      if (!start.isValid) continue;
      const endRaw = ev.end?.dateTime || ev.end?.date;
      const end = endRaw ? DateTime.fromISO(endRaw, { zone: tz }) : null;
      const privateProps = (ev.extendedProperties?.private || {}) as Record<
        string,
        string
      >;
      const fromAssessor =
        Boolean(privateProps.assessor_id) ||
        /^🔔\s/.test(String(ev.summary || "")) ||
        /MOOPE Assessor/i.test(String(ev.description || ""));
      events.push({
        id: ev.id,
        summary: String(ev.summary || "Evento").slice(0, 200),
        start: start.toJSDate(),
        end: end?.isValid ? end.toJSDate() : null,
        fromAssessor,
        htmlLink: ev.htmlLink || null,
      });
    }
    return { ok: true, events };
  } catch {
    return { ok: false, events: [] };
  }
}

/** Eventos Google nas próximas N minutos (pra aviso proativo). */
export async function listGoogleUpcomingEvents(
  db: Db,
  input: {
    workspaceId: string;
    timezone: string;
    withinMinutes: number;
  }
): Promise<GoogleDayEvent[]> {
  try {
    const auth = await getAuthedGoogleClient(db, input.workspaceId);
    if (!auth?.oauth2 || auth.mock) return [];
    const tz = input.timezone || "America/Sao_Paulo";
    const now = DateTime.now().setZone(tz);
    const until = now.plus({ minutes: input.withinMinutes });
    const calendar = google.calendar({ version: "v3", auth: auth.oauth2 });
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toUTC().toISO()!,
      timeMax: until.toUTC().toISO()!,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20,
      showHiddenInvitations: true,
    });
    const out: GoogleDayEvent[] = [];
    for (const ev of res.data.items || []) {
      if (!ev.id || ev.status === "cancelled") continue;
      const startRaw = ev.start?.dateTime || ev.start?.date;
      if (!startRaw) continue;
      const start = DateTime.fromISO(startRaw, { zone: tz });
      if (!start.isValid) continue;
      const privateProps = (ev.extendedProperties?.private || {}) as Record<
        string,
        string
      >;
      if (privateProps.assessor_id) continue; // já avisamos via Assessor
      out.push({
        id: ev.id,
        summary: String(ev.summary || "Evento").slice(0, 200),
        start: start.toJSDate(),
        end: null,
        fromAssessor: false,
        htmlLink: ev.htmlLink || null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function meetLink(ev: {
  hangoutLink?: string | null;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string | null; uri?: string | null }> | null;
  } | null;
}): string | null {
  if (ev.hangoutLink && /^https:\/\//.test(ev.hangoutLink)) return ev.hangoutLink;
  const video = ev.conferenceData?.entryPoints?.find(
    (point) => point.entryPointType === "video" && point.uri
  );
  return video?.uri && /^https:\/\//.test(video.uri) ? video.uri : null;
}

/** Próximos dias na agenda ligada — pra avisar quando alguém marca com você. */
export async function listGoogleHorizonEvents(
  db: Db,
  input: {
    workspaceId: string;
    timezone: string;
    days?: number;
  }
): Promise<GoogleDayEvent[]> {
  try {
    const auth = await getAuthedGoogleClient(db, input.workspaceId);
    if (!auth?.oauth2 || auth.mock) return [];
    const tz = input.timezone || "America/Sao_Paulo";
    const now = DateTime.now().setZone(tz);
    const until = now.plus({ days: input.days ?? 7 }).endOf("day");
    const calendar = google.calendar({ version: "v3", auth: auth.oauth2 });
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.minus({ minutes: 20 }).toUTC().toISO()!,
      timeMax: until.toUTC().toISO()!,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 40,
      showHiddenInvitations: true,
    });
    const out: GoogleDayEvent[] = [];
    for (const ev of res.data.items || []) {
      if (!ev.id || ev.status === "cancelled") continue;
      const startRaw = ev.start?.dateTime || ev.start?.date;
      if (!startRaw) continue;
      const start = DateTime.fromISO(startRaw, { zone: tz });
      if (!start.isValid) continue;
      const endRaw = ev.end?.dateTime || ev.end?.date;
      const end = endRaw ? DateTime.fromISO(endRaw, { zone: tz }) : null;
      const privateProps = (ev.extendedProperties?.private || {}) as Record<
        string,
        string
      >;
      const fromAssessor =
        Boolean(privateProps.assessor_id) ||
        /^🔔\s/.test(String(ev.summary || "")) ||
        /MOOPE Assessor/i.test(String(ev.description || ""));
      const selfAttendee = (ev.attendees || []).find((person) => person.self);
      const created = ev.created ? DateTime.fromISO(ev.created) : null;
      out.push({
        id: ev.id,
        summary: String(ev.summary || "Evento").slice(0, 200),
        start: start.toJSDate(),
        end: end?.isValid ? end.toJSDate() : null,
        fromAssessor,
        htmlLink: ev.htmlLink || null,
        organizer:
          ev.organizer?.displayName ||
          ev.organizer?.email ||
          null,
        organizerSelf: Boolean(ev.organizer?.self),
        meetUrl: meetLink(ev),
        created: created?.isValid ? created.toJSDate() : null,
        declined: selfAttendee?.responseStatus === "declined",
        pendingRsvp:
          Boolean(selfAttendee) &&
          !ev.organizer?.self &&
          (selfAttendee?.responseStatus === "needsAction" ||
            !selfAttendee?.responseStatus),
      });
    }
    return out;
  } catch (err) {
    logger.warn("google_horizon_failed", {
      error: err instanceof Error ? err.message.slice(0, 180) : "list_failed",
    });
    return [];
  }
}

export function formatGoogleEventsBlock(
  events: GoogleDayEvent[],
  timezone: string
): string {
  const external = events.filter((e) => !e.fromAssessor);
  if (!external.length) return "";
  const tz = timezone || "America/Sao_Paulo";
  const lines = external.slice(0, 12).map((e) => {
    const t = DateTime.fromJSDate(e.start).setZone(tz).toFormat("HH:mm");
    return `• ${t} · ${e.summary}`;
  });
  return ["*Também na Agenda:*", ...lines].join("\n");
}
