import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  askNotifyHour,
  buildChargeNotice,
  buildMeetingNotice,
  detectMeetingChannel,
  extractChargeName,
  extractTalkName,
  extractMoney,
  extractPeopleNames,
  formatDeskDay,
  formatDeskMoment,
  formatDeskMoney,
  isAbandon,
  isExpectedDeskAnswer,
  isFreshCommand,
  looksLikeCalendarSync,
  looksLikeChargeNow,
  looksLikeChargeSomeone,
  looksLikeDayList,
  looksLikeNoticeRewrite,
  mentionsOtherPeople,
  resolveChargeWhen,
} from "@/domain/desk-router";
import { looksLikeSocialFollowUp } from "@/domain/social-followup";
import { isTeamSelectionAnswer } from "@/domain/team-reminders";
import { GOOGLE_INVITE_NOT_ON_CALENDAR, parseGoogleRsvpChoice } from "@/integrations/google/rsvp";

describe("mesas invisíveis", () => {
  it("não trata lembrete pessoal como outra pessoa", () => {
    expect(mentionsOtherPeople("me lembra amanhã às 10h de ligar pro contador")).toBe(false);
    expect(looksLikeChargeSomeone("me lembra de pagar a conta de luz sexta às 18h")).toBe(false);
  });

  it("reconhece cobrança e reunião com gente", () => {
    expect(looksLikeChargeSomeone("lembre de cobrar o Fulano, ele me deve R$ 10 até sexta")).toBe(true);
    expect(extractChargeName("Cobrar o Zé para me pagar R$50 na sexta-feira próxima")).toBe("Zé");
    expect(looksLikeSocialFollowUp("Cobrar o Zé para me pagar R$50 na sexta-feira próxima")).toBe(false);
    expect(looksLikeSocialFollowUp("me lembra de cobrar a Ju amanhã")).toBe(true);
    expect(looksLikeSocialFollowUp("cobrar Pedro em 2 dias se não responder")).toBe(true);
    expect(extractMoney("ele me deve R$ 10 até sexta")).toBe("R$ 10");
    expect(mentionsOtherPeople("preciso marcar uma reunião com a Tatiana e o João amanhã às 19:00")).toBe(true);
    expect(extractPeopleNames("reunião com a Tatiana e o João amanhã às 19:00")).toEqual([
      "Tatiana",
      "João",
    ]);
    expect(detectMeetingChannel("vai ser pelo google meet")).toBe("meet");
  });

  it("cobra o Zé: valor, dia e hora do aviso", () => {
    expect(looksLikeChargeSomeone("Cobrar o Zé 50 sexta")).toBe(true);
    expect(extractChargeName("Cobrar o Zé 50 sexta")).toBe("Zé");
    expect(
      extractChargeName("O José me deve R$ 50, cobrar dele na sexta-feira às 10h00")
    ).toBe("José");
    expect(extractChargeName("cobrar dele")).toBeNull();
    expect(extractMoney("Cobrar o Zé 50 sexta")).toBe("R$ 50");
    expect(formatDeskMoney(extractMoney("Cobrar o Zé 50 sexta"))).toBe("R$ 50,00");
    expect(looksLikeSocialFollowUp("Cobrar o Zé 50 sexta")).toBe(false);
    expect(looksLikeSocialFollowUp("Cobrar o Zé")).toBe(false);
    const friday = DateTime.fromObject(
      { year: 2026, month: 10, day: 9, hour: 19, minute: 0 },
      { zone: "America/Sao_Paulo" }
    );
    expect(formatDeskDay(friday)).toBe("sexta 09/10");
    expect(formatDeskMoment(friday)).toBe("sexta 09/10 · 19h");
    expect(buildChargeNotice("Ana", "Zé", "R$ 50", "sexta 10/10")).toBe(
      "Oi, Zé. Ana pediu para te lembrar do pagamento de R$ 50,00 até sexta 10/10."
    );
    expect(buildChargeNotice("Ana", "José", "R$ 50", "agora")).toBe(
      "Oi, José. Ana pediu para te lembrar do pagamento de R$ 50,00."
    );
    expect(looksLikeChargeNow("José me deve R$50 cobra dele agora por favor")).toBe(true);
    expect(looksLikeChargeNow("cobrar o José na sexta")).toBe(false);
    expect(
      isExpectedDeskAnswer("agora", { kind: "charge", step: "ask_day" })
    ).toBe(true);
    const nowCharge = resolveChargeWhen(
      "José me deve R$50 cobra dele agora por favor",
      "America/Sao_Paulo"
    );
    expect(nowCharge?.sendNow).toBe(true);
    expect(nowCharge?.whenLabel).toBe("agora");
    expect(nowCharge?.needsHour).toBe(false);
    expect(buildMeetingNotice("Ana", "Tatiana", "sexta 10/10 · 19h", "meet")).toBe(
      "Oi, Tatiana. Ana pediu para te lembrar da reunião em sexta 10/10 · 19h, por Google Meet."
    );
    const hourAsk = askNotifyHour("Zé", "sexta 10/10");
    expect(hourAsk).toBe("Que horas eu aviso *Zé*? O dia fica sexta 10/10.");
    expect(hourAsk).not.toMatch(/10:00|10h/);
  });

  it("falar com a Ana passa pelo portão", () => {
    expect(mentionsOtherPeople("me lembra de falar com a Ana")).toBe(true);
    expect(extractTalkName("me lembra de falar com a Ana")).toBe("Ana");
    expect(looksLikeSocialFollowUp("me lembra de falar com a Ana")).toBe(false);
  });

  it("sincronizar agenda e o dia não viram aviso", () => {
    expect(isFreshCommand("Sincronizar agenda")).toBe(true);
    expect(looksLikeCalendarSync("Sincronizar agenda")).toBe(true);
    expect(looksLikeCalendarSync("Agenda Google")).toBe(true);
    expect(looksLikeDayList("Sincronizar agenda")).toBe(false);
    expect(isFreshCommand("compromissos de hoje?")).toBe(true);
    expect(looksLikeDayList("O que tenho para hoje ?")).toBe(true);
    expect(isFreshCommand("sim")).toBe(false);
    expect(isFreshCommand("15h")).toBe(false);
    expect(isTeamSelectionAnswer("1", 1, "selecting")).toBe(true);
    expect(isTeamSelectionAnswer("Sincronizar agenda", 1, "selecting")).toBe(false);
    expect(isTeamSelectionAnswer("o que tenho para hoje ?", 1, "selecting")).toBe(false);
    expect(isTeamSelectionAnswer("cancelar", 1, "selecting")).toBe(true);
    expect(isAbandon("deixa")).toBe(true);
    expect(isAbandon("esquece")).toBe(true);
    expect(isAbandon("sim")).toBe(false);
    expect(looksLikeNoticeRewrite("Oi, Zé. Paga até sexta.")).toBe(true);
    expect(looksLikeNoticeRewrite("Sincronizar agenda")).toBe(false);
    expect(
      isExpectedDeskAnswer("Sincronizar agenda", { kind: "charge", step: "confirm_text" })
    ).toBe(false);
    expect(isExpectedDeskAnswer("sim", { kind: "charge", step: "confirm_text" })).toBe(true);
    expect(isExpectedDeskAnswer("15h", { kind: "charge", step: "ask_time" })).toBe(true);
    expect(
      isExpectedDeskAnswer("me lembra de comprar pão", { kind: "charge", step: "confirm_text" })
    ).toBe(false);
    expect(isTeamSelectionAnswer("me lembra de comprar pão", 1, "selecting")).toBe(false);
  });
});

describe("resposta de convite google", () => {
  it("lê sim, não e talvez", () => {
    expect(parseGoogleRsvpChoice("sim")?.status).toBe("accepted");
    expect(parseGoogleRsvpChoice("sim")?.explicit).toBe(false);
    expect(parseGoogleRsvpChoice("não 2")?.status).toBe("declined");
    expect(parseGoogleRsvpChoice("não 2")?.index).toBe(2);
    expect(parseGoogleRsvpChoice("aceita o convite")?.explicit).toBe(true);
    expect(parseGoogleRsvpChoice("o que tenho hoje")).toBeNull();
    expect(GOOGLE_INVITE_NOT_ON_CALENDAR).toContain("ainda não está na sua agenda do Google");
    expect(GOOGLE_INVITE_NOT_ON_CALENDAR).toContain("adicionar convites");
  });
});
