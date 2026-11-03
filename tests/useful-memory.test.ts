import { describe, expect, it } from "vitest";
import {
  looksLikeUsefulMemoryIntent,
  parseUsefulMemorySave,
  isListMemoriesCommand,
} from "@/domain/useful-memory";

describe("useful-memory", () => {
  it("detecta intenção", () => {
    expect(
      looksLikeUsefulMemoryIntent(
        "lembra que meu dentista é Dr. Silva na Asa Sul"
      )
    ).toBe(true);
    expect(looksLikeUsefulMemoryIntent("minha placa é ABC1D23")).toBe(true);
    expect(looksLikeUsefulMemoryIntent("o que você lembra de mim?")).toBe(true);
    expect(looksLikeUsefulMemoryIntent("gastei 50 de uber")).toBe(false);
  });

  it("parseia fato", () => {
    const a = parseUsefulMemorySave(
      "lembra que meu dentista é Dr. Silva na Asa Sul"
    );
    expect(a?.content).toMatch(/dentista/i);
    expect(a?.type).toBe("person");
    const b = parseUsefulMemorySave("minha placa é ABC1D23");
    expect(b?.content).toMatch(/placa/i);
  });

  it("lista", () => {
    expect(isListMemoriesCommand("o que você lembra de mim")).toBe(true);
  });
});
