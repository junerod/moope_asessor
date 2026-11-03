import { getEnv } from "@/config/env";
import { logger } from "@/lib/logger";

function onlyDigits(s: string) {
  return String(s || "").replace(/\D/g, "");
}

export function normalizePhoneE164Br(phone: string): string | null {
  let d = onlyDigits(phone);
  if (!d) return null;
  if (d.startsWith("55")) d = d.slice(2);
  if (d.length === 10 || d.length === 11) {
    const ddd = d.slice(0, 2);
    let rest = d.slice(2);
    // Celular BR: se veio sem o 9 (8 dígitos começando 6–9), completa
    if (rest.length === 8 && /^[6-9]/.test(rest)) {
      rest = `9${rest}`;
    }
    return `+55${ddd}${rest}`;
  }
  if (d.length >= 12) return `+${onlyDigits(phone)}`;
  return null;
}

export type LocadoraLink = {
  userid: number;
  empresa_nome: string;
  papel: string;
  scopes: string[];
  phone_e164: string;
  nome?: string | null;
  modulo?: string | null;
};

export type LocadoraResolveResult = {
  ok: boolean;
  integrated: boolean;
  links?: LocadoraLink[];
  how_to_ask?: string;
  message?: string;
  text?: string;
  error?: string;
  send_xlsx?: boolean;
  xlsx_name?: string;
  xlsx_base64?: string;
  xlsx_bytes?: number;
  snapshot?: unknown;
  rendimentos?: import("@/domain/locadora-board").RendimentosPack;
  investidores?: import("@/domain/locadora-board").InvestidoresPack;
  locatarios?: import("@/domain/locadora-board").LocatariosPack;
  veiculos?: import("@/domain/locadora-board").VeiculosPack;
};

function financeBaseUrl() {
  const env = getEnv();
  return (
    env.MOOPE_FINANCE_API_URL ||
    process.env.MOOPE_FINANCE_API_URL ||
    "https://frotas.moope.com.br"
  ).replace(/\/$/, "");
}

function foldCompany(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(ltda|ltd|me|epp|eireli|s a|sa|ss|cia|companhia)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameLocadoraCompany(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 6 && long.includes(short);
}

function papelRank(papel: string): number {
  const p = foldCompany(papel);
  if (p === "gerente" || p === "socio") return 50;
  if (p === "financeiro") return 40;
  if (p === "operacao") return 20;
  if (p === "atendimento" || p === "advogado") return 10;
  if (p === "dev" || p === "usuario" || p === "user" || p === "custom") return 1;
  return 15;
}

function preferLocadoraLink(a: LocadoraLink, b: LocadoraLink): LocadoraLink {
  const ra = papelRank(a.papel);
  const rb = papelRank(b.papel);
  if (rb !== ra) return rb > ra ? b : a;
  const na = String(a.empresa_nome || "").length;
  const nb = String(b.empresa_nome || "").length;
  if (nb !== na) return nb > na ? b : a;
  return Number(a.userid) <= Number(b.userid) ? a : b;
}

/**
 * Dev + usuário no Finance (ou 9 do celular em duas linhas) vira um vínculo.
 * Mantém o userid da conta “real” (gerente / nome mais completo / id menor).
 */
export function collapseLocadoraLinks(links: LocadoraLink[] | undefined | null): LocadoraLink[] {
  const rows = (links || []).filter((row) => Number(row?.userid) > 0);
  const groups: LocadoraLink[][] = [];
  for (const row of rows) {
    const id = Number(row.userid);
    const fp = foldCompany(row.empresa_nome);
    const idx = groups.findIndex((group) =>
      group.some((other) => {
        if (Number(other.userid) === id) return true;
        return sameLocadoraCompany(fp, foldCompany(other.empresa_nome));
      })
    );
    if (idx < 0) groups.push([row]);
    else groups[idx].push(row);
  }
  return groups.map((group) => group.reduce(preferLocadoraLink));
}

function financeSecret() {
  const env = getEnv();
  return (
    env.MOOPE_FINANCE_ASSESSOR_SECRET ||
    process.env.MOOPE_FINANCE_ASSESSOR_SECRET ||
    ""
  );
}

async function financeGet(
  path: string,
  query: Record<string, string>
): Promise<LocadoraResolveResult> {
  const secret = financeSecret();
  if (!secret) {
    return {
      ok: false,
      integrated: false,
      error: "not_configured",
      message:
        "Integração com o MOOPE Gestão ainda não configurada no Assessor (faltam MOOPE_FINANCE_API_URL / SECRET).",
    };
  }
  const qs = new URLSearchParams(query).toString();
  const url = `${financeBaseUrl()}${path}?${qs}`;
  const attempt = async () => {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Assessor-Moope-Secret": secret,
      },
      signal: AbortSignal.timeout(25000),
    });
    const data = (await res.json().catch(() => ({}))) as LocadoraResolveResult & {
      error?: string;
    };
    return { res, data };
  };
  try {
    let { res, data } = await attempt();
    // Retry único em 401/403/5xx (deploy/restart do Finance)
    if (!res.ok && (res.status === 401 || res.status === 403 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 800));
      ({ res, data } = await attempt());
    }
    if (!res.ok) {
      logger.warn("finance_assessor_http_error", {
        path,
        status: res.status,
        error: data.error,
      });
      return {
        ok: false,
        integrated: false,
        error: data.error || `http_${res.status}`,
        message: "Não consegui consultar o MOOPE Gestão de Frotas e Locação agora. Tente de novo em instantes.",
      };
    }
    return {
      ...data,
      ok: true,
      links: data.links ? collapseLocadoraLinks(data.links) : data.links,
    };
  } catch (err) {
    logger.warn("finance_assessor_call_failed", {
      error: err instanceof Error ? err.message : String(err),
      path,
    });
    return {
      ok: false,
      integrated: false,
      error: "network",
      message: "MOOPE Gestão de Frotas e Locação indisponível no momento. Tente de novo em instantes.",
    };
  }
}

export async function resolveLocadoraIntegration(phone: string) {
  const e164 = normalizePhoneE164Br(phone);
  if (!e164) {
    return {
      ok: false,
      integrated: false,
      message: "Telefone inválido para checar integração.",
    } as LocadoraResolveResult;
  }
  return financeGet("/api/assessor-moope/resolve", { phone: e164 });
}

export async function postLocadoraAcao(
  phone: string,
  question: string,
  extracted?: {
    amount?: number | null;
    date?: string | null;
    merchant?: string | null;
    summary?: string | null;
    rawText?: string | null;
  } | null,
  imagem?: { base64: string; mime?: string; nome?: string } | null
) {
  const e164 = normalizePhoneE164Br(phone);
  if (!e164) {
    return {
      ok: false,
      integrated: false,
      message: "Telefone inválido.",
    } as LocadoraResolveResult;
  }
  const secret = financeSecret();
  if (!secret) {
    return {
      ok: false,
      integrated: false,
      error: "not_configured",
      message: "Integração com o MOOPE Gestão ainda não configurada no Assessor.",
    } as LocadoraResolveResult;
  }
  try {
    const res = await fetch(`${financeBaseUrl()}/api/assessor-moope/acao`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Assessor-Moope-Secret": secret,
      },
      body: JSON.stringify({
        phone: e164,
        q: question,
        extracted: extracted || undefined,
        imagem: imagem?.base64
          ? { base64: imagem.base64, mime: imagem.mime, nome: imagem.nome }
          : undefined,
      }),
      signal: AbortSignal.timeout(25000),
    });
    const data = (await res.json().catch(() => ({}))) as LocadoraResolveResult;
    if (!res.ok) {
      return {
        ok: false,
        integrated: false,
        error: data.error || `http_${res.status}`,
        message: "Não consegui gravar na locadora agora. Tente de novo em instantes.",
      };
    }
    return { ...data, ok: true };
  } catch (err) {
    logger.warn("finance_assessor_acao_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      integrated: false,
      error: "network",
      message: "MOOPE Gestão de Frotas e Locação indisponível no momento.",
    } as LocadoraResolveResult;
  }
}

export async function askLocadora(
  phone: string,
  question: string,
  opts?: { tenantId?: number | null }
) {
  const e164 = normalizePhoneE164Br(phone);
  if (!e164) {
    return {
      ok: false,
      integrated: false,
      message: "Telefone inválido.",
    } as LocadoraResolveResult;
  }
  const q: Record<string, string> = {
    phone: e164,
    q: question || "resumo",
  };
  if (opts?.tenantId) q.tenant_id = String(opts.tenantId);
  return financeGet("/api/assessor-moope/ask", q);
}

export async function snapshotLocadora(
  phone: string,
  opts?: { tenantId?: number | null }
) {
  const e164 = normalizePhoneE164Br(phone);
  if (!e164) {
    return {
      ok: false,
      integrated: false,
      message: "Telefone inválido.",
    } as LocadoraResolveResult;
  }
  const q: Record<string, string> = { phone: e164 };
  if (opts?.tenantId) q.tenant_id = String(opts.tenantId);
  return financeGet("/api/assessor-moope/snapshot", q);
}

export async function fetchRendimentosFile(input: {
  userid: number;
  start: string;
  end: string;
  kind: string;
}): Promise<
  | { ok: true; bytes: Uint8Array; contentType: string; filename: string }
  | { ok: false }
> {
  const secret = financeSecret();
  if (!secret) return { ok: false };
  const qs = new URLSearchParams({
    userid: String(input.userid),
    start: input.start,
    end: input.end,
    kind: input.kind,
  });
  try {
    const res = await fetch(
      `${financeBaseUrl()}/api/assessor-moope/rendimentos/arquivo?${qs}`,
      {
        headers: { "X-Assessor-Moope-Secret": secret },
        signal: AbortSignal.timeout(60000),
      }
    );
    if (!res.ok) return { ok: false };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const cd = res.headers.get("content-disposition") || "";
    const name = cd.match(/filename="([^"]+)"/)?.[1] || `rendimentos.${input.kind === "xlsx" ? "xlsx" : "pdf"}`;
    return {
      ok: true,
      bytes,
      contentType: res.headers.get("content-type") || "application/octet-stream",
      filename: name,
    };
  } catch {
    return { ok: false };
  }
}
