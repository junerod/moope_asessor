/**
 * O painel não tem endereço fixo. “painel” lista o que pedir.
 * A frase seguinte consulta os dados e devolve o link.
 */

export const PAINEL_ASKS: { title: string; phrases: string[] }[] = [
  {
    title: "Pessoal",
    phrases: [
      "balanço do mês",
      "como estou de gastos",
      "me manda o relatório de gastos",
      "sexta de manhã livre?",
      "tem choque na agenda?",
      "quem me deve?",
      "como está o teto",
      "gastos do mês",
      "horários da semana",
      "relatório de tarefas",
      "isso saiu do padrão hoje?",
      "tarefas atrasadas",
      "documentos da pasta contratos",
      "tem convite no email?",
    ],
  },
  {
    title: "Locadora",
    phrases: [
      "balanço da locadora",
      "resumo da locadora",
      "alertas da locadora",
    ],
  },
  {
    title: "Facejus",
    phrases: [
      "resumo do escritório",
      "meus processos",
      "agenda de atendimento",
      "agenda de prazos processuais",
      "agenda jurídica de hoje",
    ],
  },
];

const MENU_ONLY =
  /^(painel|ver (no |o )?painel|abrir (o )?painel|painel (celular|no celular)|ver no celular|como (abro|acesso|vejo) o painel|onde (est[aá]|fica) o painel)\s*[?.!]*$/i;

export function looksLikePainelMenu(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  if (
    /locadora|frota|escrit[oó]rio|facejus|pessoal|gasto|balan|receita|processo|alerta|agenda/i.test(
      t
    )
  ) {
    return false;
  }
  return MENU_ONLY.test(t);
}

export function formatPainelMenu(): string {
  return [
    "📊 *Painel no celular*",
    "",
    "O pedido sai daqui do celular. Eu crio um link único, com token, só com a resposta desta frase. Não mistura cliente com cliente. Vale 24 horas.",
    "",
    ...PAINEL_ASKS.flatMap((group) => [
      `*${group.title}*`,
      ...group.phrases.map((phrase) => `• ${phrase}`),
      "",
    ]),
    "",
    "Manda uma dessas frases. Eu respondo e coloco o link *Ver no celular* no fim.",
    "",
    "https://assessor.moope.com.br/painel só explica o que pedir. Não mostra número de ninguém.",
  ].join("\n");
}
