import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { appointments, reminders, tasks } from "@/db/schema";
import { dayRange } from "@/lib/datetime";
import {
  formatReminderListItem,
  isInternalTestReminder,
  type ReminderPayload,
} from "@/lib/reminder-copy";
import { displayAgendaTitle, loadDayAgenda, type DayAgendaItem } from "@/domain/day-agenda";

export type DayReminderRow = {
  id: string;
  title: string;
  fireAt: Date;
  timezone: string;
  status: string;
  recurrenceRule: string | null;
  payload: ReminderPayload | Record<string, unknown> | null;
};

export type BaixaIntent =
  | { kind: "baixa_indices"; indices: number[] }
  | { kind: "baixa_all_past" }
  | { kind: "baixa_query"; queries: string[] }
  | { kind: "baixa_ask" }
  | { kind: "ainda_nao" };

const BAIXA_VERB =
  /\b(baix(?:a|ar)|conclu[ií]|dei baixa|dar baixa|feito|executei)\b/;
const REMOVE_VERB =
  /\b(remover|remove|remova|cancelar|cancela|cancele|desmarcar|desmarca)\b/;
const AGENDA_NOUN = /\b(compromisso|lembrete|reuniao)s?\b/;

function cleanBaixaQuery(part: string): string {
  return foldBaixa(part)
    .replace(/\b(compromisso|lembrete|reuniao)s?\b/g, " ")
    .replace(/\b(de |do |da )?(ontem|hoje|amanha)\b/g, " ")
    .replace(/[:\-]+/g, " ")
    .replace(/^(de |do |da |no |na |em |o |a |um |uma )+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/g, "")
    .trim();
}

/** “baixa 1” · “baixar compromisso: Adan” · “remover compromisso de ontem” */
export function parseBaixaIntent(text: string): BaixaIntent | null {
  const raw = String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!raw) return null;

  if (
    /^(ainda nao|nao ainda|deixa|deixa quieto|depois)!?\.?$/.test(raw) ||
    (/\bainda nao\b/.test(raw) &&
      /(baixa|agenda|passou|conclu|lembrete)/.test(raw))
  ) {
    return { kind: "ainda_nao" };
  }

  if (
    /(conclui|conclu[ií]|dei baixa|dar baixa|baix(?:a|ar)).{0,40}(tudo|todos|o que (ja )?passou|os que passaram|manha|ja avisados)/.test(
      raw
    ) ||
    /^(conclui tudo|baixa(?:r)? tudo|dei baixa em tudo|tudo concluido)\b/.test(raw)
  ) {
    return { kind: "baixa_all_past" };
  }

  if (REMOVE_VERB.test(raw) && /\b(grupo|autoriza|contato)\b/.test(raw)) {
    return null;
  }

  const isRemoveAgenda =
    REMOVE_VERB.test(raw) &&
    (AGENDA_NOUN.test(raw) || /\bontem\b/.test(raw) || /:/.test(raw));
  if (!BAIXA_VERB.test(raw) && !isRemoveAgenda) {
    return null;
  }

  if (
    /\bcomo (faco|faz)\b/.test(raw) ||
    /^(?:quero\s+)?(?:remover|cancelar|baixar|desmarcar)\s+(?:um |o |a )?(?:compromisso|lembrete|reuniao)\s*[?.!]*$/.test(
      raw
    )
  ) {
    return { kind: "baixa_ask" };
  }

  const indices = new Set<number>();
  for (const m of raw.matchAll(/\b(\d{1,2})\b/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 40) indices.add(n);
  }
  if (/primeiro/.test(raw)) indices.add(1);
  if (/segundo/.test(raw)) indices.add(2);
  if (/terceiro/.test(raw)) indices.add(3);

  if (indices.size) {
    return {
      kind: "baixa_indices",
      indices: [...indices].sort((a, b) => a - b),
    };
  }

  const titled = raw.match(
    /\b(?:dei baixa|dar baixa|baix(?:a|ar)|conclui(?:do)?|remover|remove|remova|cancelar|cancela|cancele|desmarcar|desmarca)\s+(?:de |do |da |no |na |em |o |a |um |uma )?(.{3,140})$/
  );
  const query = titled?.[1]?.replace(/[?.!]+$/g, "").trim() || "";
  if (query && !/^(tudo|todos|hoje|agora)$/.test(query)) {
    const queries = query
      .split(/\s+e\s+/)
      .map((part) => cleanBaixaQuery(part))
      .filter((part) => part.length >= 3 && !/^(pdf|excel|arquivo|relatorio)$/.test(part));
    if (queries.length) return { kind: "baixa_query", queries };
    if (AGENDA_NOUN.test(raw) || isRemoveAgenda) return { kind: "baixa_ask" };
  }

  if (AGENDA_NOUN.test(raw) || isRemoveAgenda) return { kind: "baixa_ask" };
  return null;
}

function titleHitsQuery(title: string, query: string): boolean {
  const t = foldBaixa(displayAgendaTitle(title));
  const q = foldBaixa(query);
  if (!q) return false;
  if (t.includes(q) || foldBaixa(title).includes(q)) return true;
  const words = q.split(/\s+/).filter((w) => w.length >= 3);
  return Boolean(words.length) && words.every((w) => t.includes(w));
}

export async function loadTodayReminders(
  db: Db,
  workspaceId: string,
  timezone: string
): Promise<DayReminderRow[]> {
  const day = DateTime.now().setZone(timezone);
  const { start, end } = dayRange(day);
  const rows = await db.query.reminders.findMany({
    where: and(eq(reminders.workspaceId, workspaceId), isNull(reminders.deletedAt)),
  });
  return rows
    .filter((r) => {
      if (isInternalTestReminder(r.title, r.payload)) return false;
      if (
        r.status !== "scheduled" &&
        r.status !== "queued" &&
        r.status !== "sent"
      ) {
        return false;
      }
      return r.fireAt >= start && r.fireAt <= end;
    })
    .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
    .map((r) => ({
      id: r.id,
      title: r.title,
      fireAt: r.fireAt,
      timezone: r.timezone || timezone,
      status: r.status,
      recurrenceRule: r.recurrenceRule,
      payload: r.payload,
    }));
}

export function isPastReminder(row: DayReminderRow, timezone: string): boolean {
  const now = DateTime.now().setZone(timezone);
  const at = DateTime.fromJSDate(row.fireAt).setZone(row.timezone || timezone);
  return at <= now || row.status === "sent";
}

/** Ordem da lista numerada: já passaram → ainda por vir. */
export function orderTodayRemindersForBaixa(
  rows: DayReminderRow[],
  timezone: string
): DayReminderRow[] {
  const past = rows.filter((r) => isPastReminder(r, timezone));
  const upcoming = rows.filter((r) => !isPastReminder(r, timezone));
  return [...past, ...upcoming];
}

const SPOKEN_STOP = new Set([
  "ja",
  "paguei",
  "pago",
  "quitei",
  "fiz",
  "feito",
  "conclui",
  "concluido",
  "tira",
  "tire",
  "pode",
  "tirar",
  "o",
  "a",
  "os",
  "as",
  "de",
  "do",
  "da",
  "que",
  "um",
  "uma",
  "meu",
  "minha",
  "conta",
  "pagar",
  "pagamento",
]);

/** “já paguei o telefone” / “tira a apresentação” → o assunto, sem o verbo. */
export function parseSpokenDone(text: string): string | null {
  const raw = foldBaixa(text);
  if (!raw || raw.length > 140) return null;
  const m = raw.match(
    /^(?:ja\s+)?(?:paguei|pago|quitei|fiz|feito|conclui(?:do)?|tira|tire|pode tirar)\s+(.{2,80})$/
  );
  if (!m?.[1]) return null;
  const words = m[1]
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !SPOKEN_STOP.has(w));
  if (!words.length) return null;
  return words.join(" ");
}

function foldBaixa(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function appointmentIdFromPayload(
  payload: ReminderPayload | Record<string, unknown> | null | undefined
): string | null {
  const note = String((payload as ReminderPayload | null)?.note || "");
  const m = note.match(/appointment:([0-9a-f-]{36})/i);
  return m?.[1] || null;
}

/** Formata agenda do dia (só lembretes) com numeração + CTA de baixa. */
export function formatInteractiveDayAgenda(
  rows: DayReminderRow[],
  timezone: string
): string {
  if (!rows.length) return "📭 *Seu dia* — nada anotado aqui ainda.";

  const past = rows.filter((r) => isPastReminder(r, timezone));
  const upcoming = rows.filter((r) => !isPastReminder(r, timezone));

  const lines: string[] = [`📅 *Seu dia* (${rows.length})`, ""];

  let n = 1;
  const render = (r: DayReminderRow, forcePast: boolean) => {
    const idx = n++;
    const body = formatReminderListItem({
      title: r.title,
      fireAt: r.fireAt,
      timezone: r.timezone || timezone,
      payload: (r.payload || {}) as ReminderPayload,
      recurrenceRule: r.recurrenceRule,
      status: forcePast || r.status === "sent" ? "sent" : r.status,
    });
    return body.replace(/^• /, `*${idx}.* `);
  };

  if (past.length && upcoming.length) {
    lines.push("*Já passou*");
    for (const r of past) lines.push(render(r, true));
    lines.push("");
    lines.push("*Ainda vai*");
    for (const r of upcoming) lines.push(render(r, false));
  } else {
    for (const r of [...past, ...upcoming]) lines.push(render(r, past.includes(r)));
  }

  lines.push("");
  lines.push("_Concluir:_ *baixa 1*");
  return lines.join("\n");
}

/** Dá baixa em lembrete: para aviso, cancela recorrência/outbox, tarefa homônima e compromisso ligado. */
export async function completeReminderById(
  db: Db,
  input: { workspaceId: string; reminderId: string }
): Promise<{ ok: boolean; title?: string; error?: string }> {
  const row = await db.query.reminders.findFirst({
    where: and(
      eq(reminders.id, input.reminderId),
      eq(reminders.workspaceId, input.workspaceId),
      isNull(reminders.deletedAt)
    ),
  });
  if (!row) return { ok: false, error: "not_found" };

  const payload = {
    ...((row.payload || {}) as Record<string, unknown>),
    baixado: true,
  };
  await db
    .update(reminders)
    .set({
      status: "cancelled",
      payload,
      recurrenceRule: null,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(reminders.id, row.id));

  await db.execute(sql`
    UPDATE alert_outbox
    SET status = 'cancelled', updated_at = NOW()
    WHERE source_type = 'reminder'
      AND source_id = ${row.id}
      AND status IN ('pending', 'processing', 'failed')
  `);

  const reminderPayload = (row.payload || {}) as Record<string, unknown>;
  if (typeof reminderPayload.google_event_id === "string") {
    const { deleteAppointmentFromGoogle } = await import(
      "@/integrations/google/auto-push"
    );
    await deleteAppointmentFromGoogle(db, {
      workspaceId: input.workspaceId,
      eventId: reminderPayload.google_event_id,
    });
  }

  await db
    .update(tasks)
    .set({
      status: "completed",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.workspaceId, input.workspaceId),
        eq(tasks.title, row.title),
        eq(tasks.status, "open"),
        isNull(tasks.deletedAt)
      )
    );

  const apptId = appointmentIdFromPayload(row.payload);
  const memberAppointmentId = String(reminderPayload.member_appointment_id || "");
  if (memberAppointmentId && reminderPayload.team_reminder === true) {
    await db
      .update(appointments)
      .set({ status: "completed", updatedAt: new Date() })
      .where(
        and(
          eq(appointments.id, memberAppointmentId),
          eq(appointments.workspaceId, input.workspaceId)
        )
      );
  }
  if (apptId && reminderPayload.team_reminder !== true) {
    const appointment = await db.query.appointments.findFirst({
      where: and(
        eq(appointments.id, apptId),
        eq(appointments.workspaceId, input.workspaceId),
        isNull(appointments.deletedAt)
      ),
    });
    await db
      .update(appointments)
      .set({ status: "completed", updatedAt: new Date() })
      .where(
        and(
          eq(appointments.id, apptId),
          eq(appointments.workspaceId, input.workspaceId)
        )
      );
    const { cancelAppointmentTeamDeliveries } = await import(
      "@/domain/team-reminders"
    );
    await cancelAppointmentTeamDeliveries(db, apptId);
    const googleEventId = String(
      (appointment?.metadata as Record<string, unknown> | null)?.google_event_id || ""
    );
    if (googleEventId) {
      const { deleteAppointmentFromGoogle } = await import(
        "@/integrations/google/auto-push"
      );
      await deleteAppointmentFromGoogle(db, {
        workspaceId: input.workspaceId,
        eventId: googleEventId,
      });
    }
  }

  return { ok: true, title: row.title };
}

export function looksLikeYesterdayAsk(text: string): boolean {
  const t = foldBaixa(text);
  return /o que (ficou|sobrou) de ontem|pendencias de ontem|lista de ontem/.test(t);
}

export async function replyYesterdayOpen(
  db: Db,
  input: { workspaceId: string; timezone: string }
): Promise<string> {
  const now = DateTime.now().setZone(input.timezone || "America/Sao_Paulo");
  const yStart = now.startOf("day").minus({ days: 1 }).toJSDate();
  const yEnd = now.startOf("day").minus({ milliseconds: 1 }).toJSDate();
  const rows = await db.query.reminders.findMany({
    where: and(
      eq(reminders.workspaceId, input.workspaceId),
      eq(reminders.status, "sent"),
      isNull(reminders.deletedAt),
      gte(reminders.fireAt, yStart),
      lte(reminders.fireAt, yEnd)
    ),
  });
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const r of rows) {
    if (/^\[fam[ií]lia/i.test(r.title)) continue;
    const key = foldBaixa(r.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    titles.push(r.title);
  }
  if (!titles.length) return "Nada de ontem em aberto.";
  return [
    "*Ainda de ontem*",
    ...titles.slice(0, 8).map((t, i) => `${i + 1}. ${t}`),
    "",
    "Para tirar, fale o nome: *já paguei a luz* ou *já fiz o boleto da Bistek*.",
  ].join("\n");
}

async function listOpenForBaixa(
  db: Db,
  workspaceId: string,
  timezone: string
): Promise<string> {
  const today = await loadDayAgenda(db, workspaceId, timezone);
  const now = DateTime.now().setZone(timezone || "America/Sao_Paulo");
  const yStart = now.startOf("day").minus({ days: 1 }).toJSDate();
  const yEnd = now.startOf("day").minus({ milliseconds: 1 }).toJSDate();
  const yReminders = await db.query.reminders.findMany({
    where: and(
      eq(reminders.workspaceId, workspaceId),
      isNull(reminders.deletedAt),
      gte(reminders.fireAt, yStart),
      lte(reminders.fireAt, yEnd)
    ),
  });
  const yAppts = await db.query.appointments.findMany({
    where: and(
      eq(appointments.workspaceId, workspaceId),
      eq(appointments.status, "scheduled"),
      isNull(appointments.deletedAt),
      gte(appointments.startsAt, yStart),
      lte(appointments.startsAt, yEnd)
    ),
  });
  const seen = new Set<string>();
  const yesterday: string[] = [];
  for (const row of [...yReminders, ...yAppts]) {
    if (
      "status" in row &&
      row.status !== "scheduled" &&
      row.status !== "queued" &&
      row.status !== "sent"
    ) {
      continue;
    }
    const label = displayAgendaTitle(row.title);
    const key = foldBaixa(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    yesterday.push(label);
  }
  if (!today.length && !yesterday.length) {
    return "Não tem compromisso em aberto. Diga o título, tipo *baixar Falar com Adan*.";
  }
  const lines = ["Para tirar da lista, diga o nome. Ex.: *baixar Falar com Adan*."];
  if (yesterday.length) {
    lines.push("", "*Ainda de ontem*");
    for (const title of yesterday.slice(0, 8)) lines.push(`• ${title}`);
  }
  if (today.length) {
    lines.push("", `*Hoje* (${today.length})`);
    for (const item of today.slice(0, 8)) {
      lines.push(`• ${displayAgendaTitle(item.title)}`);
    }
  }
  return lines.join("\n");
}

/** “já paguei o telefone” fecha o item com esse nome, inclusive o de ontem. Não usa o último comprovante aberto. */
export async function applySpokenDone(
  db: Db,
  input: { workspaceId: string; text: string }
): Promise<string | null> {
  const subject = parseSpokenDone(input.text);
  if (!subject) return null;
  const words = subject.split(/\s+/);
  const all = await db.query.reminders.findMany({
    where: and(
      eq(reminders.workspaceId, input.workspaceId),
      isNull(reminders.deletedAt)
    ),
  });
  const hits = all.filter((r) => {
    if (r.status !== "scheduled" && r.status !== "queued" && r.status !== "sent") {
      return false;
    }
    const title = foldBaixa(r.title);
    return words.every((w) => title.includes(w));
  });
  if (!hits.length) {
    return `Não achei *${subject}* em aberto. Diga o nome como está na lista, ou *o que ficou de ontem?*`;
  }
  if (hits.length > 3) {
    return [
      `Achei ${hits.length} com “${subject}”. Diga o nome mais completo, ou:`,
      ...hits.slice(0, 5).map((r, i) => `${i + 1}. ${r.title}`),
    ].join("\n");
  }
  const done: string[] = [];
  for (const hit of hits) {
    const r = await completeReminderById(db, {
      workspaceId: input.workspaceId,
      reminderId: hit.id,
    });
    if (r.ok && r.title && !done.includes(r.title)) done.push(r.title);
  }
  if (!done.length) return "Não consegui dar baixa agora.";
  return [`✅ *Baixa:* ${done.map((t) => `*${t}*`).join(", ")}`, "Saiu da lista."].join("\n");
}

export async function applyBaixaIntent(
  db: Db,
  input: {
    workspaceId: string;
    timezone: string;
    intent: BaixaIntent;
  }
): Promise<string> {
  if (input.intent.kind === "ainda_nao") {
    return "Beleza 🙂 Deixo como está. Quando concluir, diga *baixa 1* (ou o número).";
  }

  if (input.intent.kind === "baixa_ask") {
    return listOpenForBaixa(db, input.workspaceId, input.timezone);
  }

  const items = await loadDayAgenda(db, input.workspaceId, input.timezone);
  if (input.intent.kind === "baixa_query") {
    const picked: DayAgendaItem[] = [];
    for (const query of input.intent.queries) {
      for (const item of items) {
        if (titleHitsQuery(item.title, query) && !picked.includes(item)) picked.push(item);
      }
    }
    if (picked.length) return finishAgendaItems(db, input.workspaceId, picked);
    const all = await db.query.reminders.findMany({
      where: and(
        eq(reminders.workspaceId, input.workspaceId),
        isNull(reminders.deletedAt)
      ),
    });
    const open = all.filter(
      (r) =>
        r.status === "scheduled" || r.status === "queued" || r.status === "sent"
    );
    const done: string[] = [];
    for (const query of input.intent.queries) {
      const hits = open.filter((r) => titleHitsQuery(r.title, query));
      for (const hit of hits) {
        const r = await completeReminderById(db, {
          workspaceId: input.workspaceId,
          reminderId: hit.id,
        });
        if (r.ok && r.title && !done.includes(displayAgendaTitle(r.title))) {
          done.push(displayAgendaTitle(r.title));
        }
      }
    }
    const apptRows = await db.query.appointments.findMany({
      where: and(
        eq(appointments.workspaceId, input.workspaceId),
        eq(appointments.status, "scheduled"),
        isNull(appointments.deletedAt)
      ),
    });
    for (const query of input.intent.queries) {
      for (const appt of apptRows) {
        if (!titleHitsQuery(appt.title, query)) continue;
        await finishAppointment(db, input.workspaceId, appt.id);
        const label = displayAgendaTitle(appt.title);
        if (!done.includes(label)) done.push(label);
      }
    }
    if (!done.length) {
      return `Não achei “${input.intent.queries.join("” nem “")}” em aberto. Diga o nome como na lista, ou *o que ficou de ontem?*`;
    }
    return [
      `✅ *Baixa registrada* (${done.length}):`,
      ...done.map((t) => `• ${t}`),
      "",
      "Saíram da lista.",
    ].join("\n");
  }

  if (!items.length) {
    return "Não achei nada de hoje pra dar baixa. Peça *o que tenho hoje?*";
  }

  let targets: DayAgendaItem[] = [];
  if (input.intent.kind === "baixa_all_past") {
    const now = Date.now();
    targets = items.filter((item) => !item.googleOnly && item.at.getTime() <= now);
    if (!targets.length) {
      return "Nada que já tenha passado o horário hoje. Os próximos ainda estão por vir.";
    }
  } else {
    for (const i of input.intent.indices) {
      const item = items[i - 1];
      if (item) targets.push(item);
    }
    if (!targets.length) {
      return `Não achei o número na lista de hoje. Peça *o que tenho hoje?* e use *baixa 1* ou *baixa 1 e 2*.`;
    }
  }

  return finishAgendaItems(db, input.workspaceId, targets);
}

async function finishAgendaItems(
  db: Db,
  workspaceId: string,
  targets: DayAgendaItem[]
): Promise<string> {
  const done: string[] = [];
  const google: string[] = [];
  for (const item of targets) {
    if (item.googleOnly && !item.reminderIds.length && !item.appointmentIds.length) {
      google.push(item.title);
      continue;
    }
    for (const id of item.reminderIds) {
      await completeReminderById(db, { workspaceId, reminderId: id });
    }
    for (const id of item.appointmentIds) {
      await finishAppointment(db, workspaceId, id);
    }
    if (!done.includes(item.title)) done.push(item.title);
  }
  if (!done.length && google.length) {
    return `*${google.join(", ")}* está só no Google. A baixa daqui não tira de lá.`;
  }
  if (!done.length) return "Não consegui dar baixa agora.";
  const lines = [
    `✅ *Baixa registrada* (${done.length}):`,
    ...done.map((title) => `• ${title}`),
    "",
    "Saíram da lista.",
  ];
  if (google.length) {
    lines.push("", `No Google, continua: ${google.join(", ")}.`);
  }
  return lines.join("\n");
}

async function finishAppointment(db: Db, workspaceId: string, appointmentId: string) {
  const row = await db.query.appointments.findFirst({
    where: and(
      eq(appointments.id, appointmentId),
      eq(appointments.workspaceId, workspaceId),
      isNull(appointments.deletedAt)
    ),
  });
  if (!row || row.status !== "scheduled") return;
  await db
    .update(appointments)
    .set({ status: "completed", updatedAt: new Date() })
    .where(eq(appointments.id, row.id));
  const { cancelAppointmentTeamDeliveries } = await import("@/domain/team-reminders");
  await cancelAppointmentTeamDeliveries(db, row.id);
  const linked = await db.query.reminders.findMany({
    where: and(eq(reminders.workspaceId, workspaceId), isNull(reminders.deletedAt)),
  });
  for (const reminder of linked) {
    if (!["scheduled", "queued", "sent"].includes(String(reminder.status))) continue;
    const payload = (reminder.payload || {}) as ReminderPayload & { appointment_id?: string };
    const note = String(payload.note || "");
    if (payload.appointment_id === row.id || note.includes(`appointment:${row.id}`)) {
      await completeReminderById(db, { workspaceId, reminderId: reminder.id });
    }
  }
}
