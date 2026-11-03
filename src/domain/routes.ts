/**
 * Rotas / tempo de deslocamento (Nominatim + OSRM — sem API key).
 *
 * Origem (melhor → pior):
 * 1) pin WhatsApp recente
 * 2) “base” salva
 * 3) cidade do tempo / capital do DDD (aproximado)
 *
 * Sem trânsito ao vivo — tempo de rota no mapa aberto + link Maps.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users } from "@/db/schema";
import {
  geocodeCityUf,
  ufFromPhoneE164,
} from "@/domain/weather";
import { getWeatherPrefs } from "@/domain/weather-prefs";

export type GeoPoint = {
  lat: number;
  lon: number;
  label: string;
};

export type RouteResult = {
  origin: GeoPoint;
  dest: GeoPoint;
  durationSec: number;
  distanceM: number;
  mapsUrl: string;
  originSource: "pin" | "base" | "cidade";
};

export type InboundLocation = {
  lat: number;
  lon: number;
  name?: string | null;
  address?: string | null;
};

export type RoutePrefs = {
  last: (GeoPoint & { at: string }) | null;
  base: GeoPoint | null;
  pending_dest: string | null;
};

/** Pin válido como “estou aqui agora” por 45 min. */
export const LAST_PIN_TTL_MS = 45 * 60 * 1000;

const UF_CAPITAL: Record<string, { city: string; uf: string }> = {
  AC: { city: "Rio Branco", uf: "AC" },
  AL: { city: "Maceió", uf: "AL" },
  AP: { city: "Macapá", uf: "AP" },
  AM: { city: "Manaus", uf: "AM" },
  BA: { city: "Salvador", uf: "BA" },
  CE: { city: "Fortaleza", uf: "CE" },
  DF: { city: "Brasília", uf: "DF" },
  ES: { city: "Vitória", uf: "ES" },
  GO: { city: "Goiânia", uf: "GO" },
  MA: { city: "São Luís", uf: "MA" },
  MT: { city: "Cuiabá", uf: "MT" },
  MS: { city: "Campo Grande", uf: "MS" },
  MG: { city: "Belo Horizonte", uf: "MG" },
  PA: { city: "Belém", uf: "PA" },
  PB: { city: "João Pessoa", uf: "PB" },
  PR: { city: "Curitiba", uf: "PR" },
  PE: { city: "Recife", uf: "PE" },
  PI: { city: "Teresina", uf: "PI" },
  RJ: { city: "Rio de Janeiro", uf: "RJ" },
  RN: { city: "Natal", uf: "RN" },
  RS: { city: "Porto Alegre", uf: "RS" },
  RO: { city: "Porto Velho", uf: "RO" },
  RR: { city: "Boa Vista", uf: "RR" },
  SC: { city: "Florianópolis", uf: "SC" },
  SP: { city: "São Paulo", uf: "SP" },
  SE: { city: "Aracaju", uf: "SE" },
  TO: { city: "Palmas", uf: "TO" },
};

function norm(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function cleanDestLabel(s: string): string {
  return s
    .replace(/^(o|a|os|as|um|uma)\s+/i, "")
    .replace(/\b(agora|hoje|de carro|de uber|de onibus)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extrai lat/lon de payloads Zernio/Meta (vários formatos). */
export function extractInboundLocation(
  raw: unknown
): InboundLocation | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [raw];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    const o = cur as Record<string, unknown>;
    const loc =
      (o.location && typeof o.location === "object"
        ? (o.location as Record<string, unknown>)
        : null) ||
      (o.coordinates && typeof o.coordinates === "object"
        ? (o.coordinates as Record<string, unknown>)
        : null) ||
      o;

    const lat = Number(
      loc.latitude ?? loc.lat ?? loc.Latitude ?? loc.LATITUDE
    );
    const lon = Number(
      loc.longitude ?? loc.lon ?? loc.lng ?? loc.Longitude ?? loc.LONGITUDE
    );
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180 &&
      !(lat === 0 && lon === 0)
    ) {
      return {
        lat,
        lon,
        name:
          typeof loc.name === "string"
            ? loc.name
            : typeof o.name === "string"
              ? o.name
              : null,
        address:
          typeof loc.address === "string"
            ? loc.address
            : typeof o.address === "string"
              ? o.address
              : null,
      };
    }

    for (const v of Object.values(o)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

export function looksLikeRouteIntent(text: string): boolean {
  const t = norm(text);
  if (!t || t.length > 200) return false;
  if (/\b(anotar|anota|agendar|marcar|marque|compromisso|lembrete|ligar)\b/.test(t)) {
    return false;
  }
  if (/^\d{1,2}h\d{0,2}\b/.test(t)) return false;
  if (
    /(recolha|carrinho|tagbrgps|findtag|frota|locadora|placa\s+[a-z]{3}|geocerca)/.test(
      t
    )
  ) {
    return false;
  }
  if (
    /^(minha base|salvar base|usar base|minha localizacao|compartilhar local)/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /(quanto tempo|demora|eta|rota|transito|caminho|chegar|deslocamento|ir de carro)/.test(
      t
    ) &&
    /(ate|pra|para|pro|no|na|em|de\s+.+\s+ate)/.test(t)
  ) {
    return true;
  }
  if (/^(rota|transito|eta)\b/.test(t)) return true;
  if (/^(quanto tempo|demora)\b/.test(t)) return true;
  // Continuação depois do pin: "até o aeroporto"
  if (/^(ate|pra|para|pro)\s+\S+/.test(t)) return true;
  return false;
}

export function parseRouteDestination(text: string): string | null {
  const raw = String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\?+$/, "")
    .trim();
  if (!raw) return null;

  const fromTo = raw.match(/^de\s+(.+?)\s+at[eé]\s+(.+)$/i);
  if (fromTo?.[2]) return cleanDestLabel(fromTo[2]);

  const patterns = [
    /(?:quanto tempo|demora(?: quanto)?|eta|rota|tr[aâ]nsito|caminho|chegar|ir)\s+(?:at[eé]|pra|para|pro|no|na|em)\s+(.+)$/i,
    /^(?:at[eé]|pra|para|pro)\s+(.+)$/i,
    /^(?:rota|tr[aâ]nsito|eta)\s*[:\-–]?\s*(.+)$/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1]?.trim()) {
      const dest = cleanDestLabel(m[1]);
      if (dest.length >= 2 && dest.length <= 120) return dest;
    }
  }
  return null;
}

export function parseRouteOriginOverride(text: string): string | null {
  const m = String(text || "").match(/^de\s+(.+?)\s+at[eé]\s+/i);
  return m?.[1] ? cleanDestLabel(m[1]) : null;
}

function viewboxAround(lat: number, lon: number, deg = 0.55): string {
  return `${lon - deg},${lat + deg},${lon + deg},${lat - deg}`;
}

function shortLabel(s: string): string {
  const parts = s.split(",").map((p) => p.trim());
  return parts.slice(0, 2).join(", ").slice(0, 80);
}

function looksLikeCoords(label: string): boolean {
  return /pin\s*-?\d|latitude|longitude|-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/i.test(
    label
  );
}

/** Rua e bairro a partir do pin. Coordenada não vai para o usuário. */
async function reversePlaceLabel(lat: number, lon: number): Promise<string | null> {
  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "pt-BR");
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "moope-assessor/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      display_name?: string;
      address?: Record<string, string>;
    };
    const a = data.address || {};
    const road = [a.road, a.house_number].filter(Boolean).join(", ");
    const area =
      a.suburb || a.neighbourhood || a.city_district || a.town || a.city || a.village;
    const line = [road, area].filter(Boolean).join(" · ");
    if (line) return line.slice(0, 90);
    if (data.display_name) return shortLabel(data.display_name);
    return null;
  } catch {
    return null;
  }
}

async function geocodePlace(
  query: string,
  near: GeoPoint
): Promise<GeoPoint | null> {
  const q = cleanDestLabel(query);
  if (!q) return null;

  if (/\baeroporto\b/i.test(q) && near.lat > -16.5 && near.lat < -15.2) {
    return {
      lat: -15.8717,
      lon: -47.9117,
      label: "Aeroporto de Brasília (BSB)",
    };
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", `${q}, Brasil`);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "br");
  url.searchParams.set("viewbox", viewboxAround(near.lat, near.lon));
  url.searchParams.set("bounded", "1");

  const headers = {
    "User-Agent": "moope-assessor/1.0 (whatsapp-assessor; contact@moope.com.br)",
    Accept: "application/json",
  };

  const res = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (res.ok) {
    const data = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name?: string;
      name?: string;
    }>;
    if (data[0]) {
      return {
        lat: Number(data[0].lat),
        lon: Number(data[0].lon),
        label: shortLabel(data[0].display_name || data[0].name || q),
      };
    }
  }

  const url2 = new URL("https://nominatim.openstreetmap.org/search");
  url2.searchParams.set("q", `${q}, ${near.label}, Brasil`);
  url2.searchParams.set("format", "json");
  url2.searchParams.set("limit", "3");
  url2.searchParams.set("countrycodes", "br");
  const res2 = await fetch(url2.toString(), {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!res2.ok) return null;
  const data2 = (await res2.json()) as Array<{
    lat: string;
    lon: string;
    display_name?: string;
    name?: string;
  }>;
  if (!data2[0]) return null;
  return {
    lat: Number(data2[0].lat),
    lon: Number(data2[0].lon),
    label: shortLabel(data2[0].display_name || data2[0].name || q),
  };
}

async function osrmDriving(
  origin: GeoPoint,
  dest: GeoPoint
): Promise<{ durationSec: number; distanceM: number } | null> {
  const path = `${origin.lon},${origin.lat};${dest.lon},${dest.lat}`;
  const url = `https://router.project-osrm.org/route/v1/driving/${path}?overview=false`;
  const res = await fetch(url, {
    headers: { "User-Agent": "moope-assessor/1.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    code?: string;
    routes?: Array<{ duration: number; distance: number }>;
  };
  if (data.code !== "Ok" || !data.routes?.[0]) return null;
  return {
    durationSec: data.routes[0].duration,
    distanceM: data.routes[0].distance,
  };
}

function formatDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;
}

function mapsDirUrl(origin: GeoPoint, dest: GeoPoint): string {
  return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lon}&destination=${dest.lat},${dest.lon}&travelmode=driving`;
}

function vibeLine(durationSec: number): string {
  const m = Math.round(durationSec / 60);
  if (m <= 10) return "🟢 Tranquilo — dá pra ir agora.";
  if (m <= 25) return "🟡 De boa — margem pra um café.";
  if (m <= 45) return "🟠 Vale sair com um tempinho a mais.";
  return "🔴 Melhor sair cedo — caminho longo.";
}

export function formatRouteCard(r: RouteResult): string {
  const src =
    r.originSource === "pin"
      ? "do seu pin"
      : r.originSource === "base"
        ? "da sua base"
        : "da cidade (aprox.)";
  return [
    "🛣️ *Bora!*",
    "────────────",
    `📍 *De* (${src})`,
    looksLikeCoords(r.origin.label) ? "Perto de você" : r.origin.label,
    `🏁 *Até*`,
    r.dest.label,
    "",
    `⏱️ *${formatDuration(r.durationSec)}* · ${formatDistance(r.distanceM)}`,
    vibeLine(r.durationSec),
    "",
    `🗺️ ${r.mapsUrl}`,
    "",
    "_Sem trânsito ao vivo ainda. Pin fresco = mais preciso._",
    "💡 Manda *salvar base* pra fixar este ponto.",
  ].join("\n");
}

function askForPin(destHint?: string | null): string {
  return [
    "📍 *Cadê você?*",
    "",
    destHint
      ? `Quero te levar até *${destHint}* — mas preciso do seu pin.`
      : "Pra calcular certinho, me manda onde você está.",
    "",
    "No Zap:",
    "📎 → *Localização* → *Localização atual*",
    "",
    destHint
      ? "_Assim que o pin chegar, eu calculo na hora._"
      : "Depois diga: *até o aeroporto* · *rota até Taguatinga*",
  ].join("\n");
}

function parseRoutePrefs(
  profileJson: Record<string, unknown> | null | undefined
): RoutePrefs {
  const r = (profileJson?.route || {}) as Record<string, unknown>;
  const last = r.last as (GeoPoint & { at?: string }) | null | undefined;
  const base = r.base as GeoPoint | null | undefined;
  return {
    last:
      last &&
      Number.isFinite(last.lat) &&
      Number.isFinite(last.lon) &&
      typeof last.at === "string"
        ? {
            lat: last.lat,
            lon: last.lon,
            label: String(last.label || "Você"),
            at: last.at,
          }
        : null,
    base:
      base && Number.isFinite(base.lat) && Number.isFinite(base.lon)
        ? {
            lat: base.lat,
            lon: base.lon,
            label: String(base.label || "Sua base"),
          }
        : null,
    pending_dest:
      typeof r.pending_dest === "string" && r.pending_dest.trim()
        ? r.pending_dest.trim()
        : null,
  };
}

async function getRoutePrefs(db: Db, userId: string): Promise<RoutePrefs> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return parseRoutePrefs(
    (user?.profileJson || {}) as Record<string, unknown>
  );
}

async function saveRoutePrefs(
  db: Db,
  userId: string,
  next: RoutePrefs
): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return;
  const profile = {
    ...((user.profileJson || {}) as Record<string, unknown>),
    route: {
      last: next.last,
      base: next.base,
      pending_dest: next.pending_dest,
    },
  };
  await db
    .update(users)
    .set({ profileJson: profile, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

function pinIsFresh(last: RoutePrefs["last"]): boolean {
  if (!last?.at) return false;
  const age = Date.now() - new Date(last.at).getTime();
  return Number.isFinite(age) && age >= 0 && age <= LAST_PIN_TTL_MS;
}

async function cityFallback(
  db: Db,
  input: { userId: string; phoneE164?: string | null }
): Promise<GeoPoint> {
  const prefs = await getWeatherPrefs(db, input.userId);
  if (prefs.place) {
    return {
      lat: prefs.place.lat,
      lon: prefs.place.lon,
      label: prefs.place.label || `${prefs.place.city}-${prefs.place.uf}`,
    };
  }
  const uf = ufFromPhoneE164(input.phoneE164 || "") || "DF";
  const cap = UF_CAPITAL[uf] || UF_CAPITAL.DF;
  const place = await geocodeCityUf(cap.city, cap.uf);
  if (place) {
    return { lat: place.lat, lon: place.lon, label: place.label };
  }
  return { lat: -15.78, lon: -47.93, label: "Brasília-DF" };
}

async function resolveOrigin(
  db: Db,
  input: {
    userId: string;
    phoneE164?: string | null;
    originOverride?: string | null;
    allowCityFallback?: boolean;
  }
): Promise<{ point: GeoPoint; source: RouteResult["originSource"] } | null> {
  if (input.originOverride) {
    const near = await cityFallback(db, input);
    const g = await geocodePlace(input.originOverride, near);
    if (g) return { point: g, source: "cidade" };
  }

  const rp = await getRoutePrefs(db, input.userId);
  if (rp.last && pinIsFresh(rp.last)) {
    return {
      point: { lat: rp.last.lat, lon: rp.last.lon, label: rp.last.label },
      source: "pin",
    };
  }
  if (rp.base) {
    return { point: rp.base, source: "base" };
  }
  if (input.allowCityFallback === false) return null;
  return { point: await cityFallback(db, input), source: "cidade" };
}

async function buildRouteCard(
  origin: GeoPoint,
  dest: GeoPoint,
  originSource: RouteResult["originSource"]
): Promise<string> {
  const route = await osrmDriving(origin, dest);
  if (!route) {
    return "Não consegui calcular a rota agora. Tenta de novo em instantes.";
  }
  return formatRouteCard({
    origin,
    dest,
    durationSec: route.durationSec,
    distanceM: route.distanceM,
    mapsUrl: mapsDirUrl(origin, dest),
    originSource,
  });
}

/** Usuário mandou pin de localização no WhatsApp. */
export async function handleLocationShare(
  db: Db,
  input: {
    userId: string;
    location: InboundLocation;
    phoneE164?: string | null;
  }
): Promise<string> {
  const reversed = await reversePlaceLabel(
    input.location.lat,
    input.location.lon
  );
  const named = input.location.name || input.location.address || "";
  const label =
    (named && !looksLikeCoords(named) ? named : "") ||
    reversed ||
    "Perto de você";
  const point: GeoPoint = {
    lat: input.location.lat,
    lon: input.location.lon,
    label: shortLabel(label),
  };

  const prefs = await getRoutePrefs(db, input.userId);
  const pending = prefs.pending_dest;
  prefs.last = { ...point, at: new Date().toISOString() };
  prefs.pending_dest = null;
  await saveRoutePrefs(db, input.userId, prefs);

  if (pending) {
    const dest = await geocodePlace(pending, point);
    if (!dest) {
      return [
        `📍 Pin anotado!`,
        `Não achei *${pending}* por perto.`,
        "Tenta de novo com outro nome (ex.: *Aeroporto de Brasília*).",
      ].join("\n");
    }
    return [
      "📍 *Pin recebido!* Calculando…",
      "",
      await buildRouteCard(point, dest, "pin"),
    ].join("\n");
  }

  return [
    "📍 *Anotei onde você está!*",
    shortLabel(point.label),
    "",
    "Pra onde vamos?",
    "• *até o aeroporto*",
    "• *rota até Taguatinga*",
    "• *trânsito para o shopping*",
    "",
    "_Ou diga *salvar base* pra eu lembrar este ponto._",
  ].join("\n");
}

export async function handleRouteTurn(
  db: Db,
  input: { userId: string; text: string; phoneE164?: string | null }
): Promise<string> {
  const t = norm(input.text);

  if (/^(minha base|onde estou|minha localizacao)$/.test(t)) {
    const prefs = await getRoutePrefs(db, input.userId);
    const lines = ["🗺️ *Seus pontos*"];
    if (prefs.last && pinIsFresh(prefs.last)) {
      lines.push(`📍 Pin fresco: ${prefs.last.label}`);
    } else if (prefs.last) {
      lines.push(`📍 Último pin (velho): ${prefs.last.label}`);
    } else {
      lines.push("📍 Sem pin ainda");
    }
    lines.push(
      prefs.base ? `🏠 Base: ${prefs.base.label}` : "🏠 Sem base salva"
    );
    lines.push(
      "",
      "Manda o pin (📎 Localização) ou diga *salvar base* depois do pin."
    );
    return lines.join("\n");
  }

  if (/^(salvar base|usar base como origem)$/.test(t)) {
    const prefs = await getRoutePrefs(db, input.userId);
    if (!prefs.last) {
      return askForPin(null) + "\n\n_Depois diga *salvar base*_.";
    }
    prefs.base = {
      lat: prefs.last.lat,
      lon: prefs.last.lon,
      label: prefs.last.label,
    };
    await saveRoutePrefs(db, input.userId, prefs);
    return [
      "🏠 *Base salva!*",
      prefs.base.label,
      "",
      "Próximas rotas começam daqui (ou do pin se você mandar de novo).",
    ].join("\n");
  }

  const destRaw = parseRouteDestination(input.text);
  const originOverride = parseRouteOriginOverride(input.text);

  if (!destRaw) {
    return [
      "🛣️ *Rotas*",
      "",
      "Exemplos:",
      "• *quanto tempo até o aeroporto*",
      "• *até Taguatinga*",
      "• *de Asa Norte até o aeroporto*",
      "",
      "Melhor precisão: manda o 📍 pin antes (📎 → Localização).",
    ].join("\n");
  }

  // Sem pin fresco e sem base → pede pin (mais preciso e divertido)
  const prefs = await getRoutePrefs(db, input.userId);
  const hasFresh = Boolean(prefs.last && pinIsFresh(prefs.last));
  const hasBase = Boolean(prefs.base);
  if (!originOverride && !hasFresh && !hasBase) {
    prefs.pending_dest = destRaw;
    await saveRoutePrefs(db, input.userId, prefs);
    return askForPin(destRaw);
  }

  const origin = await resolveOrigin(db, {
    userId: input.userId,
    phoneE164: input.phoneE164,
    originOverride,
    allowCityFallback: true,
  });
  if (!origin) {
    prefs.pending_dest = destRaw;
    await saveRoutePrefs(db, input.userId, prefs);
    return askForPin(destRaw);
  }

  const dest = await geocodePlace(destRaw, origin.point);
  if (!dest) {
    return [
      `Não achei *${destRaw}* perto de ${origin.point.label}.`,
      "",
      "Tente um nome mais específico (ex.: *Aeroporto de Brasília*).",
    ].join("\n");
  }

  prefs.pending_dest = null;
  await saveRoutePrefs(db, input.userId, prefs);

  return buildRouteCard(origin.point, dest, origin.source);
}
