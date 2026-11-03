import { describe, expect, it } from "vitest";
import {
  isAbandon,
  isExpectedDeskAnswer,
  isFreshCommand,
  looksLikeCalendarSync,
  looksLikeChargeSomeone,
  looksLikeDayList,
  looksLikeNoticeRewrite,
  mentionsOtherPeople,
} from "@/domain/desk-router";
import { isTeamSelectionAnswer } from "@/domain/team-reminders";
import { looksLikeSpend, looksLikeUndo } from "@/domain/receipt-undo";
import { looksLikeClashAsk, looksLikeFreeSlotAsk } from "@/domain/agenda-gaps";
import { looksLikeSocialFollowUp } from "@/domain/social-followup";
import { organizerChatUrl, withOrganizerChat } from "@/domain/external-notice";
import { parseGoogleRsvpChoice } from "@/integrations/google/rsvp";

const COMMANDS = [
  "Sincronizar agenda",
  "Agenda Google",
  "compromissos de hoje?",
  "O que tenho para hoje ?",
  "gastei 40 no almoço",
  "sexta de manhã livre?",
  "tem choque na agenda?",
  "painel",
  "quem me deve?",
  "a quem eu devo?",
  "como está o teto",
  "gastos do mês",
  "faz a ata",
  "me dá um link pra a pessoa marcar",
  "relatório de tarefas",
  "tem convite no email?",
  "isso saiu do padrão hoje?",
  "documentos da pasta contratos",
  "tarefas atrasadas",
];

describe("nada trava o resto", () => {
  it("comando novo não vira aviso, lista nem texto de convite", () => {
    for (const phrase of COMMANDS) {
      expect(isFreshCommand(phrase), phrase).toBe(true);
      expect(isTeamSelectionAnswer(phrase, 3, "selecting"), phrase).toBe(false);
      expect(looksLikeNoticeRewrite(phrase), phrase).toBe(false);
      expect(
        isExpectedDeskAnswer(phrase, { kind: "charge", step: "confirm_text" }),
        phrase
      ).toBe(false);
    }
  });

  it("cobrança, follow-up, gasto e agenda continuam no lugar certo", () => {
    expect(looksLikeChargeSomeone("Cobrar o Zé 50 sexta")).toBe(true);
    expect(looksLikeChargeSomeone("o Lucas me deve 80")).toBe(false);
    expect(looksLikeChargeSomeone("Emprestei 200 pro Lucas")).toBe(false);
    expect(mentionsOtherPeople("Cobrar o Zé 50 sexta")).toBe(true);
    expect(mentionsOtherPeople("o Lucas me deve 80")).toBe(false);
    expect(looksLikeSocialFollowUp("me lembra de cobrar a Ju amanhã")).toBe(true);
    expect(looksLikeSocialFollowUp("Cobrar o Zé 50 sexta")).toBe(false);
    expect(looksLikeSpend("Gastei 40 no almoço")?.amount).toBe(40);
    expect(looksLikeUndo("desfaz")?.phrase).toBeNull();
    expect(looksLikeCalendarSync("Sincronizar agenda")).toBe(true);
    expect(looksLikeDayList("compromissos de hoje?")).toBe(true);
    expect(looksLikeDayList("Meus compromissos")).toBe(true);
    expect(looksLikeDayList("baixar compromisso: Falar com Adan")).toBe(false);
    expect(looksLikeDayList("remover compromisso de ontem: Falar com Adan")).toBe(
      false
    );
    expect(looksLikeFreeSlotAsk("Sexta de manhã livre?")).toBe(true);
    expect(looksLikeClashAsk("Tem choque na agenda?")).toBe(true);
    expect(parseGoogleRsvpChoice("o que tenho hoje")).toBeNull();
    expect(isAbandon("cancelar")).toBe(true);
    expect(isExpectedDeskAnswer("sim", { kind: "charge", step: "confirm_text" })).toBe(true);
    expect(isTeamSelectionAnswer("1", 1, "selecting")).toBe(true);
    const link = withOrganizerChat("Oi, Zé.", "June", "+5561996715985");
    expect(link).toContain(organizerChatUrl("+5561996715985", "Oi, June") || "wa.me");
    expect(link).not.toContain("13232508113");
  });
});
