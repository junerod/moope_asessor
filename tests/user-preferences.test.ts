import { describe, expect, it } from "vitest";
import {
  formatPreferencesMessage,
  looksLikePreferencesCommand,
  parsePreferencesCommand,
  parsePrefsFromProfile,
} from "@/domain/user-preferences";

describe("user-preferences", () => {
  it("detecta comandos", () => {
    expect(looksLikePreferencesCommand("preferências")).toBe(true);
    expect(looksLikePreferencesCommand("/preferencias")).toBe(true);
    expect(looksLikePreferencesCommand("desliga o resumo do dia")).toBe(true);
    expect(looksLikePreferencesCommand("me lembre às 10h")).toBe(false);
  });

  it("parseia liga/desliga", () => {
    expect(parsePreferencesCommand("desliga o resumo do dia")).toEqual({
      action: "set",
      key: "daily_brief",
      value: false,
    });
    expect(parsePreferencesCommand("liga alertas de meta")).toEqual({
      action: "set",
      key: "goal_alerts",
      value: true,
    });
  });

  it("defaults on", () => {
    const p = parsePrefsFromProfile({});
    expect(p.daily_brief).toBe(true);
    expect(formatPreferencesMessage(p)).toMatch(/Preferências/);
  });
});
