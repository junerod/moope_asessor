import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  hasExplicitClockTime,
  parseNaturalDateTime,
} from "@/lib/datetime";
import {
  buildCreateReminderArgs,
  looksLikeReminderCreate,
} from "@/domain/reminder-intent";
import {
  buildCreateAppointmentArgs,
  looksLikeAppointmentCreate,
} from "@/domain/appointment-intent";
import { looksLikeDayList } from "@/domain/desk-router";
import { looksLikeRouteIntent } from "@/domain/routes";
import { isBusinessWorldCommand, isPersonalLifeCommand } from "@/domain/command-world";
import { visibleReminderNote } from "@/lib/reminder-copy";
import { classifyTurnAct } from "@/domain/turn-act";
import { looksLikeFreeSlotAsk } from "@/domain/agenda-gaps";

const TZ = "America/Sao_Paulo";
const NOW = DateTime.fromISO("2026-09-24T10:00:00", { zone: TZ });

describe("datetime parser (P2)", () => {
  it("reconhece 18h00, 11hs e daqui a N minutos", () => {
    expect(hasExplicitClockTime("Lembrete às 18h00: pagar")).toBe(true);
    expect(hasExplicitClockTime("me lembre às 11hs")).toBe(true);
    expect(hasExplicitClockTime("daqui a 15 minutos")).toBe(true);
  });

  it("parseia 18h00 e daqui a minutos", () => {
    const a = parseNaturalDateTime("hoje às 18h00", TZ, NOW);
    expect(a?.hour).toBe(18);
    expect(a?.minute).toBe(0);

    const b = parseNaturalDateTime("daqui a 15 minutos", TZ, NOW);
    expect(b?.toMillis()).toBe(NOW.plus({ minutes: 15 }).toMillis());

    const c = parseNaturalDateTime("às 11hs", TZ, NOW);
    expect(c?.hour).toBe(11);
  });
});

describe("reminder-direct args", () => {
  it("cria args para me lembre + 18h00", () => {
    expect(looksLikeReminderCreate("me lembre às 18h00 de pagar o condomínio")).toBe(
      true
    );
    const args = buildCreateReminderArgs(
      "me lembre às 18h00 de pagar o condomínio",
      TZ
    );
    expect(args?.title.toLowerCase()).toMatch(/condom/);
    expect(args?.fire_at_iso).toBeTruthy();
  });

  it("aceita Lembrete às 18h00: … e rejeita negativa", () => {
    expect(
      looksLikeReminderCreate(
        "Lembrete às 18h00: verificar problema no veículo"
      )
    ).toBe(true);
    expect(
      looksLikeReminderCreate(
        "Amanhã par Amanda to chios não tem de lembrar amanhã às 11hs isso?"
      )
    ).toBe(false);
  });
});

describe("appointment-direct args", () => {
  it("cria compromisso com horário sem passar pelo LLM", () => {
    expect(
      looksLikeAppointmentCreate("agendar reunião com João amanhã às 14h30")
    ).toBe(true);
    const args = buildCreateAppointmentArgs(
      "agendar reunião com João amanhã às 14h30",
      TZ
    );
    expect(args?.title.toLowerCase()).toMatch(/joão|reun/);
    expect(args?.starts_at_iso).toBeTruthy();
    expect(args?.reminder_before_minutes).toBe(15);
  });

  it("agenda pessoal com 17h e assunto de contrato não vira locadora", () => {
    const said =
      "Agendar para 17h00, falar com cliente LOCACCAR, sobre ajuste nos contratos de investidores, e envio automático de mensagens para locatários, e acesso em massa da plataforma.";
    expect(looksLikeAppointmentCreate(said)).toBe(true);
    const args = buildCreateAppointmentArgs(said, TZ);
    expect(args?.title.toLowerCase()).toMatch(/locaccar/);
    expect(args?.reminder_before_minutes).toBe(15);
    expect(args?.title.toLowerCase()).not.toMatch(/desfaz|valor é 55/);
  });

  it("separa o assunto do aviso de meia hora antes", () => {
    const said =
      "Agendar reunião amanhã às 11h30, e me avisar meia hora antes sobre esta reunião que será uma apresentação para um cliente";
    const args = buildCreateAppointmentArgs(said, TZ);
    expect(args?.title).toBe("Apresentação para um cliente");
    expect(args?.reminder_before_minutes).toBe(30);
    expect(args?.title.toLowerCase()).not.toMatch(/avisar|meia hora/);
  });

  it("não confunde listagem com criação", () => {
    expect(looksLikeAppointmentCreate("quais meus compromissos de hoje?")).toBe(
      false
    );
  });

  it("frases do print gravam compromisso e não mudam de mundo", () => {
    const ligar =
      "Ligar 17h00 para Locadora MOve GO para falar com Adan";
    const bistek =
      "18h00 verificar o aplicativo do Bistek, principalmente para recolher carrinhos e criar rotas pelo aplicativo";
    const rotas =
      "Anotar compromisso para as 18h00 Verificar aplicativo do Bistek para gerar rotas";
    const adam =
      "Anotar compromisso 15h30 ligar para o senhor Adam da movie Go";

    for (const said of [ligar, bistek, rotas, adam]) {
      expect(looksLikeAppointmentCreate(said)).toBe(true);
    }

    expect(buildCreateAppointmentArgs(ligar, TZ)?.title.toLowerCase()).toMatch(
      /move go/
    );
    expect(buildCreateAppointmentArgs(ligar, TZ)?.title.toLowerCase()).toMatch(
      /adan/
    );
    expect(buildCreateAppointmentArgs(adam, TZ)?.title.toLowerCase()).toMatch(
      /adam/
    );
    expect(buildCreateAppointmentArgs(adam, TZ)?.title.toLowerCase()).not.toMatch(
      /locacar/
    );
    expect(buildCreateAppointmentArgs(bistek, TZ)?.title.toLowerCase()).toMatch(
      /bistek/
    );
    expect(buildCreateAppointmentArgs(rotas, TZ)?.title.toLowerCase()).toMatch(
      /bistek/
    );

    for (const said of [ligar, bistek, rotas, adam]) {
      expect(isPersonalLifeCommand(said)).toBe(true);
      expect(isBusinessWorldCommand(said)).toBe(false);
      expect(looksLikeDayList(said)).toBe(false);
      expect(looksLikeRouteIntent(said)).toBe(false);
    }
  });

  it("marcar Mauricio da Livre Via grava, não lista horário livre", () => {
    const mauricio =
      "Agendar amanhã às 09:30 Falar com Mauricio da livre via";
    const adan =
      "Marcar amanhã falar com Adan da MOVEGO sobre o zernio às 09:35";
    expect(classifyTurnAct(mauricio)).toBe("registrar_pessoal");
    expect(classifyTurnAct(adan)).toBe("registrar_pessoal");
    expect(looksLikeAppointmentCreate(mauricio)).toBe(true);
    expect(looksLikeAppointmentCreate(adan)).toBe(true);
    expect(looksLikeFreeSlotAsk(mauricio)).toBe(false);
    expect(looksLikeDayList(mauricio)).toBe(false);
    expect(looksLikeRouteIntent(mauricio)).toBe(false);
    expect(buildCreateAppointmentArgs(mauricio, TZ)?.title.toLowerCase()).toMatch(
      /mauricio/
    );
    expect(buildCreateAppointmentArgs(adan, TZ)?.title.toLowerCase()).toMatch(
      /adan/
    );
    expect(buildCreateAppointmentArgs(adan, TZ)?.title.toLowerCase()).toMatch(
      /movego|zernio/
    );
    expect(looksLikeFreeSlotAsk("Sexta de manhã livre?")).toBe(true);
    expect(looksLikeDayList("Agenda de amanhã")).toBe(true);
  });

  it("lembrete não mostra a chave interna do compromisso", () => {
    const note = visibleReminderNote(
      "appointment:42b7c542-f114-453a-ada6-b1096f9f7316\nAjuste nos contratos",
      "Lembrete: Reunião com cliente LOCACAR"
    );
    expect(note).toBe("Ajuste nos contratos");
    expect(note).not.toMatch(/appointment:/);
  });
});
