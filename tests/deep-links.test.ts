import { describe, expect, it } from "vitest";
import {
  buildActionDeepLinks,
  formatDeepLinksBlock,
  guessRouteCities,
} from "@/domain/deep-links";

describe("deep links", () => {
  it("guesses brasilia -> salvador", () => {
    const r = guessRouteCities(
      "preco passagem aerea de brasilia para salvador semana que vem"
    );
    expect(r.from).toMatch(/brasilia/);
    expect(r.to).toMatch(/salvador/);
  });

  it("builds google flights link", () => {
    const links = buildActionDeepLinks(
      "passagem de brasilia para salvador"
    );
    expect(links.some((l) => l.includes("google.com/travel/flights"))).toBe(
      true
    );
    expect(formatDeepLinksBlock("passagem BSB SSA")).toMatch(/Atalhos/);
  });
});
