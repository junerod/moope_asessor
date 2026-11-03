/**
 * Deep links acionáveis (WhatsApp) — pesquisa aberta sem API paga.
 * Sempre úteis mesmo quando o scraper não traz preço fechado.
 */

function enc(s: string) {
  return encodeURIComponent(s.trim());
}

/** Tenta achar dois trechos de cidade em PT (bem tolerante). */
export function guessRouteCities(text: string): { from?: string; to?: string } {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const m = t.match(
    /(?:de|em)\s+([a-z\s]{3,40}?)\s+(?:para|pra|ate|até|x|->)\s+([a-z\s]{3,40}?)(?:\s|$|,|\.|semana|amanha|hoje)/i
  );
  if (m) {
    return {
      from: m[1].replace(/\s+/g, " ").trim(),
      to: m[2].replace(/\s+/g, " ").trim(),
    };
  }
  const m2 = t.match(
    /passagem(?:\s+aerea)?\s+([a-z\s]{3,30}?)\s+(?:para|pra|->)\s+([a-z\s]{3,30}?)(?:\s|$)/i
  );
  if (m2) {
    return {
      from: m2[1].replace(/\s+/g, " ").trim(),
      to: m2[2].replace(/\s+/g, " ").trim(),
    };
  }
  return {};
}

export function buildActionDeepLinks(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const links: string[] = [];
  const route = guessRouteCities(q);
  const isFlight =
    /(passagem|voo|aereo|aérea|a[eé]reo|flights?)/i.test(q) ||
    Boolean(route.from && route.to);
  const isHotel = /(hotel|hospedagem|di[aá]ria)/i.test(q);
  const isCar = /(carro|fipe|tabela fipe|usado)/i.test(q);

  if (isFlight) {
    const flightQ =
      route.from && route.to
        ? `voos de ${route.from} para ${route.to}`
        : q;
    links.push(`https://www.google.com/travel/flights?q=${enc(flightQ)}`);
    links.push(`https://www.google.com/search?q=${enc(flightQ + " preço")}`);
    if (route.from && route.to) {
      links.push(
        `https://www.kayak.com.br/flights/${enc(route.from)}-${enc(route.to)}`
      );
    }
  } else if (isHotel) {
    links.push(`https://www.google.com/travel/hotels?q=${enc(q)}`);
    links.push(`https://www.google.com/search?q=${enc(q)}`);
  } else if (isCar) {
    links.push(`https://www.google.com/search?q=${enc(q + " FIPE")}`);
  } else {
    links.push(`https://www.google.com/search?q=${enc(q)}`);
  }

  return [...new Set(links)].slice(0, 4);
}

export function formatDeepLinksBlock(query: string): string | null {
  const links = buildActionDeepLinks(query);
  if (!links.length) return null;
  return `Atalhos pra você abrir agora:\n${links.map((l) => `• ${l}`).join("\n")}`;
}
