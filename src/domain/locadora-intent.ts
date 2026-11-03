import {
  isLocadoraAcaoPhrase,
  isLocadoraInclusaoPhrase,
} from "@/domain/locadora-phrases";

export { isLocadoraAcaoPhrase, isLocadoraInclusaoPhrase };

/**
 * Normaliza a pergunta da locadora antes de chamar o Finance.
 * O LLM às vezes reescreve errado (ex.: manda "manutenções" quando o usuário
 * pediu aluguéis atrasados, por causa do histórico da conversa).
 * Preferimos o texto original do usuário quando o intent fica claro.
 */

export type LocadoraCanonical =
  | "capacidades"
  | "resumo"
  | "inadimplencia"
  | "receita"
  | "recebimentos"
  | "frota"
  | "alertas"
  | "vistorias"
  | "manutencoes"
  | "preventivas"
  | "investidores"
  | "locatarios"
  | "veiculos"
  | null;

function fold(s: string) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Detecta intent a partir de texto livre (usuário ou question da tool). */
export function detectLocadoraIntent(text: string): LocadoraCanonical {
  const q = fold(text);
  if (!q.trim()) return null;

  if (/investidor/.test(q) && !/rendiment|lucro da locadora|faturamento/.test(q)) {
    return "investidores";
  }

  if (
    /como (esta|anda|ta|vai) (a |minha )?(locadora|frota)\b/.test(q) ||
    /como (a |minha )?(locadora|frota) (esta|anda|ta|vai)\b/.test(q) ||
    /\bstatus (da |de )?(minha )?(locadora|frota)\b/.test(q)
  ) {
    return "resumo";
  }

  if (
    /capacidades|o que (voce|o assessor|vc|tu).{0,80}(pode|faz|dar|oferece|informa)|menu locadora|funcoes.*(locadora|frota)|ajuda (com |da |na )?(locadora|frota)/.test(
      q
    )
  ) {
    return "capacidades";
  }

  // Inadimplência / aluguéis — ANTES de manutenção (atrasado ≠ OS atrasada)
  if (
    /inadimpl|quem deve|devedor|inadimplente/.test(q) ||
    /(falta|faltam|nao).{0,20}pag(ar|ou|aram)/.test(q) ||
    /(quem|quais).{0,30}(atrasad|em atraso|devendo|deve)/.test(q) ||
    /(aluguel|alugueis|mensalidade|parcela).{0,40}(atrasad|em atraso|vencid|pendente|falta)/.test(
      q
    ) ||
    /(atrasad|em atraso|vencid).{0,40}(aluguel|alugueis|mensalidade|parcela|locatario|cliente)/.test(
      q
    ) ||
    /quem falta pagar/.test(q)
  ) {
    return "inadimplencia";
  }

  if (/rendiment|lucro da locadora|faturamento da locadora/.test(q)) {
    return "receita";
  }

  if (
    /recebiment|a receber|quanto.{0,30}receber|receber.{0,30}(hoje|amanha|semana|periodo|mes)|recebido.{0,20}(hoje|semana|periodo)/.test(q)
  ) {
    return "recebimentos";
  }

  if (/preventiv/.test(q)) return "preventivas";
  if (/vistoria|checklist/.test(q)) return "vistorias";
  if (
    /manuten|\bos\b|ordem de servico/.test(q) &&
    !/aluguel|inadimpl|pagar|parcela/.test(q)
  ) {
    return "manutencoes";
  }
  // IoT / carrinhos / supermercado — NÃO virar "carros disponíveis" da locadora
  if (
    /carrinho|tags?\b|tagbrgps|findtag|brgps|brtag|airtag|geocerca|supermercado|por unidade|por loja|rota de recolha|rorta|rotaia|\biot\b/.test(
      q
    )
  ) {
    return null;
  }
  if (/alerta|rastre|offline|24h|48h|72h/.test(q)) return "alertas";
  if (
    (/\bveiculos?\b/.test(q) &&
      !/investidor|opera|filial|rendiment|dispon|manuten|onde|localiza|alerta/.test(q)) ||
    (/painel d[ae] frota|minha frota|frota da locadora|carros da locadora/.test(q) &&
      !/dispon|opera|filial/.test(q))
  ) {
    return "veiculos";
  }
  if (/receita|faturamento|rendimento/.test(q)) return "receita";
  if (/dispon|frota|carros? (livre|alugad)/.test(q) && !/carrinho/.test(q)) {
    return "frota";
  }
  if (/\blocatari/.test(q) && !/investidor|cnh|atras|inadimpl|deve|vistoria|manuten/.test(q)) {
    return "locatarios";
  }
  if (/^resumo\b|resumo (da |da minha )?locadora/.test(q)) return "resumo";
  return null;
}

const PESSOA_STOP = new Set([
  "investidor",
  "investidores",
  "locatario",
  "locatarios",
  "locadora",
  "locacao",
  "locacoes",
  "aluguel",
  "alugueis",
  "frota",
  "frotas",
  "da",
  "de",
  "do",
  "dos",
  "das",
  "meu",
  "meus",
  "minha",
  "minhas",
  "mostrar",
  "mostra",
  "liste",
  "lista",
  "listar",
  "painel",
  "buscar",
  "busca",
  "topo",
  "todos",
  "todas",
  "completo",
  "completa",
  "geral",
  "ativo",
  "ativos",
  "ativa",
  "ativas",
  "quero",
  "ver",
  "saber",
  "por",
  "favor",
  "com",
  "veiculo",
  "veiculos",
  "carro",
  "carros",
  "nome",
  "documento",
  "cpf",
  "cnpj",
  "email",
  "placa",
  "placas",
  "os",
  "as",
  "um",
  "uma",
  "no",
  "na",
  "que",
  "tem",
  "para",
  "pra",
  "me",
  "qual",
  "quais",
  "quem",
]);

function personSearchLeft(text: string): string {
  const raw = fold(text);
  const email = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  if (email) return email[0];
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 6) return digits;
  return raw
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !PESSOA_STOP.has(t))
    .join(" ");
}

const CANONICAL_Q: Record<Exclude<LocadoraCanonical, null>, string> = {
  capacidades: "capacidades",
  resumo: "resumo",
  inadimplencia: "inadimplência",
  receita: "receita deste mês",
  recebimentos: "recebimentos",
  frota: "carros disponíveis",
  alertas: "alertas da locadora",
  vistorias: "vistorias abertas",
  manutencoes: "manutenções do mês",
  preventivas: "preventivas da semana",
  investidores: "investidores da locadora",
  locatarios: "locatários da locadora",
  veiculos: "veículos da locadora",
};

function preservePersonQuestion(
  text: string,
  intent: "investidores" | "locatarios" | "veiculos"
): string {
  const extra = personSearchLeft(text);
  if (extra.length >= 2) return text.trim();
  return CANONICAL_Q[intent];
}

/**
 * Escolhe a pergunta canônica.
 * Se o texto do usuário tem intent claro e a question do LLM diverge, ganha o usuário.
 */
export function resolveLocadoraQuestion(input: {
  toolQuestion?: string | null;
  userText?: string | null;
}): string {
  const toolQ = String(input.toolQuestion || "").trim();
  const userQ = String(input.userText || "").trim();

  if (isLocadoraAcaoPhrase(userQ) || isLocadoraInclusaoPhrase(userQ)) return userQ;
  if (isLocadoraAcaoPhrase(toolQ) || isLocadoraInclusaoPhrase(toolQ)) return toolQ;

  const userIntent = detectLocadoraIntent(userQ);
  const toolIntent = detectLocadoraIntent(toolQ);

  const personIntent =
    userIntent === "investidores" || userIntent === "locatarios" || userIntent === "veiculos"
      ? userIntent
      : toolIntent === "investidores" || toolIntent === "locatarios" || toolIntent === "veiculos"
        ? toolIntent
        : null;
  if (personIntent) {
    const source = userIntent === personIntent ? userQ : toolQ || userQ;
    return preservePersonQuestion(source, personIntent);
  }

  if (userIntent === "recebimentos") {
    const q = fold(userQ);
    if (/\bhoje\b/.test(q)) return "recebimentos hoje";
    if (/\bamanha\b/.test(q)) return "recebimentos amanhã";
    if (/\bsemana\b/.test(q)) return "recebimentos nesta semana";
    if (/\bmes\b/.test(q)) return "recebimentos neste mês";
    return userQ || toolQ || "recebimentos";
  }

  if (userIntent && toolIntent && userIntent !== toolIntent) {
    // LLM drift (ex.: histórico de vistoria → manutenções)
    return CANONICAL_Q[userIntent];
  }
  if (userIntent) return CANONICAL_Q[userIntent];
  if (toolIntent) return CANONICAL_Q[toolIntent];

  // Capacidades legado
  if (
    /capacidades|o que (voc[eê]|o assessor|vc|tu).{0,80}(pode|faz)/i.test(toolQ || userQ)
  ) {
    return "capacidades";
  }
  return toolQ || userQ || "resumo";
}
