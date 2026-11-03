import { describe, expect, it } from "vitest";
import {
  looksLikeFxIntent,
  detectFxCurrency,
  detectFxAmount,
  formatFxCard,
  type FxQuote,
} from "@/domain/exchange-rate";

describe("exchange-rate", () => {
  it("detecta intent de câmbio (não viagem)", () => {
    expect(looksLikeFxIntent("cotação do dólar")).toBe(true);
    expect(looksLikeFxIntent("quanto está o euro?")).toBe(true);
    expect(looksLikeFxIntent("100 dólares em reais")).toBe(true);
    expect(looksLikeFxIntent("cotação passagem SP Salvador")).toBe(false);
    expect(looksLikeFxIntent("o que tenho hoje?")).toBe(false);
  });

  it("detecta moeda e valor", () => {
    expect(detectFxCurrency("cotação do euro")).toEqual({
      code: "EUR",
      label: "Euro",
    });
    expect(detectFxAmount("quanto é 100 dólares")).toBe(100);
    expect(detectFxAmount("50,5 euros")).toBe(50.5);
  });

  it("formata card em R$", () => {
    const q: FxQuote = {
      base: "USD",
      quote: "BRL",
      name: "Dólar Americano/Real Brasileiro",
      bid: 5.12,
      ask: 5.14,
      pctChange: 0.25,
      at: "2026-09-26 10:00:00",
      source: "test",
    };
    const card = formatFxCard(q, { amount: 100, label: "Dólar americano" });
    expect(card).toMatch(/Câmbio · USD/);
    expect(card).toMatch(/R\$/);
    expect(card).toMatch(/Convers[aã]o/);
  });
});
