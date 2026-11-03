/**
 * Empurra 1 evento pro Google Calendar (sync automático).
 * Best-effort: nunca quebra criação de lembrete/compromisso.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { integrationConnections, reminders } from "@/db/schema";
import { logger } from "@/lib/logger";
import {
  getAuthedGoogleClient,
  getGoogleConnection,
  loadGoogleTokens,
} from "./oauth";
import { toGoogleCalendarRecurrence } from "@/lib/recurrence";

async function isRealConnected(db: Db, workspaceId: string): Promise<boolean> {
  const row = await getGoogleConnection(db, workspaceId);
  if (!row || row.status !== "connected") return false;
  const tokens = await loadGoogleTokens(db, workspaceId);
  const meta = (row.metadata || {}) as Record<string, unknown>;
  if (tokens?.mock || meta.mock || meta.connected_via === "dev_mock") return false;
  return Boolean(tokens?.access_token);
}

export async function pushEventToGoogleCalendar(
  db: Db,
  input: {
    workspaceId: string;
    summary: string;
    description?: string;
    start: Date;
    end: Date;
    timezone?: string;
    assessorId?: string;
    existingEventId?: string | null;
    createMeet?: boolean;
    recurrenceRule?: string | null;
  }
): Promise<{
  ok: boolean;
  eventId?: string;
  meetUrl?: string;
  skipped?: boolean;
  updated?: boolean;
}> {
  try {
    if (!(await isRealConnected(db, input.workspaceId))) {
      return { ok: false, skipped: true };
    }
    const auth = await getAuthedGoogleClient(db, input.workspaceId);
    if (!auth?.oauth2 || auth.mock) return { ok: false, skipped: true };

    const calendar = google.calendar({ version: "v3", auth: auth.oauth2 });
    const tz = input.timezone || "America/Sao_Paulo";
    const startIso = DateTime.fromJSDate(input.start).setZone(tz).toISO();
    const endIso = DateTime.fromJSDate(input.end).setZone(tz).toISO();
    if (!startIso || !endIso) return { ok: false };

    let existingEventId = input.existingEventId || null;
    if (!existingEventId && input.assessorId) {
      const existing = await calendar.events.list({
        calendarId: "primary",
        privateExtendedProperty: [`assessor_id=${input.assessorId}`],
        maxResults: 1,
        singleEvents: false,
      });
      existingEventId = existing.data.items?.[0]?.id || null;
    }

    const body = {
      summary: input.summary.slice(0, 500),
      description: (input.description || "MOOPE Assessor").slice(0, 2000),
      start: { dateTime: startIso, timeZone: tz },
      end: { dateTime: endIso, timeZone: tz },
      extendedProperties: input.assessorId
        ? { private: { assessor_id: input.assessorId } }
        : undefined,
      source: {
        title: "MOOPE Assessor",
        url: "https://moope.com.br",
      },
      ...(input.createMeet && !existingEventId
        ? {
            conferenceData: {
              createRequest: {
                requestId: randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          }
        : {}),
      ...(input.existingEventId
        ? { recurrence: toGoogleCalendarRecurrence(input.recurrenceRule, input.start) || [] }
        : toGoogleCalendarRecurrence(input.recurrenceRule, input.start)
          ? { recurrence: toGoogleCalendarRecurrence(input.recurrenceRule, input.start) }
          : {}),
    };

    let res;
    let updated = false;
    if (existingEventId) {
      try {
        res = await calendar.events.patch({
          calendarId: "primary",
          eventId: existingEventId,
          requestBody: body,
        });
        updated = true;
      } catch {
        res = await calendar.events.insert({
          calendarId: "primary",
          requestBody: body,
          conferenceDataVersion: input.createMeet ? 1 : undefined,
        });
      }
    } else {
      res = await calendar.events.insert({
        calendarId: "primary",
        requestBody: body,
        conferenceDataVersion: input.createMeet ? 1 : undefined,
      });
    }

    const conn = await getGoogleConnection(db, input.workspaceId);
    if (conn) {
      await db
        .update(integrationConnections)
        .set({
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(integrationConnections.id, conn.id));
    }

    return {
      ok: true,
      eventId: res.data.id || undefined,
      meetUrl:
        res.data.hangoutLink ||
        res.data.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri ||
        undefined,
      updated,
    };
  } catch (err) {
    logger.warn("google_auto_push_failed", {
      workspace_id: input.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

/** Após criar lembrete: empurra pro Calendar se Google conectado. */
export async function autoPushReminderToGoogle(
  db: Db,
  input: {
    workspaceId: string;
    reminderId: string;
    title: string;
    fireAt: Date;
    timezone: string;
    payload?: Record<string, unknown> | null;
  }
): Promise<string | null> {
  const end = DateTime.fromJSDate(input.fireAt)
    .plus({ minutes: 30 })
    .toJSDate();
  const amount =
    typeof input.payload?.amount === "number" && input.payload.amount > 0
      ? ` · R$ ${Number(input.payload.amount).toFixed(2)}`
      : "";
  const existingId =
    typeof input.payload?.google_event_id === "string"
      ? input.payload.google_event_id
      : null;
  const assessorId = `assessor-rem-${input.reminderId}`
    .replace(/[^a-zA-Z0-9-_]/g, "")
    .slice(0, 64);
  const result = await pushEventToGoogleCalendar(db, {
    workspaceId: input.workspaceId,
    summary: `🔔 ${input.title}${amount}`,
    description: String(input.payload?.note || "Lembrete MOOPE Assessor"),
    start: input.fireAt,
    end,
    timezone: input.timezone,
    assessorId,
    existingEventId: existingId,
  });
  if (!result.ok || result.skipped) return null;

  if (result.eventId) {
    try {
      await db
        .update(reminders)
        .set({
          payload: {
            ...(input.payload || {}),
            google_event_id: result.eventId,
          },
          updatedAt: new Date(),
        })
        .where(eq(reminders.id, input.reminderId));
    } catch {
      /* best-effort */
    }
  }
  return "📅 Também caiu no *Google Agenda*.";
}

/** Após criar compromisso. */
export async function autoPushAppointmentToGoogle(
  db: Db,
  input: {
    workspaceId: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    description?: string | null;
    createMeet?: boolean;
    recurrenceRule?: string | null;
    assessorId?: string;
    existingEventId?: string | null;
  }
): Promise<{ note: string | null; eventId?: string; meetUrl?: string }> {
  const result = await pushEventToGoogleCalendar(db, {
    workspaceId: input.workspaceId,
    summary: `📅 ${input.title}`,
    description: input.description || "Compromisso MOOPE Assessor",
    start: input.startsAt,
    end: input.endsAt,
    timezone: input.timezone,
    createMeet: input.createMeet,
    recurrenceRule: input.recurrenceRule,
    assessorId: input.assessorId,
    existingEventId: input.existingEventId,
  });
  if (!result.ok || result.skipped) return { note: null };
  return {
    note: result.meetUrl
      ? "📅 Também caiu no *Google Agenda* com link do Google Meet."
      : "📅 Também caiu no *Google Agenda*.",
    eventId: result.eventId,
    meetUrl: result.meetUrl,
  };
}

export async function deleteAppointmentFromGoogle(
  db: Db,
  input: { workspaceId: string; eventId: string }
): Promise<void> {
  try {
    if (!(await isRealConnected(db, input.workspaceId))) return;
    const auth = await getAuthedGoogleClient(db, input.workspaceId);
    if (!auth?.oauth2 || auth.mock) return;
    const calendar = google.calendar({ version: "v3", auth: auth.oauth2 });
    await calendar.events.delete({
      calendarId: "primary",
      eventId: input.eventId,
      sendUpdates: "all",
    });
  } catch (err) {
    logger.warn("google_appointment_cancel_failed", {
      workspace_id: input.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
