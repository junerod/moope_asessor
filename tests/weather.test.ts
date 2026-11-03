import { describe, expect, it } from "vitest";
import {
  parseCityUf,
  ufFromPhoneE164,
  weatherEmoji,
  formatWeatherCard,
  parseWeatherFocus,
  parseClockHourMinute,
  extractPlaceFromWeatherText,
  type WeatherBundle,
} from "@/domain/weather";
import {
  looksLikeWeatherIntent,
  weatherAlertDueNow,
} from "@/domain/weather-prefs";

const bundle: WeatherBundle = {
  place: {
    city: "Brasília",
    uf: "DF",
    country: "BR",
    lat: -15.78,
    lon: -47.93,
    label: "Brasília-DF",
  },
  today: {
    date: "2026-09-26",
    tMax: 31,
    tMin: 18,
    precipProb: 20,
    weatherCode: 0,
  },
  week: [
    {
      date: "2026-09-26",
      tMax: 31,
      tMin: 18,
      precipProb: 20,
      weatherCode: 0,
    },
    {
      date: "2026-09-27",
      tMax: 29,
      tMin: 17,
      precipProb: 60,
      weatherCode: 61,
    },
    {
      date: "2026-09-28",
      tMax: 28,
      tMin: 16,
      precipProb: 10,
      weatherCode: 1,
    },
  ],
  fetchedAt: new Date().toISOString(),
};

describe("weather helpers", () => {
  it("mapeia DDD → UF", () => {
    expect(ufFromPhoneE164("+5561996715985")).toBe("DF");
    expect(ufFromPhoneE164("+5511987654321")).toBe("SP");
  });

  it("parseia cidade, foco e horário", () => {
    expect(parseCityUf("Brasília DF")).toEqual({
      city: "Brasília",
      uf: "DF",
    });
    expect(parseWeatherFocus("tempo amanhã")).toBe("tomorrow");
    expect(parseWeatherFocus("previsão da semana")).toBe("week");
    expect(parseClockHourMinute("às 7h")).toEqual({ hour: 7, minute: 0 });
    expect(parseClockHourMinute("18:30")).toEqual({ hour: 18, minute: 30 });
    expect(extractPlaceFromWeatherText("tempo em Curitiba PR amanhã")).toEqual(
      {
        city: "Curitiba",
        uf: "PR",
      }
    );
  });

  it("detecta intent sem roubar outras frases", () => {
    expect(looksLikeWeatherIntent("como vai estar o tempo amanhã?")).toBe(
      true
    );
    expect(looksLikeWeatherIntent("me avisa o tempo todo dia às 7h")).toBe(
      true
    );
    expect(looksLikeWeatherIntent("o que tenho hoje?")).toBe(false);
  });

  it("formata card hoje/amanhã/semana", () => {
    expect(weatherEmoji(0)).toBe("☀️");
    expect(formatWeatherCard(bundle, { focus: "today" })).toMatch(/Hoje/);
    expect(formatWeatherCard(bundle, { focus: "tomorrow" })).toMatch(/Amanhã/);
    expect(formatWeatherCard(bundle, { focus: "week" })).toMatch(/Semana/);
  });

  it("janela do aviso agendado", () => {
    const prefs = {
      enabled_morning: false,
      alert_hour: 7,
      alert_minute: 0,
      place: bundle.place,
      pending: null,
      pending_place: null,
    };
    expect(weatherAlertDueNow(prefs, 7, 5)).toBe(true);
    expect(weatherAlertDueNow(prefs, 7, 20)).toBe(false);
    expect(weatherAlertDueNow(prefs, 8, 0)).toBe(false);
  });
});
