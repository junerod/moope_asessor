import { describe, expect, it } from "vitest";
import { looksLikePainelMenu } from "@/domain/painel-menu";

describe("looksLikePainelMenu", () => {
  it("abre a lista quando a pessoa só pede o painel", () => {
    expect(looksLikePainelMenu("painel")).toBe(true);
    expect(looksLikePainelMenu("ver no celular")).toBe(true);
    expect(looksLikePainelMenu("abrir o painel")).toBe(true);
    expect(looksLikePainelMenu("painel da locadora")).toBe(false);
    expect(looksLikePainelMenu("balanço do mês")).toBe(false);
  });
});
