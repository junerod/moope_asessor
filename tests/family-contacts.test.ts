import { describe, expect, it } from "vitest";
import { parseZernioWebhook } from "@/channels/zernio/parse";
import {
  looksLikeFamilyIntent,
  looksLikeContactGroupIntent,
  parseChangeContactPhone,
  parseContactGroupCommand,
  parseAlsoNotifyNames,
  parseAlsoNotifyGroups,
  parseFamilySave,
  findContactByName,
  findContactByNameOrPhone,
} from "@/domain/family-contacts";
import {
  DEV_MASTER_PHONE,
  getDevMasterPhoneVariants,
  isDevMasterPhone,
} from "@/domain/dev-notifications";
import { parseTeamReminderSelection } from "@/domain/team-reminders";
import { toGoogleCalendarRecurrence } from "@/lib/recurrence";

describe("family contact parse (Zernio metadata)", () => {
  it("extrai telefone de metadata.contacts", () => {
    const n = parseZernioWebhook({
      id: "evt1",
      event: "message.received",
      message: {
        id: "m1",
        text: "👤 Daiana Filha",
        attachments: [],
      },
      metadata: {
        contacts: [
          {
            name: { formatted_name: "Daiana Filha" },
            phones: [
              { phone: "+55 48 99149-4156", wa_id: "554891494156", type: "CELL" },
            ],
          },
        ],
      },
    });
    expect(n?.contentType).toBe("contacts");
    expect(n?.sharedContacts?.[0]?.phoneE164).toMatch(/554891494156/);
    expect(n?.sharedContacts?.[0]?.name).toMatch(/Daiana/i);
  });
});

describe("family-contacts NL", () => {
  it("detecta intenção ampla", () => {
    expect(looksLikeFamilyIntent("família")).toBe(true);
    expect(looksLikeFamilyIntent("Adicionar Daiana família")).toBe(true);
    expect(looksLikeFamilyIntent("Modo família")).toBe(true);
    expect(looksLikeFamilyIntent("troca o telefone do José")).toBe(true);
    expect(parseChangeContactPhone("troca o telefone do José")).toEqual({
      name: "José",
      phone: null,
    });
    expect(
      parseChangeContactPhone("o telefone do José é 61 99999-0000")
    ).toEqual({ name: "José", phone: "61 99999-0000" });
    expect(parseChangeContactPhone("cobrar o José agora")).toBeNull();
  });

  it("parseia adicionar Nome família", () => {
    const a = parseFamilySave("Adicionar Daiana família");
    expect(a?.name).toBe("Daiana");
    expect(a && "phone" in a ? a.phone : null).toBeNull();
  });

  it("parseia com número", () => {
    const a = parseFamilySave("família Ju 61 99999-0000");
    expect(a?.name).toBe("Ju");
    expect(a && "phone" in a && a.phone).toBeTruthy();
  });

  it("avisa também", () => {
    expect(
      parseAlsoNotifyNames("me lembra às 18h — avisa a Daiana também")
    ).toContain("Daiana");
  });

  it("acha contato", () => {
    const c = findContactByName(
      [{ name: "Daiana", phoneE164: "+5548991494156" }],
      "Daiana"
    );
    expect(c?.name).toBe("Daiana");
  });

  it("interpreta comandos para manter grupos de contatos", () => {
    expect(parseContactGroupCommand("criar grupo Trabalho")).toEqual({
      action: "create",
      groupName: "Trabalho",
    });
    expect(parseContactGroupCommand("criar um grupo CRM")).toEqual({
      action: "create",
      groupName: "CRM",
    });
    expect(parseContactGroupCommand("Adicionar Tatiana grupo CRM")).toEqual({
      action: "add",
      contactName: "Tatiana",
      groupName: "CRM",
    });
    expect(
      parseContactGroupCommand("adicionar Daiana ao grupo Trabalho")
    ).toEqual({
      action: "add",
      contactName: "Daiana",
      groupName: "Trabalho",
    });
    expect(parseContactGroupCommand("convidar Daiana para lembretes")).toEqual({
      action: "invite",
      contactName: "Daiana",
    });
    expect(
      parseContactGroupCommand("revogar autorização de Daiana")
    ).toEqual({
      action: "revokeConsent",
      contactName: "Daiana",
    });
    expect(looksLikeContactGroupIntent("grupos")).toBe(true);
    expect(looksLikeContactGroupIntent("Adicionar Tatiana grupo CRM")).toBe(true);
    expect(looksLikeContactGroupIntent("avisa grupo Trabalho também")).toBe(
      false
    );
  });

  it("separa nome de contato e grupo no pedido de aviso", () => {
    expect(parseAlsoNotifyNames("me lembra às 18h — avisa grupo Trabalho também"))
      .toEqual([]);
    expect(parseAlsoNotifyGroups("me lembra às 18h — avisa o grupo Trabalho também"))
      .toEqual(["Trabalho"]);
  });

  it("identifica uma pessoa citada pela lista de trabalho", () => {
    const request = "reunião amanhã às 17h; avisa a Tatiana da minha lista de trabalho";
    expect(parseAlsoNotifyNames(request)).toEqual(["Tatiana"]);
    expect(parseAlsoNotifyGroups(request)).toEqual(["trabalho"]);
    expect(parseAlsoNotifyGroups("avisa o grupo Trabalho e me avisa 10 minutos antes"))
      .toEqual(["Trabalho"]);
  });

  it("seleciona membros por número, múltiplos números ou todos", () => {
    expect(parseTeamReminderSelection("1", 4)).toEqual([1]);
    expect(parseTeamReminderSelection("1, 3", 4)).toEqual([1, 3]);
    expect(parseTeamReminderSelection("todos", 4)).toBe("all");
    expect(parseTeamReminderSelection("5", 4)).toBeNull();
    expect(parseTeamReminderSelection("Ana", 4)).toBeNull();
  });

  it("converte recorrências compatíveis para RRULE do Google", () => {
    const start = new Date("2026-09-28T17:00:00-03:00");
    expect(toGoogleCalendarRecurrence("daily@17:00", start)).toEqual([
      "RRULE:FREQ=DAILY",
    ]);
    expect(toGoogleCalendarRecurrence("weekly:1@17:00", start)).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
    ]);
    expect(toGoogleCalendarRecurrence("monthly", start)).toEqual([
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=28",
    ]);
    expect(toGoogleCalendarRecurrence(null, start)).toBeUndefined();
  });

  it("resolve contato por nome acompanhado do telefone internacional", () => {
    const contacts = [
      { name: "Tatiana 42DEV Ayres", phoneE164: "+5531984246434" },
    ];
    expect(
      findContactByNameOrPhone(
        contacts,
        "Tatiana +5531984246434"
      )?.name
    ).toBe("Tatiana 42DEV Ayres");
  });
});

describe("DEV notification recipient", () => {
  it("accepts only the DEV master phone variants", () => {
    expect(DEV_MASTER_PHONE).toBe("+5561996715985");
    expect(getDevMasterPhoneVariants()).toContain("+5561996715985");
    expect(isDevMasterPhone("+55 (61) 99671-5985")).toBe(true);
    expect(isDevMasterPhone("+55 (61) 98888-0000")).toBe(false);
  });
});
