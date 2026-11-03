/**
 * Uma porta só: o ato da frase, antes de qualquer atalho.
 * Palavra no assunto (livre, rota, locadora, carrinho) não troca o módulo.
 */
import { looksLikeAppointmentCreate } from "@/domain/appointment-intent";
import { facejusAgendaKind } from "@/domain/facejus-commands";
import { isLocadoraAcaoPhrase } from "@/domain/locadora-phrases";
import { looksLikeReminderCreate } from "@/domain/reminder-intent";

export type TurnAct =
  | "registrar_pessoal"
  | "listar_dia"
  | "consultar_livre"
  | "rota"
  | "consultar_empresa"
  | "residual";

function fold(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function classifyTurnAct(text: string): TurnAct {
  const raw = String(text || "").trim();
  const t = fold(raw);
  if (!t) return "residual";

  if (typeof isLocadoraAcaoPhrase === "function" && isLocadoraAcaoPhrase(raw)) {
    return "consultar_empresa";
  }
  if (facejusAgendaKind(raw)) return "consultar_empresa";
  if (looksLikeAppointmentCreate(raw) || looksLikeReminderCreate(raw)) {
    return "registrar_pessoal";
  }
  if (
    /\b(agendar|marcar|marque|marca|anotar|anota|anote|compromisso|reuniao)\b/.test(
      t
    ) &&
    /\b(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|\d{1,2}h|\d{1,2}:\d{2})\b/.test(
      t
    )
  ) {
    return "registrar_pessoal";
  }

  if (
    /\b(baix(?:a|ar)|conclu[ií]|dei baixa|dar baixa)\b/.test(t) ||
    (/\b(remover|cancelar|desmarcar)\b/.test(t) &&
      /\b(compromisso|lembrete|reuniao)\b/.test(t))
  ) {
    return "residual";
  }

  if (
    /o que (eu )?tenho|o q (eu )?tenho|oq (eu )?tenho|quais\s+compromissos|meus?\s+compromissos|compromissos?\s+(de|hoje|amanha)|lembretes?( de)? (hoje|amanha)|minha agenda|meu dia|agenda de (hoje|amanha)/.test(
      t
    )
  ) {
    return "listar_dia";
  }

  if (
    /\b(horario|horarios|manha|tarde|noite)\b/.test(t) &&
    /\blivres?\b/.test(t) &&
    !/\b(marcar|agendar|anotar|compromisso|falar com|ligar)\b/.test(t)
  ) {
    return "consultar_livre";
  }

  if (
    /locatarios da locadora|investidores da locadora|veiculos da locadora|resumo da locadora|alertas da locadora|agenda juridica|prazos judiciais/.test(
      t
    )
  ) {
    return "consultar_empresa";
  }

  return "residual";
}
