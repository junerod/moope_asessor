import { describe, expect, it } from "vitest";
import {
  pickRichestByConversation,
  reminderShadowsAppointment,
} from "@/domain/digest-once";

describe("digest uma vez por conversa", () => {
  it("fica o resumo com mais conteúdo no mesmo Zap", () => {
    const picked = pickRichestByConversation([
      { externalConversationId: "zap-dev", score: 0, text: "Agenda livre" },
      { externalConversationId: "zap-dev", score: 5, text: "Agenda de hoje" },
      { externalConversationId: "outro", score: 1, text: "livre" },
    ]);
    expect(picked).toHaveLength(2);
    expect(picked.find((row) => row.externalConversationId === "zap-dev")?.score).toBe(
      5
    );
  });

  it("no mesmo Zap o workspace pessoal ganha do da empresa", () => {
    const picked = pickRichestByConversation([
      {
        externalConversationId: "zap-dev",
        score: 8,
        text: "Agenda locadora",
        personal: false,
      },
      {
        externalConversationId: "zap-dev",
        score: 1,
        text: "Agenda pessoal",
        personal: true,
      },
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.text).toBe("Agenda pessoal");
  });

  it("não lista o aviso do compromisso como segundo item", () => {
    const ids = new Set(["appt-1"]);
    const titles = new Set(["falar com sr. mauricio da livre via locadora"]);
    expect(
      reminderShadowsAppointment(
        {
          title: "Compromisso: Falar com Sr. Maurício da Livre Via Locadora",
          payload: { appointment_id: "appt-1" },
        },
        ids,
        titles
      )
    ).toBe(true);
    expect(
      reminderShadowsAppointment(
        { title: "Pagar condomínio", payload: {} },
        ids,
        titles
      )
    ).toBe(false);
  });
});
