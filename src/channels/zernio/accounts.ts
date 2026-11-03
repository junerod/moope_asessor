/**
 * Listagem de contas WhatsApp Zernio — mesmo contrato do moope-finance.
 */

export type ZernioWhatsappNumber = {
  account_id: string;
  profile_id: string;
  phone: string;
  name: string;
  label: string;
};

function looksLikeZernioAccountId(raw: string) {
  return /^[a-f0-9]{24}$/i.test(String(raw || "").trim());
}

function extractProfileId(acc: Record<string, unknown>) {
  const p = acc?.profileId;
  if (typeof p === "string" && p.trim()) return p.trim();
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    return String(o._id || o.id || "").trim();
  }
  const profile = acc?.profile as Record<string, unknown> | undefined;
  return String(acc?.profile_id || profile?._id || "").trim();
}

function unwrapAccounts(data: unknown): Record<string, unknown>[] {
  const d = data as Record<string, unknown> | null;
  if (Array.isArray(d?.accounts)) return d.accounts as Record<string, unknown>[];
  const nested = d?.data as Record<string, unknown> | unknown[] | undefined;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    if (Array.isArray((nested as Record<string, unknown>).accounts)) {
      return (nested as Record<string, unknown>).accounts as Record<
        string,
        unknown
      >[];
    }
  }
  if (Array.isArray(nested)) return nested as Record<string, unknown>[];
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return [];
}

function accountPhone(acc: Record<string, unknown>) {
  const md =
    acc?.metadata && typeof acc.metadata === "object"
      ? (acc.metadata as Record<string, unknown>)
      : {};
  const whatsapp = acc?.whatsapp as Record<string, unknown> | undefined;
  const profile = acc?.profile as Record<string, unknown> | undefined;
  const waba = acc?.waba as Record<string, unknown> | undefined;
  const raw =
    acc?.phoneNumber ||
    acc?.phone_number ||
    acc?.displayPhoneNumber ||
    acc?.display_phone_number ||
    acc?.phone ||
    acc?.number ||
    whatsapp?.phone ||
    profile?.phone ||
    waba?.phone ||
    md.displayPhoneNumber ||
    md.phoneNumber ||
    md.phone ||
    acc?.username ||
    "";
  return String(raw || "").trim();
}

function summarizeWhatsappAccount(
  acc: Record<string, unknown>
): ZernioWhatsappNumber {
  const account_id = String(acc?._id || acc?.id || "").trim();
  const phone = accountPhone(acc);
  const name = String(
    acc?.name || acc?.displayName || acc?.display_name || acc?.label || ""
  ).trim();
  return {
    account_id,
    profile_id: extractProfileId(acc),
    phone,
    name,
    label:
      phone ||
      name ||
      (account_id ? `WhatsApp …${account_id.slice(-6)}` : "WhatsApp"),
  };
}

export function listWhatsappAccountsFromPayload(
  data: unknown
): ZernioWhatsappNumber[] {
  const list = unwrapAccounts(data);
  const waOnly = list.filter(
    (a) => String(a?.platform || a?.type || "").toLowerCase() === "whatsapp"
  );
  const source = waOnly.length ? waOnly : list;
  return source
    .map(summarizeWhatsappAccount)
    .filter((a) => looksLikeZernioAccountId(a.account_id));
}

export function normalizeZernioApiUrl(raw?: string) {
  let s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) s = "https://zernio.com/api/v1";
  if (/\/api$/i.test(s)) return `${s}/v1`;
  if (/zernio\.com$/i.test(s)) return `${s}/api/v1`;
  return s;
}

/**
 * Lista números WhatsApp disponíveis com a API Key.
 * Não envia mensagem — só GET /accounts.
 */
export async function fetchZernioWhatsappNumbers(input: {
  apiKey: string;
  apiUrl?: string;
  timeoutMs?: number;
}): Promise<
  | { ok: true; numbers: ZernioWhatsappNumber[] }
  | { ok: false; status: number; error: string; errorCode: string }
> {
  const apiKey = String(input.apiKey || "").trim();
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      error: "Informe a API Key da Zernio.",
      errorCode: "missing_key",
    };
  }
  const base = normalizeZernioApiUrl(input.apiUrl);
  const timeoutMs = input.timeoutMs ?? 20000;
  try {
    const res = await fetch(`${base}/accounts`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        error: "Chave inválida. Cole de novo a API Key (sk_…).",
        errorCode: "invalid_credentials",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: "Zernio não aceitou o pedido.",
        errorCode: "provider_error",
      };
    }
    const numbers = listWhatsappAccountsFromPayload(data);
    return { ok: true, numbers };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    const timeout = /abort|timeout/i.test(msg);
    return {
      ok: false,
      status: 0,
      error: timeout
        ? "Zernio não respondeu a tempo."
        : "Zernio inacessível.",
      errorCode: timeout ? "timeout" : "provider_error",
    };
  }
}
