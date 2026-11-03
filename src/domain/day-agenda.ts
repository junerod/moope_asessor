import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { appointments, reminders } from "@/db/schema";
import { dayRange } from "@/lib/datetime";
import {
  formatReminderListItem,
  isInternalTestReminder,
  type ReminderPayload,
} from "@/lib/reminder-copy";

export type DayAgendaItem = {
  title: string;
  at: Date;
  timezone: string;
  reminderIds: string[];
  appointmentIds: string[];
  payload?: ReminderPayload | null;
  recurrenceRule?: string | null;
  status?: string | null;
  googleOnly?: boolean;
};

type LooseReminder = {
  id: string;
  title: string;
  fireAt: Date;
  timezone: string | null;
  status: string;
  recurrenceRule: string | null;
  payload: ReminderPayload | Record<string, unknown> | null;
};

/** Um nome só, sem “lembrete:” nem “amanhã às 9h”. */
export function displayAgendaTitle(title: string): string {
  const cleaned = String(title || "")
    .replace(/^(lembrete|compromisso)\s*:\s*/i, "")
    .replace(/(?:^|\s)(?:amanh[ãa]|hoje)(?=\s|$)/gi, " ")
    .replace(/(?:^|\s)(?:às|as)\s*\d{1,2}(?::\d{2}|h\d{0,2})?(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,:\-\s]+|[,:\-\s]+$/g, "")
    .trim();
  return cleaned || String(title || "").trim();
}

export function agendaCore(title: string): string {
  return displayAgendaTitle(title)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titlesMatch(a: string, b: string): boolean {
  const ca = agendaCore(a);
  const cb = agendaCore(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  if (ca.length >= 4 && cb.length >= 4 && (ca.includes(cb) || cb.includes(ca))) return true;
  return false;
}

function closeInTime(a: Date, b: Date): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= 2 * 60 * 60 * 1000;
}

function appointmentIdOf(payload: LooseReminder["payload"]): string | null {
  const note = String((payload as ReminderPayload | null)?.note || "");
  const fromNote = note.match(/appointment:([0-9a-f-]{36})/i)?.[1];
  const direct = String((payload as { appointment_id?: string } | null)?.appointment_id || "");
  return fromNote || direct || null;
}

function dayLabel(dayIso: string, timezone: string): string {
  const day = DateTime.fromISO(dayIso, { zone: timezone });
  const now = DateTime.now().setZone(timezone);
  if (dayIso === now.toISODate()) return "Seu dia";
  if (dayIso === now.plus({ days: 1 }).toISODate()) return "Amanhã";
  return day.setLocale("pt-BR").toFormat("cccc dd/LL");
}

export function formatDayAgenda(items: DayAgendaItem[], timezone: string, dayIso: string): string {
  const label = dayLabel(dayIso, timezone);
  if (!items.length) {
    return `📭 *${label}* — nada por aqui.\n\nQuer marcar? Diga *amanhã às 10h falar com o Pereira*.`;
  }
  const lines = items.map((item, index) =>
    formatReminderListItem({
      title: item.title,
      fireAt: item.at,
      timezone: item.timezone || timezone,
      payload: item.googleOnly ? { kind: "compromisso", note: "Google" } : item.payload,
      recurrenceRule: item.recurrenceRule,
      status: item.status,
    }).replace(/^• /, `*${index + 1}.* `)
  );
  return [`📅 *${label}* (${items.length})`, "", ...lines, "", "_Concluir:_ *baixa 1*"].join("\n");
}

/** A lista que o WhatsApp mostra. A baixa usa estes mesmos números. */
export async function loadDayAgenda(
  db: Db,
  workspaceId: string,
  timezone: string,
  dayIso?: string
): Promise<DayAgendaItem[]> {
  const zone = timezone || "America/Sao_Paulo";
  const day = dayIso
    ? DateTime.fromISO(dayIso, { zone })
    : DateTime.now().setZone(zone);
  const iso = day.toISODate() || DateTime.now().setZone(zone).toISODate() || "";
  const { start, end } = dayRange(day);

  const reminderRows = (
    await db.query.reminders.findMany({
      where: and(eq(reminders.workspaceId, workspaceId), isNull(reminders.deletedAt)),
    })
  ).filter((row) => {
    if (isInternalTestReminder(row.title, row.payload)) return false;
    if (!["scheduled", "queued", "sent"].includes(String(row.status))) return false;
    return row.fireAt >= start && row.fireAt <= end;
  }) as LooseReminder[];

  const appointmentRows = (
    await db.query.appointments.findMany({
      where: and(
        eq(appointments.workspaceId, workspaceId),
        isNull(appointments.deletedAt),
        eq(appointments.status, "scheduled")
      ),
    })
  ).filter((row) => row.startsAt >= start && row.startsAt <= end);

  const items: DayAgendaItem[] = appointmentRows.map((row) => ({
    title: displayAgendaTitle(row.title),
    at: row.startsAt,
    timezone: row.timezone || zone,
    reminderIds: [],
    appointmentIds: [row.id],
    payload: { kind: "compromisso" },
  }));

  for (const row of reminderRows) {
    const linked = appointmentIdOf(row.payload);
    const host =
      (linked ? items.find((item) => item.appointmentIds.includes(linked)) : undefined) ||
      items.find((item) => titlesMatch(item.title, row.title) && closeInTime(item.at, row.fireAt));
    if (host) {
      if (!host.reminderIds.includes(row.id)) host.reminderIds.push(row.id);
      if (linked && !host.appointmentIds.includes(linked)) host.appointmentIds.push(linked);
      continue;
    }
    items.push({
      title: displayAgendaTitle(row.title),
      at: row.fireAt,
      timezone: row.timezone || zone,
      reminderIds: [row.id],
      appointmentIds: linked ? [linked] : [],
      payload: (row.payload || null) as ReminderPayload | null,
      recurrenceRule: row.recurrenceRule,
      status: row.status,
    });
  }

  try {
    const { listGoogleDayEvents } = await import("@/integrations/google/pull");
    const google = await listGoogleDayEvents(db, {
      workspaceId,
      timezone: zone,
      dayIso: iso,
    });
    for (const event of google.events.filter((item) => !item.fromAssessor)) {
      const already = items.some(
        (item) => titlesMatch(item.title, event.summary) && closeInTime(item.at, event.start)
      );
      if (already) continue;
      items.push({
        title: displayAgendaTitle(event.summary),
        at: event.start,
        timezone: zone,
        reminderIds: [],
        appointmentIds: [],
        payload: { kind: "compromisso" },
        googleOnly: true,
      });
    }
  } catch {
    /* a agenda local segue sem o Google */
  }

  items.sort((a, b) => a.at.getTime() - b.at.getTime());
  return items;
}
