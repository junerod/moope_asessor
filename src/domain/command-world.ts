/**
 * Pessoal, locadora, Facejus e CRM não se misturam.
 * Compromisso, lembrete e gasto são sempre da vida da pessoa —
 * mesmo se o assunto citar contrato, investidor, locatário, rota ou carrinho.
 */
import { looksLikeAppointmentCreate } from "@/domain/appointment-intent";
import { facejusAgendaKind } from "@/domain/facejus-commands";
import { isLocadoraAcaoPhrase } from "@/domain/locadora-phrases";

function fold(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Pedido de agenda/lembrete/gasto da pessoa — nunca pede empresa. */
export function isPersonalLifeCommand(text: string): boolean {
  const q = fold(text).trim();
  if (!q) return false;
  if (typeof isLocadoraAcaoPhrase === "function" && isLocadoraAcaoPhrase(text)) {
    return false;
  }
  if (looksLikeAppointmentCreate(text)) return true;
  if (facejusAgendaKind(text)) return false;
  if (
    /agenda juridica|prazos do (dia|escritorio)|processos? do\b|facejus/.test(q)
  ) {
    return false;
  }
  if (
    /resumo da locadora|frota da locadora|locatarios da locadora|investidores da locadora|veiculos da locadora/.test(
      q
    )
  ) {
    return false;
  }
  if (/^(agendar|agenda|marcar|marque|marca|compromisso|reuniao)\b/.test(q)) {
    return true;
  }
  if (
    /\b(agendar|marcar|marque|marca)\b/.test(q) &&
    /\b(para|pra|as|hoje|amanha|\d{1,2}h)/.test(q)
  ) {
    return true;
  }
  if (/\breuniao\b/.test(q) && /\b(as|hoje|amanha|\d{1,2}h|com)\b/.test(q)) {
    return true;
  }
  if (/\b(me lembra|me lembre|lembrete|me avisa)\b/.test(q)) return true;
  if (/^(gastei|paguei|recebi)\b/.test(q)) return true;
  if (/o que (eu )?tenho|o q (eu )?tenho|oq (eu )?tenho/.test(q)) return true;
  if (/meus?\s+compromissos|minha agenda|meu dia|agenda de (hoje|amanha)/.test(q)) {
    return true;
  }
  if (/\b(baix(?:a|ar)|conclu[ií]|dei baixa|dar baixa)\b/.test(q)) return true;
  if (
    /\b(remover|cancelar|desmarcar)\b/.test(q) &&
    /\b(compromisso|lembrete|reuniao)\b/.test(q)
  ) {
    return true;
  }
  if (/^desfaz/.test(q)) return true;
  if (/lista de (mercado|compras)/.test(q)) return true;
  if (/^pessoal[.!?]?$/.test(q)) return true;
  return false;
}

/** Só operação de locadora / Facejus / troca de empresa. */
export function isBusinessWorldCommand(text: string): boolean {
  if (isPersonalLifeCommand(text)) return false;
  if (facejusAgendaKind(text)) return true;
  const q = fold(text);
  if (!q.trim()) return false;
  if (
    /\bonde estou\b|\btrocar( de)? (empresa|contexto)\b|\bmudar( de)? (empresa|contexto)\b|\bagora (a |o )?(locadora|escritorio|facejus)\b/.test(
      q
    )
  ) {
    return true;
  }
  if (
    /\b(locadora|frota|placa|vistoria|inadimpl|facejus|escritorio|oab|prazos? judiciais?)\b/.test(
      q
    )
  ) {
    return true;
  }
  if (/\bprocessos?\b/.test(q) && !/\bcompromisso|agendar|marcar\b/.test(q)) {
    return true;
  }
  return false;
}
