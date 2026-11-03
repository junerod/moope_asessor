import { describe, expect, it } from "vitest";
import { looksLikeAppointmentCreate } from "@/domain/appointment-intent";
import { askedBusinessKind } from "@/domain/business-context";
import {
  isBusinessWorldCommand,
  isPersonalLifeCommand,
} from "@/domain/command-world";
import { looksLikeDayList } from "@/domain/desk-router";
import {
  facejusAgendaKind,
  facejusAgendaQuestion,
} from "@/domain/facejus-commands";
import { classifyTurnAct } from "@/domain/turn-act";

describe("comandos Facejus de agenda", () => {
  it("separa atendimento e prazos sem pegar a agenda pessoal", () => {
    expect(facejusAgendaKind("agenda de atendimento")).toBe("atendimento");
    expect(facejusAgendaKind("agenda de atendimento da filial Içara")).toBe("atendimento");
    expect(facejusAgendaKind("agenda de atendimento OAB 15444")).toBe("atendimento");
    expect(facejusAgendaKind("atendimentos de hoje")).toBe("atendimento");
    expect(facejusAgendaKind("PDF agenda de atendimento")).toBe("atendimento");
    expect(facejusAgendaKind("agenda de prazos")).toBe("prazos");
    expect(facejusAgendaKind("agenda de prazos processuais")).toBe("prazos");
    expect(facejusAgendaKind("prazos processuais da semana")).toBe("prazos");
    expect(facejusAgendaKind("PDF agenda de prazos")).toBe("prazos");

    expect(facejusAgendaKind("agenda de amanhã")).toBeNull();
    expect(facejusAgendaKind("agenda jurídica de hoje")).toBeNull();
    expect(facejusAgendaKind("agenda OAB 15444")).toBeNull();
    expect(facejusAgendaKind("prazos judiciais")).toBeNull();
    expect(facejusAgendaKind("marcar atendimento amanhã às 15h")).toBeNull();
    expect(facejusAgendaKind("meus processos")).toBeNull();
  });

  it("manda ao Facejus uma frase que escolhe a natureza e preserva filtro", () => {
    expect(facejusAgendaQuestion("atendimentos de hoje", "atendimento")).toBe(
      "agenda de atendimento de hoje"
    );
    expect(
      facejusAgendaQuestion("agenda de atendimento da filial Içara", "atendimento")
    ).toBe("agenda de atendimento da filial Içara");
    expect(facejusAgendaQuestion("meus atendimentos", "atendimento")).toBe(
      "agenda de atendimento"
    );
    expect(facejusAgendaQuestion("prazos processuais da semana", "prazos")).toBe(
      "agenda de prazos processuais da semana"
    );
    expect(facejusAgendaQuestion("agenda de prazos OAB 15444", "prazos")).toBe(
      "agenda de prazos OAB 15444"
    );
  });

  it("não contamina compromisso pessoal nem a lista do dia", () => {
    for (const said of [
      "agenda de atendimento",
      "agenda de prazos processuais",
      "atendimentos de hoje",
    ]) {
      expect(isPersonalLifeCommand(said)).toBe(false);
      expect(isBusinessWorldCommand(said)).toBe(true);
      expect(classifyTurnAct(said)).toBe("consultar_empresa");
      expect(askedBusinessKind(said)).toBe("facejus");
      expect(looksLikeDayList(said)).toBe(false);
      expect(looksLikeAppointmentCreate(said)).toBe(false);
    }

    expect(isPersonalLifeCommand("Agenda de amanhã")).toBe(true);
    expect(isPersonalLifeCommand("Meus compromissos")).toBe(true);
    expect(isPersonalLifeCommand("baixa 1")).toBe(true);
    expect(isBusinessWorldCommand("Agenda de amanhã")).toBe(false);
    expect(looksLikeDayList("Agenda de amanhã")).toBe(true);
    expect(classifyTurnAct("Agenda de amanhã")).toBe("listar_dia");

    const marcar = "marcar atendimento amanhã às 15h";
    expect(isPersonalLifeCommand(marcar)).toBe(true);
    expect(isBusinessWorldCommand(marcar)).toBe(false);
    expect(looksLikeAppointmentCreate(marcar)).toBe(true);
    expect(classifyTurnAct(marcar)).toBe("registrar_pessoal");

    expect(isBusinessWorldCommand("prazos judiciais")).toBe(true);
    expect(facejusAgendaKind("agenda jurídica de hoje")).toBeNull();
    expect(isPersonalLifeCommand("agenda jurídica de hoje")).toBe(false);
  });
});
