import { facejusAgendaKind } from "@/domain/facejus-commands";
import { isLocadoraAcaoPhrase } from "@/domain/locadora-phrases";
import {
  ensureFutureFireAt,
  hasExplicitClockTime,
  parseNaturalDateTime,
  suggestReminderHour,
} from "@/lib/datetime";

function foldAct(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Consulta de mapa ou de empresa. O assunto de um compromisso não entra aqui. */
function isTravelOrBusinessQuery(text: string): boolean {
  const t = foldAct(text);
  if (/(quanto tempo|demora|transito|deslocamento)/.test(t) && /(ate|pra|para)\b/.test(t)) {
    return true;
  }
  if (/^(rota|transito)\b/.test(t)) return true;
  if (facejusAgendaKind(text)) return true;
  return /^(resumo da locadora|frota da locadora|locatarios da locadora|investidores da locadora|veiculos da locadora|agenda juridica|prazos judiciais)\b/.test(
    t
  );
}

/**
 * Pedido explícito de criar compromisso (não listagem / não lembrete).
 * Vale “anotar compromisso”, “ligar às 17h” e frase que começa no horário
 * (“18h00 verificar…”). Palavra de locadora, rota ou carrinho no assunto não tira o ato.
 */
export function looksLikeAppointmentCreate(text: string): boolean {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (typeof isLocadoraAcaoPhrase === "function" && isLocadoraAcaoPhrase(raw)) {
    return false;
  }
  const p = foldAct(raw);
  if (/\b(me lembra|me lembre|lembrar|lembrete)\b/.test(p)) return false;
  if (/\b(cancela|desmarca|remarca|adia)\b/.test(p)) return false;
  if (isTravelOrBusinessQuery(raw)) return false;
  if (
    /(o que (eu )?tenho|minha agenda|lista\s+(de\s+)?compromissos?|quais\s+compromissos|meus\s+compromissos|compromissos?\s+(de|hoje|amanha))/.test(
      p
    ) &&
    !/\b(agenda|agendar|marque|marcar|anotar|anota)\b/.test(p)
  ) {
    return false;
  }
  const scheduleVerb =
    /\b(agenda|agendar|marque|marcar|marca|compromisso|anotar|anota|anote)\b/.test(
      p
    ) || /\breuniao\b/.test(p);
  const callAtTime = /\b(ligar|ligacao)\b/.test(p);
  const words = p.split(/\s+/).filter(Boolean).length;
  const clockLed =
    words >= 4 && (/^\d{1,2}h\d{0,2}\b/.test(p) || /^as\s+\d{1,2}\b/.test(p));
  if (!scheduleVerb && !callAtTime && !clockLed) return false;
  return hasExplicitClockTime(raw);
}

/** Minutos de antecedência. Sem pedido: 15. “Na hora”: 0. */
export function reminderMinutesFromText(text: string): number {
  const t = String(text || "").toLowerCase();
  if (/\bna hora\b/.test(t) && !/\bantes\b/.test(t)) return 0;
  if (/\bmeia\s+hora\s+antes\b/.test(t)) return 30;
  if (/\b(?:uma|1)\s+hora\s+antes\b/.test(t)) return 60;
  const hours = t.match(/\b(\d{1,2})\s+horas?\s+antes\b/);
  if (hours) return Math.min(1440, Number(hours[1]) * 60);
  const mins = t.match(/\b(\d{1,3})\s*min(?:uto)?s?\s+antes\b/);
  if (mins) return Math.min(1440, Number(mins[1]));
  return 15;
}

function meetingPurpose(text: string): string | null {
  const m = String(text || "").match(
    /\bque\s+ser[aá]\s+(?:uma?\s+|um\s+)?([^.,!?]+)/i
  );
  if (!m?.[1]) return null;
  const purpose = m[1]
    .replace(/\b(?:e\s+)?(?:me\s+)?(?:avis\w*|lembr\w*)\b[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (purpose.length < 3) return null;
  return purpose.charAt(0).toUpperCase() + purpose.slice(1);
}

function cleanScheduleTitle(title: string, fallback: string): string {
  let t = title
    .replace(/\b(?:e\s+)?(?:me\s+)?(?:avis\w*|lembr\w*)\b[\s\S]*$/i, " ")
    .replace(/\bmeia\s+hora\s+antes\b/gi, " ")
    .replace(/\b(?:uma|1|\d{1,2})\s+horas?\s+antes\b/gi, " ")
    .replace(/\b\d{1,3}\s*min(?:uto)?s?\s+antes\b/gi, " ")
    .replace(
      /^(?:tenho\s+)?(?:um\s+|uma\s+)?(?:compromisso|reuni[aã]o)\b[:\s-]*/i,
      " "
    )
    .replace(/^(amanh[ãa]|hoje)\s*[:,\-]\s*/i, "")
    .replace(/^\s*(de|da|do|pra|para|uma|um|:|,)+\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[?.!,;:]+$/g, "")
    .trim();
  if (!t || t.length < 2 || /^\d{1,3}\s*min/i.test(t)) t = fallback;
  return t.slice(0, 500);
}

export function extractAppointmentTitle(text: string): string {
  let title = String(text || "")
    .replace(
      /^[\s\S]*?\b(agenda|agendar|marque|marcar|marca|anotar|anota|anote|ligar|liga[cç][aã]o|tenho\s+compromisso|compromisso|reuni[aã]o)\b/i,
      ""
    )
    .replace(
      /(^|\s)(amanh[ãa]|hoje|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo|semana que vem)(?=\s|$)/gi,
      " "
    )
    .replace(
      /(^|\s)(às?|as)\s*\d{1,2}(?:[:h]\d{2})?\s*h?(?:oras|s)?(?=\s|$|[.,!?])/gi,
      " "
    )
    .replace(/(^|\s)\d{1,2}h\d{2}(?=\s|$|[.,!?])/gi, " ")
    .replace(/(^|\s)\d{1,2}:\d{2}(?=\s|$|[.,!?])/g, " ")
    .replace(/(^|\s)\d{1,2}\s*hs?(?=\s|$|[.,!?])/gi, " ")
    .replace(/^\s*(de|pra|para|uma|um|:)\s+/i, "");
  const purpose = meetingPurpose(text);
  if (purpose) return purpose.slice(0, 500);
  const fallback = /reuni[aã]o/i.test(text) ? "Reunião" : "Compromisso";
  return cleanScheduleTitle(title, fallback);
}

export function buildCreateAppointmentArgs(
  text: string,
  timezone: string
): {
  title: string;
  starts_at_iso: string;
  timezone: string;
  reminder_before_minutes: number;
} | null {
  if (!looksLikeAppointmentCreate(text)) return null;
  if (!hasExplicitClockTime(text)) return null;
  const when =
    parseNaturalDateTime(text, timezone) ||
    parseNaturalDateTime(`amanhã às ${suggestReminderHour(text)}h`, timezone);
  if (!when?.isValid) return null;
  const starts = ensureFutureFireAt(when.toJSDate(), timezone);
  return {
    title: extractAppointmentTitle(text),
    starts_at_iso: new Date(starts).toISOString(),
    timezone,
    reminder_before_minutes: reminderMinutesFromText(text),
  };
}

export function looksLikePhantomAppointmentConfirm(reply: string): boolean {
  const t = String(reply || "");
  return (
    /agendei|vou agendar|compromisso (criado|agendado)|reuni[aã]o .*agendada/i.test(
      t
    ) && /pronto|✅/i.test(t)
  );
}
