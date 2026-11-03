import { registerTool } from "./registry";

registerTool({
  name: "get_weather",
  description:
    "Previsão do tempo (hoje/semana) na cidade do usuário. Use em 'como está o tempo', 'previsão', 'vai chover'. Se faltar cidade, a tool orienta o cadastro.",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string" },
      uf: { type: "string" },
      week: { type: "boolean" },
    },
  },
  async handler(ctx, args) {
    const { handleWeatherTurn, getWeatherPrefs } = await import(
      "@/domain/weather-prefs"
    );
    const {
      geocodeCityUf,
      fetchForecast,
      formatWeatherCard,
    } = await import("@/domain/weather");

    const city = args.city ? String(args.city).trim() : "";
    const uf = args.uf ? String(args.uf).trim().toUpperCase() : "";
    if (city && uf) {
      const place = await geocodeCityUf(city, uf);
      if (!place) {
        return {
          ok: false,
          summary: `Não achei ${city}-${uf}. Peça cidade e UF de novo.`,
          errorCode: "not_found",
        };
      }
      const bundle = await fetchForecast(place);
      if (!bundle) {
        return {
          ok: false,
          summary: "Falha ao buscar previsão. Tente de novo.",
          errorCode: "upstream",
        };
      }
      return {
        ok: true,
        summary: formatWeatherCard(bundle, { week: args.week !== false }),
        data: { place },
      };
    }

    const prefs = await getWeatherPrefs(ctx.db, ctx.userId);
    if (prefs.place) {
      const bundle = await fetchForecast(prefs.place);
      if (!bundle) {
        return {
          ok: false,
          summary: "Falha ao buscar previsão. Tente de novo.",
          errorCode: "upstream",
        };
      }
      return {
        ok: true,
        summary: formatWeatherCard(bundle, {
          week: Boolean(args.week) || /semana/i.test(String(ctx.userText || "")),
        }),
      };
    }

    const reply = await handleWeatherTurn(ctx.db, {
      userId: ctx.userId,
      text: String(ctx.userText || "previsão do tempo"),
      phoneE164: null,
    });
    return { ok: true, summary: reply };
  },
});
