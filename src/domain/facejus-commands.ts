/**
 * Duas agendas do Facejus, com frase própria.
 * Agenda pessoal, “agenda jurídica” e “agenda OAB” continuam no caminho que já tinham.
 */

export type FacejusAgendaKind = "atendimento" | "prazos";

function fold(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** Gravar na agenda pessoal. Não é consulta do escritório. */
function isPersonalScheduleVerb(text: string): boolean {
  return /\b(agendar|marcar|marque|marca|anotar|anota|anote|me lembra|me lembre|lembrete)\b/.test(
    text
  );
}

export function facejusAgendaKind(text: string): FacejusAgendaKind | null {
  const t = fold(text);
  if (!t || t.length > 240) return null;
  if (isPersonalScheduleVerb(t)) return null;

  const atendimento =
    /\bagenda de atendimentos?\b/.test(t) ||
    /\bagenda de consultas?\b/.test(t) ||
    /\b(meus|minhas) atendimentos?\b/.test(t) ||
    /\batendimentos?\s+(de|da|do)\s+(hoje|amanha|semana|mes|filial|oab)\b/.test(t) ||
    /\batendimentos?\s+oab\b/.test(t) ||
    (/\boab\b/.test(t) && /\batendimentos?\b/.test(t)) ||
    (/\bpdf\b/.test(t) && /\batendimentos?\b/.test(t));

  const prazos =
    /\bagenda de prazos?\b/.test(t) ||
    /\bprazos?\s+processua(?:l|is)\b/.test(t) ||
    (/\bpdf\b/.test(t) && /\bprazos?\b/.test(t) && !/\bjudiciais?\b/.test(t));

  if (atendimento && prazos) return null;
  if (atendimento) return "atendimento";
  if (prazos) return "prazos";
  return null;
}

/** Frase estável para o Facejus escolher a natureza, sem perder filial, OAB ou período. */
export function facejusAgendaQuestion(text: string, kind: FacejusAgendaKind): string {
  const raw = String(text || "").trim().replace(/\s+/g, " ");
  if (kind === "atendimento") {
    if (/\bagenda de atendimentos?\b/i.test(raw)) return raw;
    if (/\bagenda de consultas?\b/i.test(raw)) {
      return raw.replace(/\bagenda de consultas?\b/i, "agenda de atendimento");
    }
    if (/\b(meus|minhas)\s+atendimentos?\b/i.test(raw)) {
      return raw.replace(/\b(meus|minhas)\s+atendimentos?\b/i, "agenda de atendimento");
    }
    return raw.replace(/\batendimentos?\b/i, "agenda de atendimento");
  }
  if (/\bagenda de prazos?\b/i.test(raw)) return raw;
  return raw.replace(/\bprazos?\s+processua(?:l|is)\b/i, "agenda de prazos processuais");
}
