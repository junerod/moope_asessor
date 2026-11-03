import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users } from "@/db/schema";
import {
  extractPlaceFromWeatherText,
  fetchForecast,
  formatWeatherBriefLine,
  formatWeatherCard,
  geocodeCityUf,
  parseCityUf,
  parseClockHourMinute,
  parseWeatherFocus,
  ufFromPhoneE164,
  type WeatherPlace,
} from "@/domain/weather";

export type WeatherPrefs = {
  /** Inclui tempo no bom-dia / resumo da manhã */
  enabled_morning: boolean;
  /** Aviso dedicado todo dia neste horário (America/Sao_Paulo). null = off */
  alert_hour: number | null;
  alert_minute: number;
  place: WeatherPlace | null;
  pending: null | "ask_city" | "confirm" | "ask_mode" | "ask_alert_time";
  pending_place: WeatherPlace | null;
};

function parseWeatherPrefs(
  profileJson: Record<string, unknown> | null | undefined
): WeatherPrefs {
  const w = (profileJson?.weather || {}) as Record<string, unknown>;
  const place = w.place as WeatherPlace | null | undefined;
  const hour =
    typeof w.alert_hour === "number" && w.alert_hour >= 0 && w.alert_hour <= 23
      ? w.alert_hour
      : null;
  const minute =
    typeof w.alert_minute === "number" &&
    w.alert_minute >= 0 &&
    w.alert_minute <= 59
      ? w.alert_minute
      : 0;
  const pendingRaw = w.pending;
  const pending =
    pendingRaw === "ask_city" ||
    pendingRaw === "confirm" ||
    pendingRaw === "ask_mode" ||
    pendingRaw === "ask_alert_time"
      ? pendingRaw
      : null;
  return {
    enabled_morning:
      typeof w.enabled_morning === "boolean" ? w.enabled_morning : false,
    alert_hour: hour,
    alert_minute: minute,
    place:
      place &&
      typeof place.lat === "number" &&
      typeof place.lon === "number" &&
      place.city
        ? place
        : null,
    pending,
    pending_place: (w.pending_place as WeatherPlace | null) || null,
  };
}

export async function getWeatherPrefs(
  db: Db,
  userId: string
): Promise<WeatherPrefs> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return parseWeatherPrefs(
    (user?.profileJson || {}) as Record<string, unknown>
  );
}

export async function saveWeatherPrefs(
  db: Db,
  userId: string,
  next: WeatherPrefs
): Promise<WeatherPrefs> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error("user_not_found");
  const profile = {
    ...((user.profileJson || {}) as Record<string, unknown>),
    weather: {
      enabled_morning: next.enabled_morning,
      alert_hour: next.alert_hour,
      alert_minute: next.alert_minute,
      place: next.place,
      pending: next.pending,
      pending_place: next.pending_place,
    },
  };
  await db
    .update(users)
    .set({ profileJson: profile, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return next;
}

function formatAlertClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function modesMenu(placeLabel: string): string {
  return [
    `✅ *${placeLabel}* salva.`,
    "",
    "Como prefere receber a previsão?",
    "",
    "1️⃣ *Só quando eu pedir* — diga “tempo” a qualquer hora",
    "2️⃣ *No bom-dia* — junto com o resumo da manhã",
    "3️⃣ *Num horário* — aviso só do tempo (ex.: *7h* ou *18:30*)",
    "",
    "Responda *1*, *2* ou *3* (ou o horário direto).",
  ].join("\n");
}

function askCityMessage(hintUf: string | null): string {
  const tip = hintUf
    ? `Pelo seu DDD, sugiro *${hintUf}*. Ex.: *Brasília ${hintUf}*`
    : "Ex.: *São Paulo SP* ou *Curitiba PR*";
  return [
    "🌤️ *Previsão do tempo*",
    "",
    "Me diga sua *cidade e UF* (Brasil).",
    tip,
    "",
    "_Depois você escolhe: sob demanda, no bom-dia, ou num horário._",
  ].join("\n");
}

export function looksLikeWeatherIntent(text: string): boolean {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!t || t.length > 180) return false;
  if (
    /(previsao( do tempo)?|como esta o tempo|como ta o tempo|como vai (estar|o) tempo|tempo (hoje|agora|da semana|amanha|em )|clima (hoje|agora|em )|temperatura|vai chover|chove (hoje|amanha)|meteorolog)/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /^(tempo|clima)\??$/.test(t) ||
    /^(me fala|mostra|qual).{0,24}(tempo|clima|previsao)/.test(t)
  ) {
    return true;
  }
  if (/(liga|desliga|quero|aviso|avisa|manda).{0,40}(previsao|tempo|clima)/.test(t)) {
    return true;
  }
  return false;
}

export async function shouldHandleWeatherTurn(
  db: Db,
  userId: string,
  text: string
): Promise<boolean> {
  if (looksLikeWeatherIntent(text)) return true;
  const prefs = await getWeatherPrefs(db, userId);
  if (!prefs.pending) return false;
  const t = String(text || "").trim();
  if (prefs.pending === "confirm") {
    return (
      /^(sim|isso|confirmo|ok|pode|yes|ss)\b/i.test(t) ||
      /^(nao|não|errou|outra|corrige)\b/i.test(t) ||
      Boolean(parseCityUf(t))
    );
  }
  if (prefs.pending === "ask_city") {
    if (
      /^(oi|ola|olá|bom dia|boa tarde|obrigado|ajuda|preferencias)\b/i.test(t)
    ) {
      return false;
    }
    return Boolean(parseCityUf(t)) || /^[\p{L}\s'.-]{3,60}$/u.test(t);
  }
  if (prefs.pending === "ask_mode") {
    return (
      /^[123]$/.test(t.trim()) ||
      /(sob demanda|quando (eu )?pedir|bom.?dia|resumo|horario|horário|todo dia)/i.test(
        t
      ) ||
      Boolean(parseClockHourMinute(t))
    );
  }
  if (prefs.pending === "ask_alert_time") {
    return Boolean(parseClockHourMinute(t)) || /^(cancelar|deixa)\b/i.test(t);
  }
  return false;
}

async function deliverForecast(
  place: WeatherPlace,
  text: string,
  footer?: string | null
): Promise<string> {
  const bundle = await fetchForecast(place);
  if (!bundle) {
    return "Não consegui buscar o tempo agora. Tenta de novo em instantes 🌤️";
  }
  return formatWeatherCard(bundle, {
    focus: parseWeatherFocus(text),
    footer,
  });
}

export async function handleWeatherTurn(
  db: Db,
  input: {
    userId: string;
    text: string;
    phoneE164?: string | null;
  }
): Promise<string> {
  const prefs = await getWeatherPrefs(db, input.userId);
  const hintUf = ufFromPhoneE164(input.phoneE164);
  const raw = String(input.text || "").trim();
  const norm = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // —— Preferências explícitas ——
  if (
    /(desliga|desativar|nao quero).{0,40}(previsao|tempo|clima)/.test(norm)
  ) {
    await saveWeatherPrefs(db, input.userId, {
      ...prefs,
      enabled_morning: false,
      alert_hour: null,
      pending: null,
      pending_place: null,
    });
    return [
      "⬜ Avisos automáticos de tempo *desligados*.",
      "Continua podendo pedir *como está o tempo?* quando quiser.",
    ].join("\n");
  }

  if (
    /(liga|ativar|quero).{0,40}(previsao|tempo|clima).{0,40}(manha|bom.?dia|resumo)/.test(
      norm
    ) ||
    /(previsao|tempo).{0,30}(no )?bom.?dia/.test(norm)
  ) {
    if (!prefs.place) {
      await saveWeatherPrefs(db, input.userId, {
        ...prefs,
        enabled_morning: true,
        pending: "ask_city",
        pending_place: null,
      });
      return ["Beleza — tempo no *bom-dia*.", "", askCityMessage(hintUf)].join(
        "\n"
      );
    }
    await saveWeatherPrefs(db, input.userId, {
      ...prefs,
      enabled_morning: true,
      pending: null,
      pending_place: null,
    });
    return [
      `✅ Tempo no *bom-dia* · ${prefs.place.label}`,
      "_Desligar:_ *desliga previsão de manhã*",
    ].join("\n");
  }

  // Horário dedicado: “me avisa o tempo todo dia às 7h”
  if (
    /(aviso|avisa|manda|quero).{0,40}(previsao|tempo|clima).{0,40}(\d|hora|as |às )/.test(
      norm
    ) ||
    /(previsao|tempo).{0,40}(todo dia|diariamente).{0,20}(\d|h)/.test(norm) ||
    /(liga|quero).{0,20}(aviso|horario).{0,20}(tempo|previsao|clima)/.test(norm)
  ) {
    const clock = parseClockHourMinute(raw);
    if (!prefs.place) {
      await saveWeatherPrefs(db, input.userId, {
        ...prefs,
        alert_hour: clock?.hour ?? null,
        alert_minute: clock?.minute ?? 0,
        pending: "ask_city",
        pending_place: null,
      });
      return [
        clock
          ? `Perfeito — aviso de tempo às *${formatAlertClock(clock.hour, clock.minute)}*.`
          : "Perfeito — aviso de tempo num horário fixo.",
        "",
        askCityMessage(hintUf),
      ].join("\n");
    }
    if (clock) {
      await saveWeatherPrefs(db, input.userId, {
        ...prefs,
        alert_hour: clock.hour,
        alert_minute: clock.minute,
        pending: null,
        pending_place: null,
      });
      return [
        `✅ Aviso de tempo *todo dia às ${formatAlertClock(clock.hour, clock.minute)}* · ${prefs.place.label}`,
        "",
        "_Além disso, peça “tempo amanhã” ou “tempo em outra cidade” quando quiser._",
        "_Desligar:_ *desliga previsão*",
      ].join("\n");
    }
    await saveWeatherPrefs(db, input.userId, {
      ...prefs,
      pending: "ask_alert_time",
      pending_place: null,
    });
    return "Que horário? Ex.: *7h* ou *18:30*";
  }

  // —— Fluxos pendentes ——
  if (prefs.pending === "ask_alert_time") {
    if (/^(cancelar|deixa|nao)\b/i.test(raw)) {
      await saveWeatherPrefs(db, input.userId, {
        ...prefs,
        pending: prefs.place ? "ask_mode" : null,
        pending_place: null,
      });
      return prefs.place
        ? modesMenu(prefs.place.label)
        : "Ok — sem horário fixo.";
    }
    const clock = parseClockHourMinute(raw);
    if (!clock) {
      return "Não peguei o horário. Ex.: *7h* ou *18:30*";
    }
    if (!prefs.place) {
      await saveWeatherPrefs(db, input.userId, {
        ...prefs,
        alert_hour: clock.hour,
        alert_minute: clock.minute,
        pending: "ask_city",
      });
      return [
        `Horário *${formatAlertClock(clock.hour, clock.minute)}* anotado.`,
        "",
        askCityMessage(hintUf),
      ].join("\n");
    }
    await saveWeatherPrefs(db, input.userId, {
      ...prefs,
      alert_hour: clock.hour,
      alert_minute: clock.minute,
      pending: null,
      pending_place: null,
    });
    const card = await deliverForecast(
      prefs.place,
      "hoje",
      `_Aviso diário às ${formatAlertClock(clock.hour, clock.minute)}_`
    );
    return card;
  }

  if (prefs.pending === "ask_mode" && prefs.place) {
    const clock = parseClockHourMinute(raw);
    if (clock || /^3$/.test(raw.trim()) || /horario|horário|todo dia/.test(norm)) {
      if (clock) {
        await saveWeatherPrefs(db, input.userId, {
          ...prefs,
          enabled_morning: false,
          alert_hour: clock.hour,
          alert_minute: clock.minute,
          pending: null,
          pending_place: null,
        });
        return await deliverForecast(
          prefs.place,
          "hoje",
          `_Aviso diário às ${formatAlertClock(clock.hour, clock.minute)}_`
        );
      }
      await saveWeatherPrefs(db, input.userId, {
        ...prefs,
        pending: "ask_alert_time",
      });
      return "Que horário? Ex.: *7h* ou *18:30*";
    }
    if (
      /^2$/.test(raw.trim()) ||
      /bom.?dia|resumo|manha/.test(norm)
    ) {
      await saveWeatherPrefs(db, input.userId, {
        ...prefs,
        enabled_morning: true,
        alert_hour: null,
        pending: null,
        pending_place: null,
      });
      return await deliverForecast(
        prefs.place,
        "hoje",
        "_Vai no *bom-dia*. Peça “tempo” quando quiser também._"
      );
    }
    if (
      /^1$/.test(raw.trim()) ||
      /sob demanda|quando (eu )?pedir|so quando|só quando/.test(norm)
    ) {
      await saveWeatherPrefs(db, input.userId, {
        ...prefs,
        enabled_morning: false,
        alert_hour: null,
        pending: null,
        pending_place: null,
      });
      return await deliverForecast(
        prefs.place,
        "hoje",
        "_Só quando pedir. Diga “liga previsão de manhã” ou “me avisa o tempo às 7h” se mudar de ideia._"
      );
    }
    return modesMenu(prefs.place.label);
  }

  if (prefs.pending === "confirm" && prefs.pending_place) {
    if (/^(nao|não|errou|outra|corrige)\b/i.test(raw)) {
      await saveWeatherPrefs(db, input.userId, {
        ...prefs,
        pending: "ask_city",
        pending_place: null,
      });
      return askCityMessage(hintUf);
    }
    if (/^(sim|isso|confirmo|ok|pode|yes|ss)\b/i.test(raw)) {
      const place = prefs.pending_place;
      const next: WeatherPrefs = {
        enabled_morning: prefs.enabled_morning,
        alert_hour: prefs.alert_hour,
        alert_minute: prefs.alert_minute,
        place,
        pending: "ask_mode",
        pending_place: null,
      };
      // Se já pediu manhã/horário antes de confirmar cidade, pula menu
      if (prefs.enabled_morning || prefs.alert_hour !== null) {
        next.pending = null;
        await saveWeatherPrefs(db, input.userId, next);
        const footer =
          prefs.alert_hour !== null
            ? `_Aviso às ${formatAlertClock(prefs.alert_hour, prefs.alert_minute)}_`
            : prefs.enabled_morning
              ? "_No bom-dia + quando pedir_"
              : null;
        return await deliverForecast(place, raw, footer);
      }
      await saveWeatherPrefs(db, input.userId, next);
      return modesMenu(place.label);
    }
    const parsedRetry = parseCityUf(raw, hintUf);
    if (parsedRetry) {
      return await proposePlace(db, input.userId, prefs, parsedRetry);
    }
  }

  if (prefs.pending === "ask_city") {
    const parsed = parseCityUf(raw, hintUf);
    if (!parsed) {
      return ["Não entendi a cidade 🙈", askCityMessage(hintUf)].join("\n\n");
    }
    return await proposePlace(db, input.userId, prefs, parsed);
  }

  // —— Consulta: outro lugar / hoje / amanhã / semana ——
  const otherPlace = extractPlaceFromWeatherText(raw, hintUf);
  if (otherPlace && /(tempo|clima|previsao|temperatura|chove)/.test(norm)) {
    const place = await geocodeCityUf(otherPlace.city, otherPlace.uf);
    if (!place) {
      return `Não achei *${otherPlace.city}-${otherPlace.uf}*. Confere o nome e a UF?`;
    }
    const footer = prefs.place
      ? `_Sua cidade salva continua *${prefs.place.label}*_`
      : `_Salvar essa? diga “minha cidade é ${place.city} ${place.uf}”_`;
    return await deliverForecast(place, raw, footer);
  }

  if (prefs.place) {
    return await deliverForecast(prefs.place, raw);
  }

  await saveWeatherPrefs(db, input.userId, {
    ...prefs,
    pending: "ask_city",
    pending_place: null,
  });
  return [
    "Claro! Posso te falar o tempo *quando pedir*, no *bom-dia*, ou num *horário* que você escolher.",
    "",
    askCityMessage(hintUf),
  ].join("\n");
}

async function proposePlace(
  db: Db,
  userId: string,
  prefs: WeatherPrefs,
  parsed: { city: string; uf: string }
): Promise<string> {
  const place = await geocodeCityUf(parsed.city, parsed.uf);
  if (!place) {
    return [
      `Não achei *${parsed.city}-${parsed.uf}* 🔍`,
      "Confere o nome e a UF? Ex.: *Ribeirão Preto SP*",
    ].join("\n");
  }
  await saveWeatherPrefs(db, userId, {
    ...prefs,
    pending: "confirm",
    pending_place: place,
  });
  return [
    `Achei *${place.label}* 🇧🇷`,
    "",
    "É essa? Responda *sim* ou manda outra cidade/UF.",
  ].join("\n");
}

/** Para o daily brief — nunca lança. */
export async function weatherLineForBrief(
  db: Db,
  userId: string
): Promise<string | null> {
  try {
    const prefs = await getWeatherPrefs(db, userId);
    if (!prefs.enabled_morning || !prefs.place) return null;
    const bundle = await fetchForecast(prefs.place);
    if (!bundle) return null;
    return formatWeatherBriefLine(bundle);
  } catch {
    return null;
  }
}

/** Lista usuários com aviso de tempo no horário atual (SP). */
export function weatherAlertDueNow(
  prefs: WeatherPrefs,
  hour: number,
  minute: number
): boolean {
  if (prefs.alert_hour === null || !prefs.place) return false;
  // Janela de 15 min a partir do horário marcado (scheduler ~1 min)
  if (prefs.alert_hour !== hour) return false;
  return minute >= prefs.alert_minute && minute < prefs.alert_minute + 15;
}
