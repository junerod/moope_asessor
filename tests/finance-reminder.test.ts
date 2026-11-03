import { describe, expect, it } from "vitest";
import {
  isFinanceCustomerReminder,
  outboundDirection,
} from "@/channels/zernio/finance-reminder";

describe("finance reminder guard", () => {
  it("reconhece o template de lembrete do Gestão", () => {
    expect(
      isFinanceCustomerReminder(
        "Lembrete: teste!!!\nData e Hora: 27/09/2026 às 13:50\nEquipe SOLUTTCAR"
      )
    ).toBe(true);
    expect(isFinanceCustomerReminder("me lembra amanhã às 9h")).toBe(false);
  });

  it("trata mensagem de saída como fora do Assessor", () => {
    expect(
      outboundDirection({
        data: { message: { direction: "outgoing", text: "oi" } },
      })
    ).toBe(true);
    expect(
      outboundDirection({
        data: { message: { direction: "incoming", text: "oi" } },
      })
    ).toBe(false);
  });
});