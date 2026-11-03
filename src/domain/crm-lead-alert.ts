import { getEnv } from "@/config/env";

export type LadoDoAlerta = "on" | "off";
export type KindDoAlerta = "lead" | "resposta";

function normalizar(text: string): string {
  return String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function fraseAlertaLead(text: string): { kind: KindDoAlerta; lado: LadoDoAlerta } | null {
  const t = normalizar(text);
  if (!t || t.length > 48) return null;
  if (/^(ligar|liga|ativar|ativa)\s+alerta\s+respostas?$/.test(t)) return { kind: "resposta", lado: "on" };
  if (/^(desligar|desliga|desativar|desativa)\s+alerta\s+respostas?$/.test(t)) {
    return { kind: "resposta", lado: "off" };
  }
  if (/^(ligar|liga|ativar|ativa)\s+alerta\s+leads?$/.test(t)) return { kind: "lead", lado: "on" };
  if (/^(desligar|desliga|desativar|desativa)\s+alerta\s+leads?$/.test(t)) return { kind: "lead", lado: "off" };
  return null;
}

export function fraseAjudaCrm(text: string): boolean {
  const t = normalizar(text);
  return /^(ajuda crm|comandos do crm|manual do crm|manual crm)$/.test(t);
}

export type ConsultaCrm = "dia" | "semana" | "abertos" | "respostas";

export function fraseConsultaCrm(text: string): ConsultaCrm | null {
  const t = normalizar(text);
  if (!t || t.length > 48) return null;
  if (/^(leads?|clientes?) (do dia|de hoje)$/.test(t)) return "dia";
  if (/^(leads?|clientes?) da semana$/.test(t)) return "semana";
  if (/^(leads?|funil) abertos?$/.test(t)) return "abertos";
  if (/^(quem respondeu hoje|respostas de hoje|leads? que responderam)$/.test(t)) return "respostas";
  return null;
}

/**
 * A pessoa fala no Zap do Assessor. O CRM é quem guarda se o aviso está ligado.
 * Desligar não tira o número da whitelist.
 */
export async function responderAlertaLead(
  phone: string,
  lado: LadoDoAlerta,
  kind: KindDoAlerta = "lead",
): Promise<string> {
  const env = getEnv();
  const secret = env.MOOPE_FINANCE_ASSESSOR_SECRET || process.env.MOOPE_FINANCE_ASSESSOR_SECRET || "";
  const base = (process.env.MOOPE_CRM_API_URL || "https://crm.facejus.com.br").replace(/\/$/, "");
  if (!secret) {
    return "Ainda não consigo mudar o aviso de lead daqui. Peça na tela Meu Assessor do CRM.";
  }
  try {
    const res = await fetch(`${base}/api/v1/integrations/assessor/comando`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-assessor-moope-secret": secret,
      },
      body: JSON.stringify({ phone, enabled: lado === "on", kind }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) {
      return "Esse WhatsApp ainda não está no CRM. O dono da conta cadastra o número em Meu Assessor, e aí você manda de novo: ligar alerta lead.";
    }
    if (!res.ok) {
      return "Não consegui mudar o aviso de lead agora. Tente de novo em instantes, ou use a tela Meu Assessor no CRM.";
    }
  } catch {
    return "Não consegui falar com o CRM agora. O aviso continua como estava.";
  }
  if (kind === "resposta") {
    return lado === "on"
      ? "💬 *Alerta de resposta ligado.*\nQuando o lead responder no CRM, aviso neste WhatsApp.\nPara parar: desligar alerta resposta"
      : "🔕 *Alerta de resposta desligado.*\nO alerta de lead novo continua como estava.\nPara voltar: ligar alerta resposta";
  }
  return lado === "on"
    ? "🔔 *Alerta de lead ligado.*\nCliente novo no CRM chega neste WhatsApp.\nPara parar: desligar alerta lead"
    : "🔕 *Alerta de lead desligado.*\nO Assessor continua normal. Para voltar: ligar alerta lead";
}

export async function consultarLeadsCrm(
  phone: string,
  consulta: ConsultaCrm,
): Promise<{ text: string; board: Record<string, unknown> | null } | null> {
  const env = getEnv();
  const secret = env.MOOPE_FINANCE_ASSESSOR_SECRET || process.env.MOOPE_FINANCE_ASSESSOR_SECRET || "";
  const base = (process.env.MOOPE_CRM_API_URL || "https://crm.facejus.com.br").replace(/\/$/, "");
  if (!secret) return { text: "A consulta de leads do CRM ainda não está ligada neste Assessor.", board: null };
  const res = await fetch(`${base}/api/v1/integrations/assessor/consulta`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-assessor-moope-secret": secret,
    },
    body: JSON.stringify({ phone, consulta }),
    signal: AbortSignal.timeout(8000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: { text?: string; board?: Record<string, unknown> };
    error?: { message?: string };
  };
  if (res.status === 404) {
    return {
      text: "Esse WhatsApp ainda não está no CRM. O dono cadastra o número em Meu Assessor.",
      board: null,
    };
  }
  if (!res.ok || !json.data?.text) return null;
  return { text: json.data.text, board: json.data.board ?? null };
}
