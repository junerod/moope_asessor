import { registerTool } from "./registry";

registerTool({
  name: "get_exchange_rate",
  description:
    "Cotação de moeda em reais (USD, EUR, GBP, BTC…). Use em 'cotação do dólar', 'quanto está o euro', '100 dólares em reais'. NÃO use para passagem/hotel.",
  inputSchema: {
    type: "object",
    properties: {
      currency: {
        type: "string",
        description: "Código ISO: USD, EUR, GBP, BTC…",
      },
      amount: {
        type: "number",
        description: "Valor na moeda estrangeira para converter (opcional)",
      },
    },
  },
  async handler(_ctx, args) {
    const {
      fetchFxToBrl,
      formatFxCard,
      detectFxCurrency,
      detectFxAmount,
      handleFxTurn,
    } = await import("@/domain/exchange-rate");

    const text = String(_ctx.userText || "");
    const currencyArg = args.currency
      ? String(args.currency).toUpperCase().trim()
      : "";
    const amountArg =
      typeof args.amount === "number" && Number.isFinite(args.amount)
        ? Number(args.amount)
        : detectFxAmount(text);

    if (!currencyArg && text) {
      return { ok: true, summary: await handleFxTurn(text) };
    }

    const detected = currencyArg
      ? { code: currencyArg, label: currencyArg }
      : detectFxCurrency(text || "dólar");
    const quote = await fetchFxToBrl(detected.code);
    if (!quote) {
      return {
        ok: false,
        summary: `Não achei cotação de ${detected.code} agora.`,
        errorCode: "upstream",
      };
    }
    return {
      ok: true,
      summary: formatFxCard(quote, {
        amount: amountArg,
        label: detected.label,
      }),
      data: { quote },
    };
  },
});
