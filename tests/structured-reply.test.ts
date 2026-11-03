import { describe, expect, it } from "vitest";
import { mergeStructuredToolResults } from "@/agent/runtime";
import { looksLikeLegalAsk } from "@/domain/legal-docs";
import { looksLikeDayList } from "@/domain/desk-router";
import { parseBaixaIntent } from "@/domain/reminder-baixa";

describe("mergeStructuredToolResults", () => {
  it("agenda pessoal e locadora aparecem as duas, pessoal primeiro", () => {
    const pick = mergeStructuredToolResults([
      { name: "query_locadora", summary: "frota" },
      { name: "list_reminders", summary: "compromissos" },
    ]);
    expect(pick.map((t) => t.name)).toEqual([
      "list_reminders",
      "query_locadora",
    ]);
  });

  it("só locadora continua só locadora", () => {
    const pick = mergeStructuredToolResults([
      { name: "query_locadora", summary: "frota" },
      { name: "locadora_snapshot", summary: "snap" },
    ]);
    expect(pick.map((t) => t.name)).toEqual([
      "query_locadora",
      "locadora_snapshot",
    ]);
  });

  it("só agenda pessoal não muda", () => {
    const pick = mergeStructuredToolResults([
      { name: "list_reminders", summary: "hoje" },
      { name: "list_tasks", summary: "tarefas" },
    ]);
    expect(pick.map((t) => t.name)).toEqual([
      "list_reminders",
      "list_tasks",
    ]);
  });
});

describe("portas pessoais no áudio (mesma ordem do atalho)", () => {
  it("termos, meus compromissos e baixa não se atropelam", () => {
    expect(looksLikeLegalAsk("termos de privacidade")).toBe(true);
    expect(looksLikeDayList("meus compromissos")).toBe(true);
    expect(parseBaixaIntent("baixa 1")?.kind).toBe("baixa_indices");
    expect(looksLikeDayList("baixar compromisso: Falar com Adan")).toBe(false);
    expect(parseBaixaIntent("meus compromissos")).toBeNull();
  });
});
