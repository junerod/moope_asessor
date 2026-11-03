import { describe, it, expect } from "vitest";
import {
  parseBaixaIntent,
  parseSpokenDone,
  formatInteractiveDayAgenda,
  orderTodayRemindersForBaixa,
  type DayReminderRow,
} from "@/domain/reminder-baixa";
import { agendaCore, displayAgendaTitle } from "@/domain/day-agenda";
import {
  extractPaidSubject,
  pendingTitleMatchesSubject,
} from "@/domain/receipt-prompt";

describe("parseBaixaIntent", () => {
  it("entende baixa por números (só lembretes)", () => {
    expect(parseBaixaIntent("baixa 1")).toEqual({
      kind: "baixa_indices",
      indices: [1],
    });
    expect(parseBaixaIntent("baixa 1 e 3")).toEqual({
      kind: "baixa_indices",
      indices: [1, 3],
    });
    expect(parseBaixaIntent("baixa numero 2")).toEqual({
      kind: "baixa_indices",
      indices: [2],
    });
  });

  it("atalhos sem número", () => {
    expect(parseBaixaIntent("ainda não")?.kind).toBe("ainda_nao");
    expect(parseBaixaIntent("concluí o que já passou")?.kind).toBe(
      "baixa_all_past"
    );
  });

  it("não confunde com outros pedidos", () => {
    expect(parseBaixaIntent("o que tenho hoje?")).toBeNull();
    expect(parseBaixaIntent("dei baixa no gilson")).toEqual({
      kind: "baixa_query",
      queries: ["gilson"],
    });
    expect(parseBaixaIntent("dei baixa pagar condominio e pagar maffa")).toEqual({
      kind: "baixa_query",
      queries: ["pagar condominio", "pagar maffa"],
    });
    expect(parseBaixaIntent("remover Tatiana do grupo CRM")).toBeNull();
  });

  it("baixar e remover compromisso pelo título, inclusive de ontem", () => {
    expect(parseBaixaIntent("baixar compromisso: Falar com Adan")).toEqual({
      kind: "baixa_query",
      queries: ["falar com adan"],
    });
    expect(parseBaixaIntent("remover compromisso de ontem: Falar com Adan")).toEqual({
      kind: "baixa_query",
      queries: ["falar com adan"],
    });
    expect(parseBaixaIntent("quero remover um compromisso como faço??")?.kind).toBe(
      "baixa_ask"
    );
  });

  it("já paguei o telefone não é o MAFFA", () => {
    expect(parseSpokenDone("Já paguei o telefone")).toBe("telefone");
    expect(extractPaidSubject("Já paguei o telefone")).toBe("telefone");
    expect(pendingTitleMatchesSubject("Pagar MAFFA", "telefone")).toBe(false);
    expect(pendingTitleMatchesSubject("Pagar telefone", "telefone")).toBe(true);
    expect(extractPaidSubject("já paguei")).toBeNull();
  });
});

describe("um nome só na agenda", () => {
  it("junta lembrete e compromisso pelo mesmo assunto", () => {
    expect(displayAgendaTitle("Lembrete: Reunião")).toBe("Reunião");
    expect(displayAgendaTitle("Reunião amanhã às 9h30")).toBe("Reunião");
    expect(agendaCore("Lembrete: Reunião")).toBe(agendaCore("Reunião amanhã às 9h30"));
  });
});

describe("agenda do dia (só lembretes)", () => {
  const tz = "America/Sao_Paulo";

  function rem(
    id: string,
    title: string,
    hoursAgo: number,
    status = "scheduled"
  ): DayReminderRow {
    return {
      id,
      title,
      fireAt: new Date(Date.now() - hoursAgo * 3600_000),
      timezone: tz,
      status,
      recurrenceRule: null,
      payload: null,
    };
  }

  it("numera passados primeiro e mostra CTA", () => {
    const rows = [
      rem("a", "Dentista", -2),
      rem("b", "Remédio", 1, "sent"),
    ];
    const summary = formatInteractiveDayAgenda(rows, tz);
    expect(summary).toMatch(/\*1\.\*/);
    expect(summary).toMatch(/\*2\.\*/);
    expect(summary).toMatch(/baixa 1/);
    expect(summary).not.toMatch(/baixa lembrete 1/);
    expect(summary).not.toMatch(/Tarefas abertas/);
    const ordered = orderTodayRemindersForBaixa(rows, tz);
    expect(ordered.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
