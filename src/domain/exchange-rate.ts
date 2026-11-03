/**
 * Cotação de moedas → BRL (AwesomeAPI + fallback Frankfurter).
 */

export type FxQuote = {
  base: string;
  quote: string;
  name: string;
  bid: number;
  ask: number;
  pctChange: number | null;
  at: string | null;
  source: string;
};

const ALIASES: Array<{ re: RegExp; code: string; label: string }> = [
  { re: /\b(dolares?|d[oó]lares?|usd|dolar americano|greenback)\b/i, code: "USD", label: "Dólar americano" },
  { re: /\b(euros?|eur)\b/i, code: "EUR", label: "Euro" },
  { re: /\b(libras?|gbp|libra esterlina)\b/i, code: "GBP", label: "Libra esterlina" },
  { re: /\b(iene|yen|jpy)\b/i, code: "JPY", label: "Iene japonês" },
  { re: /\b(franco su[ií][cç]o|chf)\b/i, code: "CHF", label: "Franco suíço" },
  { re: /\b(d[oó]lar canadense|cad)\b/i, code: "CAD", label: "Dólar canadense" },
  { re: /\b(d[oó]lar australiano|aud)\b/i, code: "AUD", label: "Dólar australiano" },
  { re: /\b(peso argentino|ars)\b/i, code: "ARS", label: "Peso argentino" },
  { re: /\b(peso uruguaio|uyu)\b/i, code: "UYU", label: "Peso uruguaio" },
  { re: /\b(peso chileno|clp)\b/i, code: "CLP", label: "Peso chileno" },
  { re: /\b(yuan|cny|renminbi)\b/i, code: "CNY", label: "Yuan chinês" },
  { re: /\b(bitcoin|btc)\b/i, code: "BTC", label: "Bitcoin" },
  { re: /\b(ethereum|eth)\b/i, code: "ETH", label: "Ethereum" },
];

const DEFAULT_PAIR = { code: "USD", label: "Dólar americano" };

export function looksLikeFxIntent(text: string): boolean {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!t || t.length > 160) return false;
  // Evita confundir com cotação de voo/hotel
  if (/(passagem|voo|aereo|hotel|diaria|carro|aluguel)/.test(t)) return false;
  if (
    /(cotacao|cambio|taxa de cambio|quanto (esta|ta|vale)|valor (do|da)|preco (do|da))/.test(
      t
    ) &&
    ALIASES.some((a) => a.re.test(t))
  ) {
    return true;
  }
  if (
    /^(dolar|euro|libra|bitcoin|btc|usd|eur)(\s+hoje)?\??$/.test(t) ||
    /^(cotacao|cambio)\b/.test(t)
  ) {
    return true;
  }
  if (
    /(converter|converte|transforma).{0,20}(dolar|euro|libra|usd|eur|real)/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(r\$\s*)?\d+([.,]\d+)?\s*(dolares?|euros?|libras?|usd|eur|gbp)\b/.test(t) ||
    /\b\d+([.,]\d+)?\s*(dolares?|euros?)\s+(em\s+)?(reais?|brl)\b/.test(t)
  ) {
    return true;
  }
  return false;
}

export function detectFxCurrency(text: string): {
  code: string;
  label: string;
} {
  for (const a of ALIASES) {
    if (a.re.test(text)) return { code: a.code, label: a.label };
  }
  return DEFAULT_PAIR;
}

/** Extrai valor a converter, se houver (“100 dólares”, “quanto é 50 euros”). */
export function detectFxAmount(text: string): number | null {
  const t = String(text || "");
  const m =
    t.match(
      /(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:d[oó]lares?|euros?|libras?|usd|eur|gbp|bitcoin|btc)/i
    ) ||
    t.match(
      /(?:usd|eur|gbp|btc|eth)\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i
    );
  if (!m) return null;
  const raw = (m[1] || m[2] || "").replace(/\./g, "").replace(",", ".");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function moneyBr(n: number): string {
  return n.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function fmtForeign(n: number, code: string): string {
  if (code === "BTC" || code === "ETH") {
    return `${n.toLocaleString("pt-BR", { maximumFractionDigits: 8 })} ${code}`;
  }
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
}

async function fetchAwesome(code: string): Promise<FxQuote | null> {
  const pair = `${code}-BRL`;
  const url = `https://economia.awesomeapi.com.br/json/last/${pair}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = (await res.json()) as Record<
    string,
    {
      code?: string;
      codein?: string;
      name?: string;
      bid?: string;
      ask?: string;
      pctChange?: string;
      create_date?: string;
    }
  >;
  const key = Object.keys(data)[0];
  const row = key ? data[key] : null;
  if (!row?.bid) return null;
  return {
    base: String(row.code || code).toUpperCase(),
    quote: String(row.codein || "BRL").toUpperCase(),
    name: String(row.name || `${code}/BRL`),
    bid: Number(row.bid),
    ask: Number(row.ask || row.bid),
    pctChange:
      row.pctChange !== undefined && row.pctChange !== ""
        ? Number(row.pctChange)
        : null,
    at: row.create_date || null,
    source: "AwesomeAPI",
  };
}

async function fetchFrankfurter(code: string): Promise<FxQuote | null> {
  if (code === "BTC" || code === "ETH") return null;
  const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(code)}&to=BRL`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    rates?: Record<string, number>;
    date?: string;
  };
  const rate = data.rates?.BRL;
  if (!rate || !Number.isFinite(rate)) return null;
  return {
    base: code,
    quote: "BRL",
    name: `${code}/BRL`,
    bid: rate,
    ask: rate,
    pctChange: null,
    at: data.date || null,
    source: "Frankfurter/ECB",
  };
}

export async function fetchFxToBrl(code: string): Promise<FxQuote | null> {
  const c = code.toUpperCase();
  try {
    const a = await fetchAwesome(c);
    if (a) return a;
  } catch {
    /* fallback */
  }
  try {
    return await fetchFrankfurter(c);
  } catch {
    return null;
  }
}

export function formatFxCard(
  quote: FxQuote,
  opts?: { amount?: number | null; label?: string }
): string {
  const label = opts?.label || quote.name;
  const change =
    quote.pctChange !== null && Number.isFinite(quote.pctChange)
      ? quote.pctChange >= 0
        ? `📈 +${quote.pctChange.toFixed(2).replace(".", ",")}%`
        : `📉 ${quote.pctChange.toFixed(2).replace(".", ",")}%`
      : null;

  const lines = [
    `💱 *Câmbio · ${quote.base} → R$*`,
    "────────────",
    `*${label}*`,
    `💵 Compra (bid): *${moneyBr(quote.bid)}*`,
    quote.ask !== quote.bid
      ? `💳 Venda (ask): *${moneyBr(quote.ask)}*`
      : null,
    change,
    quote.at ? `🕒 ${quote.at}` : null,
  ].filter(Boolean) as string[];

  const amount = opts?.amount;
  if (amount && amount > 0) {
    const inBrl = amount * quote.bid;
    lines.push(
      "",
      `*Conversão*`,
      `${fmtForeign(amount, quote.base)} ≈ *${moneyBr(inBrl)}*`
    );
  }

  lines.push(
    "────────────",
    "_Valor de referência do dia (Brasil). Confirme no banco/corretora pra operar._"
  );
  return lines.join("\n");
}

export async function handleFxTurn(text: string): Promise<string> {
  const { code, label } = detectFxCurrency(text);
  const amount = detectFxAmount(text);
  const quote = await fetchFxToBrl(code);
  if (!quote) {
    return [
      `Não consegui a cotação de *${label}* agora 💱`,
      "Tenta de novo em instantes, ou diga *dólar*, *euro*, *libra*…",
    ].join("\n");
  }
  return formatFxCard(quote, { amount, label });
}
