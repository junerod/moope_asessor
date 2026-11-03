/**
 * Previsão do tempo (Open-Meteo — sem API key).
 * País BR (+55); UF pela cidade ou DDD do WhatsApp.
 */

export type WeatherPlace = {
  city: string;
  uf: string;
  country: string;
  lat: number;
  lon: number;
  label: string;
};

export type DayForecast = {
  date: string; // yyyy-MM-dd
  tMax: number;
  tMin: number;
  precipProb: number;
  weatherCode: number;
};

export type WeatherBundle = {
  place: WeatherPlace;
  today: DayForecast;
  week: DayForecast[];
  fetchedAt: string;
};

/** DDD (2 dígitos) → UF — Brasil. */
export const DDD_TO_UF: Record<string, string> = {
  "11": "SP",
  "12": "SP",
  "13": "SP",
  "14": "SP",
  "15": "SP",
  "16": "SP",
  "17": "SP",
  "18": "SP",
  "19": "SP",
  "21": "RJ",
  "22": "RJ",
  "24": "RJ",
  "27": "ES",
  "28": "ES",
  "31": "MG",
  "32": "MG",
  "33": "MG",
  "34": "MG",
  "35": "MG",
  "37": "MG",
  "38": "MG",
  "41": "PR",
  "42": "PR",
  "43": "PR",
  "44": "PR",
  "45": "PR",
  "46": "PR",
  "47": "SC",
  "48": "SC",
  "49": "SC",
  "51": "RS",
  "53": "RS",
  "54": "RS",
  "55": "RS",
  "61": "DF",
  "62": "GO",
  "64": "GO",
  "63": "TO",
  "65": "MT",
  "66": "MT",
  "67": "MS",
  "68": "AC",
  "69": "RO",
  "71": "BA",
  "73": "BA",
  "74": "BA",
  "75": "BA",
  "77": "BA",
  "79": "SE",
  "81": "PE",
  "87": "PE",
  "82": "AL",
  "83": "PB",
  "84": "RN",
  "85": "CE",
  "88": "CE",
  "86": "PI",
  "89": "PI",
  "91": "PA",
  "93": "PA",
  "94": "PA",
  "92": "AM",
  "97": "AM",
  "95": "RR",
  "96": "AP",
  "98": "MA",
  "99": "MA",
};

export function ufFromPhoneE164(phone: string | null | undefined): string | null {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d.startsWith("55") || d.length < 12) return null;
  const ddd = d.slice(2, 4);
  return DDD_TO_UF[ddd] || null;
}

export function weatherEmoji(code: number): string {
  if (code === 0) return "☀️";
  if (code <= 3) return "⛅";
  if (code <= 48) return "🌫️";
  if (code <= 57) return "🌦️";
  if (code <= 67) return "🌧️";
  if (code <= 77) return "🌨️";
  if (code <= 82) return "🌧️";
  if (code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌤️";
}

export function weatherLabel(code: number): string {
  if (code === 0) return "céu limpo";
  if (code === 1) return "quase limpo";
  if (code === 2) return "parcialmente nublado";
  if (code === 3) return "nublado";
  if (code <= 48) return "neblina";
  if (code <= 57) return "garoa";
  if (code <= 67) return "chuva";
  if (code <= 77) return "neve";
  if (code <= 82) return "pancadas";
  if (code <= 86) return "neve forte";
  if (code >= 95) return "tempestade";
  return "variável";
}

/** Parseia “Brasília DF”, “brasilia, df”, “São Paulo - SP”. */
export function parseCityUf(
  text: string,
  hintUf?: string | null
): { city: string; uf: string } | null {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 80) return null;
  const t = raw
    .replace(/^(cidade|eu moro em|moro em|sou de|em)\s+/i, "")
    .trim();

  const m = t.match(
    /^(.+?)[\s,.\-/]+([A-Za-zÁÂÃÀÉÊÍÓÔÕÚÜÇáâãàéêíóôõúüç]{2})$/
  );
  if (m) {
    const city = m[1].trim().replace(/\s+/g, " ");
    const uf = m[2].trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (city.length >= 2 && uf.length === 2) return { city, uf };
  }

  // Só cidade + UF sugerido pelo DDD
  if (hintUf && /^[\p{L}\s'.-]{2,60}$/u.test(t) && !/\d/.test(t)) {
    return { city: t.replace(/\s+/g, " "), uf: hintUf.toUpperCase() };
  }
  return null;
}

export async function geocodeCityUf(
  city: string,
  uf: string
): Promise<WeatherPlace | null> {
  const q = `${city}, ${uf}, Brasil`;
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", city);
  url.searchParams.set("count", "8");
  url.searchParams.set("language", "pt");
  url.searchParams.set("countryCode", "BR");

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results?: Array<{
      name: string;
      latitude: number;
      longitude: number;
      admin1?: string;
      country_code?: string;
    }>;
  };
  const results = data.results || [];
  if (!results.length) return null;

  const ufUp = uf.toUpperCase();
  const ufNames: Record<string, string> = {
    AC: "Acre",
    AL: "Alagoas",
    AP: "Amapá",
    AM: "Amazonas",
    BA: "Bahia",
    CE: "Ceará",
    DF: "Distrito Federal",
    ES: "Espírito Santo",
    GO: "Goiás",
    MA: "Maranhão",
    MT: "Mato Grosso",
    MS: "Mato Grosso do Sul",
    MG: "Minas Gerais",
    PA: "Pará",
    PB: "Paraíba",
    PR: "Paraná",
    PE: "Pernambuco",
    PI: "Piauí",
    RJ: "Rio de Janeiro",
    RN: "Rio Grande do Norte",
    RS: "Rio Grande do Sul",
    RO: "Rondônia",
    RR: "Roraima",
    SC: "Santa Catarina",
    SP: "São Paulo",
    SE: "Sergipe",
    TO: "Tocantins",
  };
  const adminWant = ufNames[ufUp] || ufUp;

  const scored = results.map((r) => {
    const admin = String(r.admin1 || "");
    let score = 0;
    if (admin.toLowerCase().includes(adminWant.toLowerCase())) score += 5;
    if (admin.toUpperCase().includes(ufUp)) score += 3;
    if (r.name.toLowerCase() === city.toLowerCase()) score += 2;
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.r;
  if (!best) return null;

  return {
    city: best.name,
    uf: ufUp,
    country: "BR",
    lat: best.latitude,
    lon: best.longitude,
    label: `${best.name}-${ufUp}`,
  };
}

export async function fetchForecast(
  place: WeatherPlace
): Promise<WeatherBundle | null> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(place.lat));
  url.searchParams.set("longitude", String(place.lon));
  url.searchParams.set(
    "daily",
    "weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
  );
  url.searchParams.set("timezone", "America/Sao_Paulo");
  url.searchParams.set("forecast_days", "7");

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    daily?: {
      time: string[];
      weathercode: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_probability_max: number[];
    };
  };
  const d = data.daily;
  if (!d?.time?.length) return null;

  const week: DayForecast[] = d.time.map((date, i) => ({
    date,
    tMax: Math.round(d.temperature_2m_max[i]),
    tMin: Math.round(d.temperature_2m_min[i]),
    precipProb: Math.round(d.precipitation_probability_max?.[i] ?? 0),
    weatherCode: d.weathercode[i],
  }));

  return {
    place,
    today: week[0],
    week,
    fetchedAt: new Date().toISOString(),
  };
}

function formatDayLine(day: DayForecast, locale = "pt-BR"): string {
  const dt = new Date(day.date + "T12:00:00");
  const wd = dt.toLocaleDateString(locale, { weekday: "short" });
  const dm = dt.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
  });
  const emoji = weatherEmoji(day.weatherCode);
  const rain = day.precipProb >= 40 ? ` · 💧${day.precipProb}%` : "";
  return `• ${wd} ${dm}  ${emoji}  ${day.tMin}°–${day.tMax}°${rain}`;
}

export type WeatherFocus = "today" | "tomorrow" | "week";

function dayHeadline(day: DayForecast, title: string): string[] {
  const emoji = weatherEmoji(day.weatherCode);
  const label = weatherLabel(day.weatherCode);
  const dt = new Date(day.date + "T12:00:00");
  const when = dt.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "short",
  });
  return [
    `*${title}* · ${when}`,
    `${emoji} *${label}*`,
    `🌡️ ${day.tMin}° — *${day.tMax}°*`,
    day.precipProb >= 30
      ? `💧 Chance de chuva: *${day.precipProb}%*`
      : null,
  ].filter(Boolean) as string[];
}

/** Card WhatsApp — hoje / amanhã / semana. */
export function formatWeatherCard(
  bundle: WeatherBundle,
  opts?: {
    week?: boolean;
    focus?: WeatherFocus;
    footer?: string | null;
  }
): string {
  const focus: WeatherFocus =
    opts?.focus || (opts?.week ? "week" : "today");

  const lines = [`🌤️ *Tempo · ${bundle.place.label}*`, "────────────"];

  if (focus === "tomorrow" && bundle.week[1]) {
    lines.push(...dayHeadline(bundle.week[1], "Amanhã"));
    lines.push("", "*Depois*");
    for (const day of bundle.week.slice(2, 5)) {
      lines.push(formatDayLine(day));
    }
  } else if (focus === "week") {
    lines.push("*Semana*");
    for (const day of bundle.week.slice(0, 7)) {
      lines.push(formatDayLine(day));
    }
  } else {
    lines.push(...dayHeadline(bundle.today, "Hoje"));
    if (bundle.week.length > 1) {
      lines.push("", "*Próximos dias*");
      const until = focus === "today" ? 4 : 7;
      for (const day of bundle.week.slice(1, until)) {
        lines.push(formatDayLine(day));
      }
    }
  }

  lines.push("────────────");
  if (opts?.footer !== undefined && opts.footer !== null) {
    if (opts.footer) lines.push(opts.footer);
  } else {
    lines.push(
      "_Peça “tempo amanhã”, “tempo da semana” ou “tempo em Curitiba PR”_"
    );
  }
  return lines.join("\n");
}

/** Bloco curto pro resumo matinal. */
export function formatWeatherBriefLine(bundle: WeatherBundle): string {
  const t = bundle.today;
  const emoji = weatherEmoji(t.weatherCode);
  const tip =
    t.precipProb >= 50
      ? " · leva guarda-chuva ☂️"
      : t.tMax >= 32
        ? " · hidrate-se 💧"
        : t.tMin <= 14
          ? " · leve um casaco 🧥"
          : "";
  return `*Tempo em ${bundle.place.label}:* ${emoji} ${weatherLabel(t.weatherCode)} · ${t.tMin}°–${t.tMax}°${
    t.precipProb >= 40 ? ` · chuva ${t.precipProb}%` : ""
  }${tip}`;
}

/** Extrai foco temporal da frase. */
export function parseWeatherFocus(text: string): WeatherFocus {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/(amanha|amanhã)/.test(t)) return "tomorrow";
  if (/(semana|7 dias|proximos dias|próximos dias)/.test(t)) return "week";
  return "today";
}

/** “às 7h”, “7:30”, “07h”, “6 da manha”. */
export function parseClockHourMinute(
  text: string
): { hour: number; minute: number } | null {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const hm = t.match(/\b(\d{1,2})[:h](\d{2})\b/);
  if (hm) {
    const hour = Number(hm[1]);
    const minute = Number(hm[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }
  const h = t.match(/\b(?:as|às)?\s*(\d{1,2})\s*h?\b/);
  if (h) {
    let hour = Number(h[1]);
    if (/da tarde|da noite/.test(t) && hour < 12) hour += 12;
    if (/da manha/.test(t) && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23) return { hour, minute: 0 };
  }
  return null;
}

/** Extrai “em Cidade UF” da frase de tempo. */
export function extractPlaceFromWeatherText(
  text: string,
  hintUf?: string | null
): { city: string; uf: string } | null {
  const raw = String(text || "").trim();
  const m = raw.match(
    /(?:\bem|\bde|\bpra|\bpara|\bno|\bna)\s+(.+?)(?:\s+(hoje|amanha|amanhã|essa semana|esta semana|da semana))?\s*$/i
  );
  const chunk = (m?.[1] || "").trim();
  if (!chunk) return null;
  // Evita “em manhã” / “de hoje”
  if (/^(hoje|amanha|amanhã|manha|tarde|noite)$/i.test(chunk)) return null;
  return parseCityUf(chunk, hintUf);
}
