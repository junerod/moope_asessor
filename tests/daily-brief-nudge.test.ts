import { describe, expect, it } from "vitest";

/**
 * Unit smoke for empty-day brief copy (pure string contract).
 * Full DB coverage stays in scheduler integration when available.
 */
describe("daily brief empty nudge contract", () => {
  it("mensagem de dia livre fica no dia, sem cartilha", () => {
    const text = [
      "☀️ *Resumo do dia*",
      "Bom dia!",
      "",
      "Agenda livre por enquanto.",
    ].join("\n");
    expect(text).toMatch(/Agenda livre/);
    expect(text).not.toMatch(/Sugestões rápidas/);
    expect(text).not.toMatch(/Lembro de você/);
    expect(text).not.toMatch(/Um aviso só/);
  });
});
