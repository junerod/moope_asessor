import { describe, expect, it } from "vitest";
import {
  parseAlsoNotifyGroups,
  parseContactGroupCommand,
} from "@/domain/family-contacts";

describe("frases de grupo", () => {
  it("lista com jeitos diferentes", () => {
    expect(parseContactGroupCommand("meus grupos?")?.action).toBe("list");
    expect(parseContactGroupCommand("quais grupos eu estou")?.action).toBe("list");
    expect(parseContactGroupCommand("listar grupos")?.action).toBe("list");
  });

  it("mostra quem está e adiciona", () => {
    expect(parseContactGroupCommand("quem está no grupo CRM")).toEqual({
      action: "show",
      groupName: "CRM",
    });
    expect(parseContactGroupCommand("adiciona Ana no grupo CRM")).toMatchObject({
      action: "add",
      contactName: "Ana",
      groupName: "CRM",
    });
  });

  it("manda o texto agora e não rouba lembrete com horário", () => {
    expect(parseContactGroupCommand("reunião às 15h para o grupo CRM")).toEqual({
      action: "message",
      message: "reunião às 15h",
      groupName: "CRM",
    });
    expect(
      parseContactGroupCommand("me lembra amanhã às 10 reunião para o grupo CRM")
    ).toBeNull();
    expect(
      parseAlsoNotifyGroups("me lembra amanhã às 10 reunião para o grupo CRM")
    ).toEqual(["CRM"]);
  });

  it("pede horário quando o lembrete do grupo não tem hora", () => {
    expect(parseContactGroupCommand("lembrete para o grupo Família")).toEqual({
      action: "ask-reminder",
      groupName: "Família",
    });
  });
});
