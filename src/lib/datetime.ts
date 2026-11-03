import { DateTime } from "luxon";

const WEEKDAYS: Record<string, number> = {
  domingo: 7,
  segunda: 1,
  "segunda-feira": 1,
  terca: 2,
  "terça": 2,
  "terca-feira": 2,
  "terça-feira": 2,
  quarta: 3,
  "quarta-feira": 3,
  quinta: 4,
  "quinta-feira": 4,
  sexta: 5,
  "sexta-feira": 5,
  sabado: 6,
  "sábado": 6,
};

export function nowInTimezone(timezone: string): DateTime {
  return DateTime.now().setZone(timezone);
}

/** True se o texto trouxe horário explícito (ex.: 10h, 11h30, 18h00, 18:30, daqui a 2 horas). */
export function hasExplicitClockTime(text: string): boolean {
  const raw = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return (
    /\b\d{1,2}h\d{2}\b/.test(raw) || // 11h30 / 18h00
    /\b\d{1,2}hs?\b/.test(raw) || // 11h / 11hs
    /(\d{1,2})(?::(\d{2}))?\s*h(?:oras)?\b/.test(raw) ||
    /\bas\s*\d{1,2}\b/.test(raw) || // às 10
    /\b\d{1,2}:\d{2}\b/.test(raw) ||
    /\bdaqui a \d+\s*(horas?|minutos?|mins?)\b/.test(raw)
  );
}

/** Sugestão de hora padrão conforme o tipo de lembrete (só para perguntar / fallback de conta). */
export function suggestReminderHour(text: string): number {
  const t = text.toLowerCase();
  if (
    /(condom[ií]nio|luz|agua|água|internet|telefone|conta|pagamento|boleto|fatura)/i.test(
      t
    )
  ) {
    return 18;
  }
  if (/(remedio|remédio|medicamento|tomar)/i.test(t)) return 8;
  return 9;
}

/**
 * Contas com alerta relativo ("2 dias antes", "todo mês dia 10") — 18h é ok sem perguntar.
 */
export function isBillStyleReminder(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /(dias? antes|todo m[eê]s|mensal|venc(e|imento)|boleto|condomin|conta de|fatura)/i.test(
      t
    ) || /\bdia \d{1,2}\b/.test(t)
  );
}

export function parseNaturalDateTime(
  text: string,
  timezone: string,
  now = nowInTimezone(timezone)
): DateTime | null {
  const raw = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const inMinutes = raw.match(/\bdaqui a (\d+)\s*(minutos?|mins?)\b/);
  if (inMinutes) {
    return now.plus({ minutes: Number(inMinutes[1]) });
  }
  const inHours = raw.match(/\bdaqui a (\d+)\s*horas?\b/);
  if (inHours) {
    return now.plus({ hours: Number(inHours[1]) });
  }

  // 11h30 / 18h00 / 8:30 / 08:30h / 11hs
  const timeMatch =
    raw.match(/\b(\d{1,2})h(\d{2})\b/) ||
    raw.match(/\b(\d{1,2}):(\d{2})\b/) ||
    raw.match(/\b(\d{1,2})hs?\b/) ||
    raw.match(/\bas\s*(\d{1,2})\b/) ||
    raw.match(/(\d{1,2})(?::(\d{2}))?\s*h(?:oras)?/);
  const hour = timeMatch
    ? Number(timeMatch[1])
    : suggestReminderHour(text);
  const minute = timeMatch?.[2] ? Number(timeMatch[2]) : 0;

  let base = now.set({ hour, minute, second: 0, millisecond: 0 });

  if (/\bamanha\b/.test(raw)) {
    base = base.plus({ days: 1 });
    return base;
  }
  if (/\bhoje\b/.test(raw)) {
    return base;
  }
  const dayNum = raw.match(/\bdia (\d{1,2})\b/);
  if (dayNum) {
    let candidate = now.set({
      day: Number(dayNum[1]),
      hour,
      minute,
      second: 0,
      millisecond: 0,
    });
    if (candidate < now) candidate = candidate.plus({ months: 1 });
    return candidate;
  }
  if (/semana que vem/.test(raw)) {
    base = base.plus({ weeks: 1 });
  }
  for (const [name, weekday] of Object.entries(WEEKDAYS)) {
    const normalizedName = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (raw.includes(normalizedName)) {
      let candidate = now.set({
        weekday: weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        hour,
        minute,
        second: 0,
        millisecond: 0,
      });
      if (candidate <= now) candidate = candidate.plus({ weeks: 1 });
      if (/semana que vem/.test(raw)) candidate = candidate.plus({ weeks: 0 });
      return candidate;
    }
  }
  // Só horário ("às 16:00" / "16h") → hoje nesse relógio
  if (timeMatch) return base;
  return null;
}

export function dayRange(
  when: DateTime
): { start: Date; end: Date } {
  const start = when.startOf("day");
  const end = when.endOf("day");
  return { start: start.toJSDate(), end: end.toJSDate() };
}

export function formatInTimezone(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).toFormat("dd/LL/yyyy HH:mm");
}

/**
 * Garante fire_at no futuro. Se a data já passou (ex.: alerta dia 8 e hoje é 20),
 * empurra mês a mês até ficar depois de agora — evita disparo imediato ao criar.
 * Para “hoje às Xh” que já passou, empurra 1 dia (não 1 mês).
 */
export function ensureFutureFireAt(
  fireAt: Date,
  timezone: string,
  now = nowInTimezone(timezone)
): Date {
  let dt = DateTime.fromJSDate(fireAt).setZone(timezone);
  if (!dt.isValid) return fireAt;
  if (dt > now) return dt.toJSDate();

  // Mesmo dia civil: sobe 1 dia (lembrete “hoje 16h” pedido às 15h ok; às 17h → amanhã)
  const sameCalendarDay =
    dt.hasSame(now, "day") ||
    Math.abs(dt.diff(now, "hours").hours) < 18;
  if (sameCalendarDay) {
    dt = dt.plus({ days: 1 });
    if (dt > now) return dt.toJSDate();
  }

  let guard = 0;
  while (dt <= now && guard < 36) {
    dt = dt.plus({ months: 1 });
    guard += 1;
  }
  return dt.toJSDate();
}

/**
 * Resolve horário do lembrete.
 * Se o usuário pediu horário explícito (16h / 16:00), esse relógio no fuso do
 * workspace ganha — evita LLM aplicar UTC-3 duas vezes (16→19).
 */
export function resolveReminderFireAt(input: {
  fireAtIso: string;
  timezone: string;
  userText?: string | null;
}): Date {
  const tz = input.timezone || "America/Sao_Paulo";
  const userText = String(input.userText || "");

  if (userText && hasExplicitClockTime(userText)) {
    const fromUser = parseNaturalDateTime(userText, tz);
    if (fromUser?.isValid) {
      return ensureFutureFireAt(fromUser.toJSDate(), tz);
    }
  }

  const raw = String(input.fireAtIso || "").trim();
  // ISO com offset/Z: respeita o instante
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const abs = DateTime.fromISO(raw, { setZone: true });
    if (abs.isValid) return ensureFutureFireAt(abs.toJSDate(), tz);
  }

  // Sem offset: interpretado como relógio de parede no fuso do usuário
  const wall = DateTime.fromISO(raw, { zone: tz });
  if (wall.isValid) return ensureFutureFireAt(wall.toJSDate(), tz);

  const fallback = new Date(raw);
  return ensureFutureFireAt(fallback, tz);
}
