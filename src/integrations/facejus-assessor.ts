import { getEnv } from "@/config/env";
import { logger } from "@/lib/logger";
import { normalizePhoneE164Br } from "@/integrations/moope-finance-assessor";

export type EscritorioResult = {
  ok: boolean;
  integrated: boolean;
  text?: string;
  message?: string;
  error?: string;
  links?: Array<{
    tenant_id: number;
    escritorio: string;
    nome?: string | null;
    papel: string;
  }>;
  how_to_ask?: string;
  /** PDF jurídico (agenda/processos) — Assessor envia no WhatsApp */
  send_pdf?: boolean;
  pdf_url?: string | null;
  pdf_name?: string | null;
  pdf_base64?: string | null;
  pdf_bytes?: number | null;
  painel?: import("@/domain/facejus-board").EscritorioPainel;
};

function baseUrl() {
  const env = getEnv();
  return (
    env.FACEJUS_API_URL ||
    process.env.FACEJUS_API_URL ||
    "https://web.facejus.com.br"
  ).replace(/\/$/, "");
}

function secret() {
  const env = getEnv();
  return env.FACEJUS_ASSESSOR_SECRET || process.env.FACEJUS_ASSESSOR_SECRET || "";
}

async function get(path: string, query: Record<string, string>): Promise<EscritorioResult> {
  const key = secret();
  if (!key) {
    return {
      ok: false,
      integrated: false,
      error: "not_configured",
      message: "Integração Facejus ainda não configurada no Assessor.",
    };
  }
  const url = `${baseUrl()}${path}?${new URLSearchParams(query)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-Assessor-Facejus-Secret": key },
      signal: AbortSignal.timeout(60000),
    });
    const data = (await res.json().catch(() => ({}))) as EscritorioResult;
    if (!res.ok) {
      return {
        ok: false,
        integrated: false,
        error: data.error || `http_${res.status}`,
        message: "Não consegui consultar o Facejus agora.",
      };
    }
    return { ...data, ok: data.ok !== false };
  } catch (err) {
    logger.warn("facejus_assessor_call_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      integrated: false,
      error: "network",
      message: "Facejus indisponível no momento.",
    };
  }
}

export async function resolveEscritorio(phone: string) {
  const e164 = normalizePhoneE164Br(phone);
  if (!e164) {
    return { ok: false, integrated: false, message: "Telefone inválido." } as EscritorioResult;
  }
  return get("/api/assessor-escritorio/resolve", { phone: e164 });
}

export async function askEscritorio(
  phone: string,
  question: string,
  opts?: { tenantId?: number | null }
) {
  const e164 = normalizePhoneE164Br(phone);
  if (!e164) {
    return { ok: false, integrated: false, message: "Telefone inválido." } as EscritorioResult;
  }
  const q: Record<string, string> = { phone: e164, q: question };
  if (opts?.tenantId) q.tenant_id = String(opts.tenantId);
  return get("/api/assessor-escritorio/ask", q);
}

export async function buscarProcessosFacejus(phone: string, tenantId: number, q: string) {
  const e164 = normalizePhoneE164Br(phone);
  if (!e164) return { ok: false, integrated: false, itens: [] } as EscritorioResult & { itens?: unknown[]; aviso?: string };
  return get("/api/assessor-escritorio/buscar", {
    phone: e164,
    tenant_id: String(tenantId),
    q,
  }) as Promise<EscritorioResult & { itens?: unknown[]; aviso?: string }>;
}

export async function andamentoFacejus(phone: string, tenantId: number, numero: string) {
  const e164 = normalizePhoneE164Br(phone);
  if (!e164) return { ok: false, integrated: false } as EscritorioResult & {
    encontrado?: boolean;
    novos?: unknown[];
    legado?: { titulo?: string; texto?: string } | null;
  };
  return get("/api/assessor-escritorio/andamento", {
    phone: e164,
    tenant_id: String(tenantId),
    numero,
  }) as Promise<EscritorioResult & {
    encontrado?: boolean;
    novos?: Array<{ data?: string; titulo?: string; texto?: string }>;
    legado?: { titulo?: string; texto?: string } | null;
  }>;
}

export async function agendaFacejus(
  phone: string,
  tenantId: number,
  dia: string,
  opts?: { natureza?: string | null; escritorioId?: number | null }
) {
  const e164 = normalizePhoneE164Br(phone);
  if (!e164) return { ok: false, integrated: false, itens: [] } as EscritorioResult & { itens?: unknown[]; dia?: string };
  const q: Record<string, string> = { phone: e164, tenant_id: String(tenantId), dia };
  if (opts?.natureza) q.natureza = opts.natureza;
  if (opts?.escritorioId) q.escritorio_id = String(opts.escritorioId);
  return get("/api/assessor-escritorio/agenda", q) as Promise<EscritorioResult & { itens?: unknown[]; dia?: string }>;
}

export async function agendaPdfFacejus(
  phone: string,
  tenantId: number,
  dia: string,
  opts?: { natureza?: string | null; escritorioId?: number | null }
): Promise<Uint8Array | null> {
  const e164 = normalizePhoneE164Br(phone);
  const key = secret();
  if (!e164 || !key) return null;
  const q: Record<string, string> = { phone: e164, tenant_id: String(tenantId), dia };
  if (opts?.natureza) q.natureza = opts.natureza;
  if (opts?.escritorioId) q.escritorio_id = String(opts.escritorioId);
  try {
    const res = await fetch(`${baseUrl()}/api/assessor-escritorio/agenda-pdf?${new URLSearchParams(q)}`, {
      headers: { Accept: "application/pdf", "X-Assessor-Facejus-Secret": key },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    logger.warn("facejus_agenda_pdf_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
