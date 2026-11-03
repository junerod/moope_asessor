/**
 * Catálogo de templates WhatsApp (Zernio → Meta) — Meu Assessor.
 *
 * Regras:
 * - Não começa nem termina com {{n}}
 * - Quebra no texto fixo = Enter
 * - Quebra dentro de {{n}} = \r (via toTemplateParam)
 */
import { toTemplateParam } from "@/lib/whatsapp-template-params";

export type TemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";

export type TemplateCatalogEntry = {
  /** Nome na Meta/Zernio (a-z, 0-9, _) */
  name: string;
  /** Nome lógico interno (whatsapp_templates.logical_name) */
  logicalName: string;
  category: TemplateCategory;
  language: string;
  phase: "P0" | "P1" | "P2";
  description: string;
  /** Corpo com {{1}}… — texto fixo usa \n */
  body: string;
  /** Exemplos para revisão Meta (um array por variável, na ordem) */
  exampleParams: string[];
  footer?: string;
};

export const ASSESSOR_TEMPLATE_CATALOG: TemplateCatalogEntry[] = [
  // ─── P0 ───────────────────────────────────────────────
  {
    name: "assessor_reminder",
    logicalName: "reminder",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P0",
    description: "Disparo de lembrete fora da janela 24h",
    body: [
      "🔔 Lembrete do Meu Assessor",
      "",
      "{{1}}",
      "",
      "É só responder neste chat se quiser remarcar.",
    ].join("\n"),
    exampleParams: [
      "Pagar condomínio · R$ 450,00\r🗓️ 24/09 · 18:00",
    ],
  },
  {
    name: "assessor_daily_brief",
    logicalName: "daily_brief",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P0",
    description: "Brief matinal (bom-dia)",
    body: [
      "☀️ Bom dia!",
      "",
      "{{1}}",
      "",
      "Meu Assessor · MOOPE",
    ].join("\n"),
    exampleParams: [
      "Hoje você tem 2 compromissos\r• 10:00 Reunião\r• 15:00 Dentista",
    ],
  },
  {
    name: "assessor_notification",
    logicalName: "notification",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P0",
    description: "Aviso genérico utilitário (fallback)",
    body: [
      "📌 Aviso do Meu Assessor",
      "",
      "{{1}}",
      "",
      "Qualquer dúvida, é só responder aqui.",
    ].join("\n"),
    exampleParams: ["Seu lembrete foi atualizado com sucesso."],
  },

  // ─── P1 ───────────────────────────────────────────────
  {
    name: "assessor_weekly_digest",
    logicalName: "weekly_digest",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P1",
    description: "Resumo semanal (domingo)",
    body: [
      "📊 Seu resumo da semana",
      "",
      "{{1}}",
      "",
      "Meu Assessor · MOOPE",
    ].join("\n"),
    exampleParams: [
      "Gastos: R$ 1.240,00\rLembretes: 5\rCompromissos: 3",
    ],
  },
  {
    name: "assessor_finance_alert",
    logicalName: "finance_alert",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P1",
    description: "Alerta de meta / gastos",
    body: [
      "💸 Alerta financeiro",
      "",
      "{{1}}",
      "",
      "Meu Assessor · MOOPE",
    ].join("\n"),
    exampleParams: [
      "Você já usou 82% da meta do mês\rFaltam R$ 360,00",
    ],
  },
  {
    name: "assessor_bill_due",
    logicalName: "bill_due",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P1",
    description: "Contas a vencer hoje/amanhã",
    body: [
      "📅 Contas a vencer",
      "",
      "{{1}}",
      "",
      "Meu Assessor · MOOPE",
    ].join("\n"),
    exampleParams: [
      "🔴 Vence hoje: Luz · R$ 189,90\r🟡 Vence amanhã: Internet · R$ 99,90",
    ],
  },
  {
    name: "assessor_appointment",
    logicalName: "appointment",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P1",
    description: "Aviso de compromisso",
    body: [
      "📅 Compromisso na agenda",
      "",
      "{{1}}",
      "",
      "Meu Assessor · MOOPE",
    ].join("\n"),
    exampleParams: ["Reunião com o contador\r🗓️ 25/09 · 14:00"],
  },
  {
    name: "assessor_conflict",
    logicalName: "conflict",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P1",
    description: "Conflito de horários na agenda",
    body: [
      "⚠️ Conflito de agenda",
      "",
      "{{1}}",
      "",
      "Meu Assessor · MOOPE",
    ].join("\n"),
    exampleParams: [
      "Dois compromissos no mesmo horário\r• 14:00 Reunião\r• 14:00 Consulta",
    ],
  },

  // ─── P2 ───────────────────────────────────────────────
  {
    name: "assessor_welcome",
    logicalName: "welcome",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P2",
    description: "Boas-vindas pós-onboarding",
    body: [
      "👋 Bem-vindo ao Meu Assessor!",
      "",
      "{{1}}",
      "",
      "É só escrever naturalmente. Estou aqui.",
    ].join("\n"),
    exampleParams: [
      "Posso cuidar de lembretes, gastos e agenda.\rDiga “ajuda” para ver o manual.",
    ],
  },
  {
    name: "assessor_goal_alert",
    logicalName: "goal_alert",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P2",
    description: "Meta de gastos atingida/próxima",
    body: [
      "🎯 Meta de gastos",
      "",
      "{{1}}",
      "",
      "Meu Assessor · MOOPE",
    ].join("\n"),
    exampleParams: ["Meta do mês atingida\rTotal: R$ 3.000,00"],
  },
  {
    name: "assessor_pending_boleto",
    logicalName: "pending_boleto",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P2",
    description: "Pendência de boleto aguardando confirmação",
    body: [
      "🧾 Boleto pendente",
      "",
      "{{1}}",
      "",
      "Confirme com “paguei” ou envie o comprovante.",
    ].join("\n"),
    exampleParams: ["Conta de luz · R$ 189,90\rVence amanhã"],
  },
  {
    name: "assessor_news",
    logicalName: "news",
    category: "MARKETING",
    language: "pt_BR",
    phase: "P2",
    description: "Novidades / broadcast (marketing)",
    body: [
      "✨ Novidades no Meu Assessor",
      "",
      "{{1}}",
      "",
      "Equipe MOOPE",
    ].join("\n"),
    exampleParams: [
      "Agora tem brief matinal e alertas de meta.\rManual: assessor.moope.com.br/ajuda/pessoal",
    ],
  },
  {
    name: "assessor_infra_alert",
    logicalName: "infra_alert",
    category: "UTILITY",
    language: "pt_BR",
    phase: "P2",
    description: "Alerta de infra/ops para DEV",
    body: [
      "🚨 Alerta Assessor (DEV)",
      "",
      "{{1}}",
      "",
      "Verifique /saude no WhatsApp ou /admin/reliability.",
    ].join("\n"),
    exampleParams: ["Fila worker atrasada\rjobs_pending=42"],
  },
];

export function getCatalogByLogical(
  logicalName: string
): TemplateCatalogEntry | undefined {
  return ASSESSOR_TEMPLATE_CATALOG.find((t) => t.logicalName === logicalName);
}

export function getCatalogByProviderName(
  name: string
): TemplateCatalogEntry | undefined {
  return ASSESSOR_TEMPLATE_CATALOG.find((t) => t.name === name);
}

/** Empacota mensagem livre no {{1}} do template (com \r). */
export function packSingleBodyParam(message: string): string[] {
  return [toTemplateParam(message)];
}

export function zernioCreatePayload(
  entry: TemplateCatalogEntry,
  accountId: string
) {
  return {
    accountId,
    name: entry.name,
    category: entry.category,
    language: entry.language,
    components: [
      {
        type: "body",
        text: entry.body,
        example: {
          body_text: [entry.exampleParams.map((p) => toTemplateParam(p))],
        },
      },
      ...(entry.footer
        ? [{ type: "footer" as const, text: entry.footer }]
        : []),
    ],
  };
}
