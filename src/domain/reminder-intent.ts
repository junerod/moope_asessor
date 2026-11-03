import {
  hasExplicitClockTime,
  isBillStyleReminder,
  parseNaturalDateTime,
  suggestReminderHour,
} from "@/lib/datetime";
import { parseRecurrenceFromText } from "@/lib/recurrence";

/**
 * Detecta pedido explícito de criar lembrete (não listagem).
 * Usado para rota determinística — o LLM frequentemente confirma sem tool.
 */
export function looksLikeReminderCreate(text: string): boolean {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const p = raw.toLowerCase();

  // Negativas / perguntas retóricas (“não tem de lembrar…?”)
  if (
    /\bn[aã]o\s+(me\s+)?lembr/i.test(p) ||
    /\bn[aã]o\s+tem\s+(de|que)\s+lembr/i.test(p) ||
    /\b(cancela|desmarca|apaga|remove)\b/i.test(p)
  ) {
    return false;
  }

  // Listagem — não confundir com “Lembrete às 18h00: …”
  if (
    /(o que (eu )?tenho|minha agenda|quais?\s+lembretes|meus?\s+lembretes|lista\s+(de\s+)?(lembrete|compromisso)|compromissos?\s+(de|hoje|amanh))/i.test(
      p
    ) &&
    !/\b(me lembra|me lembre|lembrar|me avisa|avise)\b/i.test(p) &&
    !/^lembrete\b/i.test(raw.trim())
  ) {
    return false;
  }

  if (!/\b(me lembra|me lembre|me lembrar|lembrar|lembrete|me avisa|avise)\b/i.test(p)) {
    if (!/preciso que me lembre/i.test(p)) return false;
  }

  return hasExplicitClockTime(raw) || isBillStyleReminder(raw);
}

/** Extrai título legível a partir de “me lembre … de X”. */
export function extractReminderTitle(text: string): string {
  let title = String(text || "");
  title = title.replace(
    /^[\s\S]*?\b(me lembra|me lembre|lembrar|lembrete|me avisa|avise)\b/i,
    ""
  );

  // Evita \b com acentos (JS trata à/ã como non-word e quebra a âncora)
  title = title
    .replace(
      /(^|\s)(amanh[ãa]|hoje|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo|semana que vem)(?=\s|$)/gi,
      " "
    )
    .replace(/(^|\s)(às?|as)\s*\d{1,2}h\d{2}(?=\s|$|[.,!:?])/gi, " ")
    .replace(
      /(^|\s)(às?|as)\s*\d{1,2}(?:[:h]\d{2})?\s*h?(?:oras|s)?(?=\s|$|[.,!?])/gi,
      " "
    )
    .replace(/(^|\s)\d{1,2}h\d{2}(?=\s|$|[.,!:?])/gi, " ")
    .replace(/(^|\s)\d{1,2}:\d{2}(?=\s|$|[.,!?])/g, " ")
    .replace(/(^|\s)\d{1,2}\s*hs?(?:oras)?(?=\s|$|[.,!?])/gi, " ")
    .replace(/(^|\s)daqui a \d+\s*(horas?|minutos?|mins?)(?=\s|$)/gi, " ")
    .replace(/^\s*(de|pra|para|que|:)\s+/i, "")
    .replace(/^\s*oie?,?\s*/i, "")
    .replace(/\s+(às?|as)\s*$/i, "")
    .replace(/^[.:\s]+/, "")
    .replace(/[?.!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  title = title
    .replace(/^\d{1,3}\s*min(?:uto)?s?\s+antes(?:\s+d[eao]s?)?\s*/i, "")
    .replace(/\s+\b(?:me\s+)?avis[ae](?:-me)?\s+\d{1,3}\s*min(?:uto)?s?\s+antes\b[\s\S]*$/i, " ")
    .replace(/^\s*(de|da|do|pra|para)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (
    !title ||
    title.length < 2 ||
    /^(de|pra|para|as|às)$/i.test(title) ||
    /^\d{1,3}\s*min(?:uto)?s?\s+antes$/i.test(title)
  ) {
    title = "Lembrete";
  }
  return title.slice(0, 500);
}

export function buildCreateReminderArgs(
  text: string,
  timezone: string
): {
  title: string;
  fire_at_iso: string;
  timezone: string;
  recurrence_rule?: string;
  kind?: string;
  also_task?: boolean;
} | null {
  if (!looksLikeReminderCreate(text)) return null;

  // Sem horário explícito e não é conta → perguntar (não cria ainda)
  if (!hasExplicitClockTime(text) && !isBillStyleReminder(text)) {
    return null;
  }

  const when =
    parseNaturalDateTime(text, timezone) ||
    parseNaturalDateTime(
      `amanhã às ${suggestReminderHour(text)}h`,
      timezone
    );
  if (!when?.isValid) return null;

  const recurrence = parseRecurrenceFromText(text) || undefined;
  const title = extractReminderTitle(text);
  const kind = isBillStyleReminder(text) ? "conta" : "geral";

  return {
    title,
    fire_at_iso: when.toUTC().toISO()!,
    timezone,
    ...(recurrence ? { recurrence_rule: recurrence } : {}),
    kind,
    ...(/\b(final do dia|lista|preciso|verificar|cobrar|falar com)\b/i.test(text)
      ? { also_task: true }
      : {}),
  };
}

/** Texto do modelo que finge ter criado lembrete sem tool. */
export function looksLikePhantomReminderConfirm(reply: string): boolean {
  const t = String(reply || "");
  return (
    /vou te lembrar/i.test(t) ||
    /te lembro (de|às|amanh|hoje)/i.test(t) ||
    (/lembrete criado/i.test(t) && /pronto/i.test(t))
  );
}
