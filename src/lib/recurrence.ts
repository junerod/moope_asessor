import { DateTime } from "luxon";

/**
 * Regras simples suportadas:
 * - daily | FREQ=DAILY | todo dia
 * - weekly | FREQ=WEEKLY | toda semana
 * - monthly | FREQ=MONTHLY | todo mês
 * - daily@20:00  (hora fixa)
 * - weekly:1     (1=segunda … 7=domingo, Luxon)
 */
export function nextFireFromRecurrence(
  lastFire: Date,
  timezone: string,
  ruleRaw: string | null | undefined
): Date | null {
  if (!ruleRaw) return null;
  const rule = ruleRaw.trim().toLowerCase();
  if (!rule) return null;

  let base = DateTime.fromJSDate(lastFire).setZone(timezone);
  if (!base.isValid) base = DateTime.now().setZone(timezone);

  const timeMatch = rule.match(/@(\d{1,2}):(\d{2})/);
  const hour = timeMatch ? Number(timeMatch[1]) : base.hour;
  const minute = timeMatch ? Number(timeMatch[2]) : base.minute;

  const isDaily = /daily|freq=daily|todo.?dia|todos?\s*os\s*dias|diari/.test(rule);
  const isWeekly = /weekly|freq=weekly|toda.?semana/.test(rule);
  const isMonthly = /monthly|freq=monthly|todo.?m[eê]s|mensal/.test(rule);

  let next: DateTime;
  if (isDaily) {
    next = base.plus({ days: 1 }).set({ hour, minute, second: 0, millisecond: 0 });
  } else if (isWeekly) {
    const wd = rule.match(/weekly:([1-7])/) || rule.match(/byday=([1-7])/);
    if (wd) {
      const target = Number(wd[1]);
      next = base.plus({ days: 1 });
      while (next.weekday !== target) next = next.plus({ days: 1 });
      next = next.set({ hour, minute, second: 0, millisecond: 0 });
    } else {
      next = base.plus({ weeks: 1 }).set({ hour, minute, second: 0, millisecond: 0 });
    }
  } else if (isMonthly) {
    const day = base.day;
    next = base.plus({ months: 1 }).set({
      day: Math.min(day, 28),
      hour,
      minute,
      second: 0,
      millisecond: 0,
    });
  } else {
    return null;
  }

  const now = DateTime.now().setZone(timezone);
  let guard = 0;
  while (next <= now && guard < 400) {
    if (isDaily) next = next.plus({ days: 1 });
    else if (isWeekly) next = next.plus({ weeks: 1 });
    else next = next.plus({ months: 1 });
    guard += 1;
  }

  return next.toJSDate();
}

export function describeRecurrence(ruleRaw: string | null | undefined): string {
  if (!ruleRaw) return "";
  const rule = ruleRaw.trim().toLowerCase();
  if (/daily|todo.?dia|todos?\s*os\s*dias|diari|freq=daily/.test(rule)) {
    const t = rule.match(/@(\d{1,2}):(\d{2})/);
    return t ? `todo dia às ${t[1]}:${t[2]}` : "todo dia";
  }
  const wd = rule.match(/weekly:([1-7])/);
  if (wd) {
    const names = [
      "",
      "segunda",
      "terça",
      "quarta",
      "quinta",
      "sexta",
      "sábado",
      "domingo",
    ];
    const t = rule.match(/@(\d{1,2}):(\d{2})/);
    const day = names[Number(wd[1])] || "semana";
    return t ? `toda ${day} às ${t[1]}:${t[2]}` : `toda ${day}`;
  }
  if (/weekly|freq=weekly|toda.?semana/.test(rule)) return "toda semana";
  if (/monthly|todo.?m[eê]s|mensal|freq=monthly/.test(rule)) return "todo mês";
  return ruleRaw;
}

export function toGoogleCalendarRecurrence(
  ruleRaw: string | null | undefined,
  startsAt: Date
): string[] | undefined {
  if (!ruleRaw) return undefined;
  const rule = ruleRaw.trim().toLowerCase();
  if (!rule) return undefined;
  if (/daily|freq=daily|todo.?dia|todos?\s*os\s*dias|diari/.test(rule)) {
    return ["RRULE:FREQ=DAILY"];
  }
  if (/weekly|freq=weekly|toda.?semana/.test(rule)) {
    const target = rule.match(/weekly:([1-7])/) || rule.match(/byday=([1-7])/);
    const weekdays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
    const weekday = target
      ? weekdays[Number(target[1]) - 1]
      : weekdays[Math.max(0, DateTime.fromJSDate(startsAt).weekday - 1)];
    return [`RRULE:FREQ=WEEKLY;BYDAY=${weekday}`];
  }
  if (/monthly|freq=monthly|todo.?m[eê]s|mensal/.test(rule)) {
    const day = Math.min(DateTime.fromJSDate(startsAt).day, 28);
    return [`RRULE:FREQ=MONTHLY;BYMONTHDAY=${day}`];
  }
  return undefined;
}

/** Extrai recurrence_rule a partir do texto do usuário. */
export function parseRecurrenceFromText(text: string): string | null {
  const raw = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!raw.trim()) return null;

  const timeMatch =
    raw.match(/\b(\d{1,2}):(\d{2})\b/) ||
    raw.match(/(\d{1,2})(?::(\d{2}))?\s*h(?:oras)?/);
  const hh = timeMatch ? String(Number(timeMatch[1])).padStart(2, "0") : null;
  const mm = timeMatch?.[2] ? timeMatch[2] : "00";
  const at = hh ? `@${hh}:${mm}` : "";

  if (/todo\s*dia|todos?\s*os\s*dias|diariamente|cada dia|de segunda a sexta|seg a sex|ate (eu )?dar baixa|ate (eu )?marcar|repete.*(dia|diario)/.test(
      raw
    )
  ) {
    return `daily${at}`;
  }

  // Toda segunda / terça… → weekly:N (Luxon 1=seg … 7=dom)
  const weekdayMap: Array<[RegExp, number]> = [
    [/toda\s+segunda/, 1],
    [/toda\s+terca/, 2],
    [/toda\s+quarta/, 3],
    [/toda\s+quinta/, 4],
    [/toda\s+sexta/, 5],
    [/todo\s+sabado/, 6],
    [/todo\s+domingo/, 7],
  ];
  for (const [re, wd] of weekdayMap) {
    if (re.test(raw)) return `weekly:${wd}${at}`;
  }

  if (/toda\s*semana|semanalmente/.test(raw)) {
    return `weekly${at}`;
  }
  if (/todo\s*mes|mensalmente|todo mes dia/.test(raw)) {
    return `monthly${at}`;
  }
  return null;
}
