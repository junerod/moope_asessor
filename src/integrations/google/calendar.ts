import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { google } from "googleapis";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { appointments, integrationConnections, reminders } from "@/db/schema";
import type { ReminderPayload } from "@/lib/reminder-copy";
import { getAuthedGoogleClient, getGoogleConnection } from "./oauth";
import { toGoogleCalendarRecurrence } from "@/lib/recurrence";

export async function syncWorkspaceToGoogleCalendar(
  db: Db,
  input: { workspaceId: string; timezone: string; daysAhead?: number }
): Promise<{
  ok: boolean;
  summary: string;
  pushed: number;
  mock: boolean;
  errorCode?: string;
}> {
  const auth = await getAuthedGoogleClient(db, input.workspaceId);
  if (!auth) {
    return {
      ok: false,
      summary: "Google não está conectado. Diga “conectar google”.",
      pushed: 0,
      mock: false,
      errorCode: "not_connected",
    };
  }

  const tz = input.timezone || "America/Sao_Paulo";
  const days = Math.min(Math.max(input.daysAhead || 60, 7), 180);
  const now = DateTime.now().setZone(tz);
  const until = now.plus({ days }).endOf("day");

  const remRows = await db.query.reminders.findMany({
    where: and(
      eq(reminders.workspaceId, input.workspaceId),
      eq(reminders.status, "scheduled"),
      isNull(reminders.deletedAt),
      gte(reminders.fireAt, now.toJSDate()),
      lte(reminders.fireAt, until.toJSDate())
    ),
    limit: 80,
  });
  const apptRows = await db.query.appointments.findMany({
    where: and(
      eq(appointments.workspaceId, input.workspaceId),
      eq(appointments.status, "scheduled"),
      isNull(appointments.deletedAt),
      gte(appointments.startsAt, now.toJSDate()),
      lte(appointments.startsAt, until.toJSDate())
    ),
    limit: 80,
  });

  const events: Array<{
    id: string;
    summary: string;
    description: string;
    start: Date;
    end: Date;
    recurrence?: string[];
  }> = [];

  for (const r of remRows) {
    const payload = (r.payload || {}) as ReminderPayload & Record<string, unknown>;
    if (payload.team_external_oneshot === true) continue;
    if (payload.team_reminder === true && payload.member_appointment_id) continue;
    const start = r.fireAt;
    const end = DateTime.fromJSDate(r.fireAt).plus({ minutes: 30 }).toJSDate();
    const amount =
      typeof payload.amount === "number" && payload.amount > 0
        ? ` · R$ ${payload.amount.toFixed(2)}`
        : "";
    events.push({
      id: payload.team_reminder === true && payload.appointment_id && payload.target_phone
        ? `assessor-team-${String(payload.appointment_id)}-${String(payload.target_phone).replace(/\D/g, "")}`
            .replace(/[^a-zA-Z0-9-_]/g, "")
            .slice(0, 64)
        : `assessor-rem-${r.id}`.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 64),
      summary: `🔔 ${r.title}${amount}`,
      description: [
        String(payload.note || "Lembrete MOOPE Assessor"),
        String(payload.meet_url || "").trim(),
        String(payload.shared_note || "").trim(),
      ].filter(Boolean).join("\n"),
      start,
      end,
      recurrence: toGoogleCalendarRecurrence(r.recurrenceRule, start),
    });
  }
  for (const a of apptRows) {
    const start = a.startsAt;
    const end =
      a.endsAt ||
      DateTime.fromJSDate(a.startsAt).plus({ hours: 1 }).toJSDate();
    const metadata = (a.metadata || {}) as Record<string, unknown>;
    const teamOwnerAppointmentId = String(metadata.team_owner_appointment_id || "");
    const teamOwnerPhone = String(metadata.team_owner_phone || "").replace(/\D/g, "");
    const eventId = teamOwnerAppointmentId && teamOwnerPhone
      ? `assessor-team-${teamOwnerAppointmentId}-${teamOwnerPhone}`
          .replace(/[^a-zA-Z0-9-_]/g, "")
          .slice(0, 64)
      : `assessor-appt-${a.id}`.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 64);
    events.push({
      id: eventId,
      summary: `📅 ${a.title}`,
      description: [a.description || "Compromisso MOOPE Assessor", String(metadata.meet_url || "")]
        .filter(Boolean)
        .join("\n"),
      start,
      end,
      recurrence: toGoogleCalendarRecurrence(
        typeof metadata.recurrence_rule === "string" ? metadata.recurrence_rule : null,
        start
      ),
    });
  }

  if (!events.length) {
    return {
      ok: true,
      summary: `Nada pra sincronizar nos próximos ${days} dias 📅`,
      pushed: 0,
      mock: auth.mock,
    };
  }

  if (auth.mock) {
    const conn = await getGoogleConnection(db, input.workspaceId);
    if (conn) {
      await db
        .update(integrationConnections)
        .set({
          lastSyncedAt: new Date(),
          metadata: {
            ...((conn.metadata || {}) as object),
            last_calendar_sync: {
              at: new Date().toISOString(),
              pushed: events.length,
              mock: true,
              sample: events.slice(0, 3).map((e) => e.summary),
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(integrationConnections.id, conn.id));
    }
    return {
      ok: true,
      summary: `📅 (homolog) Sincronizei *${events.length}* eventos com a agenda Google mock.\nConfigure Client ID real no /admin para gravar no Calendar de verdade.`,
      pushed: events.length,
      mock: true,
    };
  }

  const calendar = google.calendar({ version: "v3", auth: auth.oauth2! });
  let pushed = 0;
  const errors: string[] = [];
  for (const ev of events) {
    try {
      // Upsert: tenta achar por assessor_id privado; senão insert
      const existing = await calendar.events.list({
        calendarId: "primary",
        privateExtendedProperty: [`assessor_id=${ev.id}`],
        maxResults: 1,
        singleEvents: !ev.recurrence?.length,
      });
      const foundId = existing.data.items?.[0]?.id;
      const body = {
        summary: ev.summary,
        description: ev.description,
        start: { dateTime: ev.start.toISOString() },
        end: { dateTime: ev.end.toISOString() },
        recurrence: ev.recurrence || [],
        extendedProperties: {
          private: { assessor_id: ev.id },
        },
      };
      if (foundId) {
        await calendar.events.patch({
          calendarId: "primary",
          eventId: foundId,
          requestBody: body,
        });
      } else {
        await calendar.events.insert({
          calendarId: "primary",
          requestBody: body,
        });
      }
      pushed += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "insert_failed");
    }
  }

  const conn = await getGoogleConnection(db, input.workspaceId);
  if (conn) {
    await db
      .update(integrationConnections)
      .set({
        lastSyncedAt: new Date(),
        metadata: {
          ...((conn.metadata || {}) as object),
          last_calendar_sync: {
            at: new Date().toISOString(),
            pushed,
            errors: errors.slice(0, 3),
            mock: false,
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, conn.id));
  }

  if (!pushed) {
    return {
      ok: false,
      summary: `Não consegui gravar no Google Calendar${errors[0] ? `: ${errors[0]}` : "."}`,
      pushed: 0,
      mock: false,
      errorCode: "calendar_push_failed",
    };
  }

  return {
    ok: true,
    summary: `📅 Enviei *${pushed}* eventos para o *Google Agenda*${
      errors.length ? ` (${errors.length} falharam)` : ""
    }.`,
    pushed,
    mock: false,
  };
}
