import { describe, expect, it } from "vitest";
import { parseSign } from "@/domain/horoscope";
import { looksLikeHoroscopeTurn } from "@/domain/horoscope-prefs";

describe("horóscopo oculto", () => {
  it("reconhece signo e pedido", () => {
    expect(parseSign("sou de leão")).toBe("leao");
    expect(looksLikeHoroscopeTurn("horóscopo")).toBe(true);
    expect(looksLikeHoroscopeTurn("me lembra amanhã às 9h de ligar pro dentista")).toBe(
      false
    );
  });

  it("não engole lembrete enquanto espera horário", () => {
    const pending = {
      enabled: false,
      sign: "leao" as const,
      hour: 8,
      minute: 0,
      pending: "ask_time" as const,
    };
    expect(looksLikeHoroscopeTurn("8h", pending)).toBe(true);
    expect(looksLikeHoroscopeTurn("não", pending)).toBe(true);
    expect(
      looksLikeHoroscopeTurn("me lembra amanhã às 9h de pagar a conta", pending)
    ).toBe(false);
  });
});
