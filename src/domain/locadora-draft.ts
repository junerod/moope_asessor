/**
 * Pergunta da locadora termina com “Isto é da locadora.”
 * A resposta seguinte volta ao Finance. Agenda, gasto, nota pessoal
 * e uma consulta nova não entram nesse rascunho.
 */
import { isPersonalLifeCommand } from "@/domain/command-world";
import { facejusAgendaKind } from "@/domain/facejus-commands";
import { detectLocadoraIntent } from "@/domain/locadora-intent";
import {
  isLocadoraAcaoPhrase,
  isLocadoraInclusaoPhrase,
} from "@/domain/locadora-phrases";

const PENDING = /isto é da locadora\.|para marcar a vistoria/i;

function fold(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function isLocadoraQuestionPending(lastAssistant: string): boolean {
  return PENDING.test(String(lastAssistant || ""));
}

function isIotAside(text: string): boolean {
  const q = fold(text);
  return /\b(carrinho|carrinhos|iot|tagbrgps|findtag|brgps|geocerca|supermercado)\b/.test(
    q
  );
}

/**
 * A frase responde o rascunho aberto (sim, não, 1, 2, 3, valor, nome, CPF).
 * Sem a pergunta anterior, sim e não seguem no fluxo pessoal.
 */
export function isLocadoraDraftConfirm(
  userText: string,
  lastAssistant: string
): boolean {
  if (!isLocadoraQuestionPending(lastAssistant)) return false;
  const said = String(userText || "").trim();
  if (!said) return false;
  if (/\bnota pessoal\b/.test(fold(said))) return false;
  if (isPersonalLifeCommand(said)) return false;
  if (facejusAgendaKind(said)) return false;
  if (isIotAside(said)) return false;
  if (isLocadoraAcaoPhrase(said) || isLocadoraInclusaoPhrase(said)) return true;
  if (detectLocadoraIntent(said)) return false;
  return true;
}
