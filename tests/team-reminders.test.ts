import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, truncateAll } from "./helpers/db";
import { registerUser } from "@/lib/auth";
import { handleTeamReminderConsentMessage } from "@/domain/team-reminders";
import { appointments, platformSettings, reminders, users, whatsappIdentities, whatsappTemplates } from "@/db/schema";
import type { Db } from "@/db/client";
import type postgres from "postgres";
import { getTool } from "@/agent/tools/registry";
import "@/agent/tools/appointments";
import { upsertUnknownIdentity } from "@/domain/whatsapp-identities";
import {
  handleContactGroupTurn,
  handleSharedContacts,
  isPendingGroupContactPhone,
  listContactGroups,
  listFamilyContacts,
} from "@/domain/family-contacts";
import { resetEnvCache } from "@/config/env";
import {
  cancelUnauthorizedTeamReminder,
  handleTeamAppointmentResponse,
  handlePendingTeamReminderTurn,
  queueTeamReminderSelection,
  rescheduleAppointmentTeamDeliveries,
  tryDeliverTeamReminderExternal,
} from "@/domain/team-reminders";

describe("team reminder consent", () => {
  let db: Db;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(sql);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetEnvCache();
  });

  it("requires the invited recipient, consumes the token once, and honors opt-out", async () => {
    const owner = await registerUser(db, {
      email: "team-owner@example.com",
      name: "Team Owner",
      password: "password123",
    });
    const phoneE164 = "+5561996715985";
    const token = "one-time-team-consent-token-123456";
    const key = `invite_${createHash("sha256").update(token).digest("hex")}`;

    await db
      .update(users)
      .set({
        profileJson: {
          family_contacts: [
            { name: "Ana", phoneE164, reminderConsent: null },
          ],
        },
      })
      .where(eq(users.id, owner.user.id));
    await db.insert(platformSettings).values({
      namespace: "team_reminders",
      key,
      updatedByUserId: owner.user.id,
      valueJson: {
        kind: "reminder_consent_invite",
        ownerUserId: owner.user.id,
        contactPhone: phoneE164,
        contactName: "Ana",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const wrongPhone = await handleTeamReminderConsentMessage(db, {
      phoneE164: "+5561990000000",
      text: `AUTORIZO LEMBRETES ${token}`,
    });
    expect(wrongPhone).toMatch(/outro número/i);

    const accepted = await handleTeamReminderConsentMessage(db, {
      phoneE164,
      text: `AUTORIZO LEMBRETES ${token}`,
    });
    expect(accepted).toMatch(/autorização registrada/i);
    const ownerAfterAccept = await db.query.users.findFirst({
      where: eq(users.id, owner.user.id),
    });
    const contacts = (ownerAfterAccept?.profileJson as Record<string, unknown>)
      .family_contacts as Array<Record<string, unknown>>;
    expect(contacts[0].reminderConsent).toMatchObject({
      status: "opted_in",
      source: "whatsapp_invite",
    });
    expect(
      await db.query.platformSettings.findFirst({
        where: and(
          eq(platformSettings.namespace, "team_reminders"),
          eq(platformSettings.key, key)
        ),
      })
    ).toBeUndefined();

    const reused = await handleTeamReminderConsentMessage(db, {
      phoneE164,
      text: `AUTORIZO LEMBRETES ${token}`,
    });
    expect(reused).toMatch(/não é válido/i);

    const [pendingReminder] = await db
      .insert(reminders)
      .values({
        workspaceId: owner.workspace.id,
        userId: owner.user.id,
        title: "Equipe Trabalho: reunião",
        fireAt: new Date(Date.now() + 60 * 60 * 1000),
        timezone: "America/Sao_Paulo",
        payload: {
          team_external_oneshot: true,
          team_owner_user_id: owner.user.id,
          team_group: "Trabalho",
          target_phone: phoneE164,
        },
      })
      .returning();

    const optedOut = await handleTeamReminderConsentMessage(db, {
      phoneE164,
      text: "SAIR LEMBRETES",
    });
    expect(optedOut).toMatch(/não enviaremos novos lembretes/i);
    const ownerAfterOptOut = await db.query.users.findFirst({
      where: eq(users.id, owner.user.id),
    });
    const optedOutContacts = (ownerAfterOptOut?.profileJson as Record<string, unknown>)
      .family_contacts as Array<Record<string, unknown>>;
    expect(optedOutContacts[0].reminderConsent).toMatchObject({
      status: "opted_out",
      source: "recipient_opt_out",
    });
    const cancelledReminder = await db.query.reminders.findFirst({
      where: eq(reminders.id, pendingReminder.id),
    });
    expect(cancelledReminder?.status).toBe("cancelled");
  });

  it("shows the numbered team selection and schedules only opted-in members", async () => {
    const owner = await registerUser(db, {
      email: "team-selection@example.com",
      name: "Team Owner",
      password: "password123",
    });
    const approvedAt = new Date().toISOString();
    const anaPhone = "+5561996715985";
    const biaPhone = "+5561990000000";
    await db
      .update(users)
      .set({
        profileJson: {
          family_contacts: [
            {
              name: "Ana",
              phoneE164: anaPhone,
              reminderConsent: {
                status: "opted_in",
                at: approvedAt,
                source: "whatsapp_invite",
              },
            },
            {
              name: "Bia",
              phoneE164: biaPhone,
              reminderConsent: {
                status: "opted_out",
                at: approvedAt,
                source: "recipient_opt_out",
              },
            },
          ],
          contact_groups: [
            { name: "Trabalho", memberPhones: [anaPhone, biaPhone] },
          ],
        },
      })
      .where(eq(users.id, owner.user.id));

    const fireAt = new Date(Date.now() + 60 * 60 * 1000);
    const queued = await queueTeamReminderSelection(db, {
      ownerUserId: owner.user.id,
      ownerDisplayName: "Team Owner",
      userText: "me lembra da reunião às 15h e avisa grupo Trabalho também",
      title: "Reunião da equipe",
      fireAt,
      timezone: "America/Sao_Paulo",
    });
    expect(queued.queued).toBe(true);
    expect(queued.note).toContain("1. *Ana*");
    expect(queued.note).toContain("2. *Bia*");
    expect(queued.note).toContain("não autorizou receber avisos");

    const selection = await handlePendingTeamReminderTurn(db, {
      userId: owner.user.id,
      workspaceId: owner.workspace.id,
      text: "todos",
    });
    expect(selection).toContain("*Ana*");
    expect(selection).toContain("Bia (não autorizou receber avisos)");

    const confirmation = await handlePendingTeamReminderTurn(db, {
      userId: owner.user.id,
      workspaceId: owner.workspace.id,
      text: "confirmar",
    });
    expect(confirmation).toContain("Ana aviso agendado");
    const scheduled = await db.query.reminders.findMany();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      requiresTemplate: true,
      templateName: "assessor_reminder",
    });
    expect(scheduled[0].payload).toMatchObject({
      team_external_oneshot: true,
      target_phone: anaPhone,
      team_group: "Trabalho",
    });
  });

  it("cancels member and external deliveries after opt-out before fire time", async () => {
    const owner = await registerUser(db, {
      email: "team-revocation@example.com",
      name: "Team Owner",
      password: "password123",
    });
    const phoneE164 = "+5561996715985";
    await db
      .update(users)
      .set({
        profileJson: {
          family_contacts: [
            {
              name: "Ana",
              phoneE164,
              reminderConsent: {
                status: "opted_out",
                at: new Date().toISOString(),
                source: "recipient_opt_out",
              },
            },
          ],
          contact_groups: [{ name: "Trabalho", memberPhones: [phoneE164] }],
        },
      })
      .where(eq(users.id, owner.user.id));
    const fireAt = new Date(Date.now() + 1000);
    const [row] = await db
      .insert(reminders)
      .values({
        workspaceId: owner.workspace.id,
        userId: owner.user.id,
        title: "Equipe Trabalho: reunião",
        fireAt,
        timezone: "America/Sao_Paulo",
        payload: {
          team_reminder: true,
          team_group: "Trabalho",
          target_phone: phoneE164,
          shared_from: { user_id: owner.user.id, name: "Team Owner" },
        },
      })
      .returning();

    const internalCancelled = await cancelUnauthorizedTeamReminder(db, {
      id: row.id,
      fireAt: row.fireAt,
      payload: row.payload as Record<string, unknown>,
    });
    expect(internalCancelled).toBe(true);
    const cancelledReminder = await db.query.reminders.findFirst({
      where: eq(reminders.id, row.id),
    });
    expect(cancelledReminder?.status).toBe("cancelled");

    const external = await tryDeliverTeamReminderExternal(db, {
      id: "external-reminder",
      fireAt,
      timezone: "America/Sao_Paulo",
      payload: {
        team_external_oneshot: true,
        team_owner_user_id: owner.user.id,
        team_group: "Trabalho",
        target_phone: phoneE164,
        target_name: "Ana",
      },
    });
    expect(external).toMatchObject({
      handled: true,
      ok: false,
      errorCode: "team_recipient_not_authorized",
    });
  });

  it("opens a confirmed invite selection for individually named attendees", async () => {
    const owner = await registerUser(db, {
      email: "individual-invite-owner@example.com",
      name: "Organizer",
      password: "password123",
    });
    const phoneE164 = "+5561991234567";
    await db
      .update(users)
      .set({
        profileJson: {
          family_contacts: [{
            name: "Ana",
            phoneE164,
            reminderConsent: {
              status: "opted_in",
              at: new Date().toISOString(),
              source: "whatsapp_invite",
            },
          }],
        },
      })
      .where(eq(users.id, owner.user.id));

    const queued = await queueTeamReminderSelection(db, {
      ownerUserId: owner.user.id,
      ownerDisplayName: "Organizer",
      userText: "agende um Meet amanhã às 15h",
      alsoNotifyNames: ["Ana"],
      title: "Planejamento do trimestre",
      fireAt: new Date(Date.now() + 60 * 60 * 1000),
      timezone: "America/Sao_Paulo",
      payload: {
        meet_url: "https://meet.google.com/abc-defg-hij",
        meet_required: true,
        note: "https://example.com/planejamento",
      },
    });

    expect(queued.queued).toBe(true);
    expect(queued.note).toContain("📨 *CONVITE EM REVISÃO*");
    expect(queued.note).toContain("👥 *Equipe:* Convidados");
    expect(queued.note).toContain("🎥 *Google Meet:*");
    expect(queued.note).toContain("📎 *Material:");
    expect(queued.note).toContain("1. *Ana*");
    expect(queued.note).toContain("Nada será enviado até você confirmar");
    expect(await db.query.reminders.findMany()).toHaveLength(0);
  });

  it("keeps a missing work contact out of family and links the matching card to the requested group", async () => {
    const owner = await registerUser(db, {
      email: "work-group-contact-owner@example.com",
      name: "Organizer",
      password: "password123",
    });
    await db
      .update(users)
      .set({
        profileJson: {
          family_awaiting_contact: true,
          family_pending_name: "Old Family Name",
        },
      })
      .where(eq(users.id, owner.user.id));

    const created = await handleContactGroupTurn(db, {
      userId: owner.user.id,
      text: "criar grupo de trabalho CRM",
    });
    expect(created).toContain("grupo *CRM*");
    const requested = await handleContactGroupTurn(db, {
      userId: owner.user.id,
      text: "adicionar Tatiana ao grupo CRM",
    });
    expect(requested).toContain("Envie o cartão do WhatsApp");
    expect(requested).toContain("ninguém será colocado na lista Família");
    expect(await isPendingGroupContactPhone(db, owner.user.id, "+5561997654321")).toBe(true);

    const wrongCard = await handleSharedContacts(db, {
      userId: owner.user.id,
      contacts: [{ name: "Bianca", phoneE164: "+5561991000001" }],
    });
    expect(wrongCard).toContain("não parece ser de *Tatiana*");
    expect(await listFamilyContacts(db, owner.user.id)).toHaveLength(0);

    const matchingCard = await handleSharedContacts(db, {
      userId: owner.user.id,
      contacts: [{ name: "Tatiana Silva", phoneE164: "+5561991234567" }],
    });
    expect(matchingCard).toContain("grupo de trabalho *CRM*");
    expect(matchingCard).toContain("+5561991234567");
    expect(matchingCard).toContain("Ainda não enviei convite nem mensagem");
    expect(await listContactGroups(db, owner.user.id)).toEqual([
      { name: "CRM", memberPhones: ["+5561991234567"] },
    ]);
    expect((await listFamilyContacts(db, owner.user.id))[0].name).toBe("Tatiana Silva");

    await handleContactGroupTurn(db, {
      userId: owner.user.id,
      text: "criar grupo Trabalho",
    });
    const groups = await handleContactGroupTurn(db, {
      userId: owner.user.id,
      text: "grupos",
    });
    expect(groups).toContain("1. *CRM*");
    expect(groups).toContain("2. *Trabalho*");
    const details = await handleContactGroupTurn(db, {
      userId: owner.user.id,
      text: "grupo 1",
    });
    expect(details).toContain("Tatiana Silva");
    expect(details).toContain("+5561991234567");

    const byNumber = await handleContactGroupTurn(db, {
      userId: owner.user.id,
      text: "adicionar Tatiana ao grupo 2",
    });
    expect(byNumber).toContain("grupo de trabalho *Trabalho*");

    await handleContactGroupTurn(db, {
      userId: owner.user.id,
      text: "adicionar Bianca +5561991000002 ao grupo Trabalho",
    });
    const namedFromWorkList = await queueTeamReminderSelection(db, {
      ownerUserId: owner.user.id,
      ownerDisplayName: "Organizer",
      userText: "agende uma reunião e avisa a Tatiana da minha lista de trabalho",
      alsoNotifyNames: ["Tatiana"],
      onlyNamedGroupMembers: true,
      title: "Reunião com Tatiana",
      fireAt: new Date(Date.now() + 60 * 60 * 1000),
      timezone: "America/Sao_Paulo",
    });
    expect(namedFromWorkList.note).toContain("*Equipe:* Trabalho");
    expect(namedFromWorkList.note).toContain("Tatiana Silva");
    expect(namedFromWorkList.note).not.toContain("Bianca");

    const numericRequest = await handleContactGroupTurn(db, {
      userId: owner.user.id,
      text: "adicionar Camila ao grupo CRM",
    });
    expect(numericRequest).toContain("Vou incluir Camila");
    const numberReply = await handleContactGroupTurn(db, {
      userId: owner.user.id,
      text: "+5561997654321",
    });
    expect(numberReply).toContain("*Camila* vinculada ao grupo de trabalho *CRM*");
    expect(numberReply).toContain("+5561997654321");
    expect(await isPendingGroupContactPhone(db, owner.user.id, "+5561997654321")).toBe(false);
  });

  it("lets one invited MOOPE member cancel only their own recurring participation", async () => {
    const owner = await registerUser(db, {
      email: "series-owner@example.com",
      name: "Organizer",
      password: "password123",
    });
    const member = await registerUser(db, {
      email: "series-member@example.com",
      name: "Member",
      password: "password123",
    });
    const other = await registerUser(db, {
      email: "series-other@example.com",
      name: "Other",
      password: "password123",
    });
    const memberPhone = "+5561991111111";
    const otherPhone = "+5561992222222";
    const appointmentId = "d5910ca7-234e-4793-9acf-99798019bb3a";
    await db
      .update(users)
      .set({
        profileJson: {
          family_contacts: [
            { name: "Member", phoneE164: memberPhone, reminderConsent: { status: "opted_in", at: new Date().toISOString(), source: "whatsapp_invite" } },
            { name: "Other", phoneE164: otherPhone, reminderConsent: { status: "opted_in", at: new Date().toISOString(), source: "whatsapp_invite" } },
          ],
          contact_groups: [{ name: "Trabalho", memberPhones: [memberPhone, otherPhone] }],
        },
      })
      .where(eq(users.id, owner.user.id));
    const fireAt = new Date(Date.now() + 60 * 60 * 1000);
    const [memberReminder] = await db
      .insert(reminders)
      .values({
        workspaceId: member.workspace.id,
        userId: member.user.id,
        title: "Equipe Trabalho: apresentação",
        fireAt,
        timezone: "America/Sao_Paulo",
        recurrenceRule: "weekly:1@17:00",
        payload: {
          team_reminder: true,
          team_group: "Trabalho",
          team_owner_user_id: owner.user.id,
          target_phone: memberPhone,
          appointment_id: appointmentId,
          shared_from: { user_id: owner.user.id, name: "Organizer" },
        },
      })
      .returning();
    const [otherReminder] = await db
      .insert(reminders)
      .values({
        workspaceId: other.workspace.id,
        userId: other.user.id,
        title: "Equipe Trabalho: apresentação",
        fireAt,
        timezone: "America/Sao_Paulo",
        recurrenceRule: "weekly:1@17:00",
        payload: {
          team_reminder: true,
          team_group: "Trabalho",
          team_owner_user_id: owner.user.id,
          target_phone: otherPhone,
          appointment_id: appointmentId,
          shared_from: { user_id: owner.user.id, name: "Organizer" },
        },
      })
      .returning();

    const ownerReply = await handleTeamAppointmentResponse(db, {
      phoneE164: memberPhone,
      userId: owner.user.id,
      text: "cancelar reunião",
    });
    expect(ownerReply).toBeNull();

    const memberReply = await handleTeamAppointmentResponse(db, {
      phoneE164: memberPhone,
      userId: member.user.id,
      text: "cancelar minha reunião",
    });
    expect(memberReply).toContain("O compromisso continua para os demais convidados");
    const memberAfter = await db.query.reminders.findFirst({
      where: eq(reminders.id, memberReminder.id),
    });
    const otherAfter = await db.query.reminders.findFirst({
      where: eq(reminders.id, otherReminder.id),
    });
    expect(memberAfter?.status).toBe("cancelled");
    expect(memberAfter?.recurrenceRule).toBeNull();
    expect(otherAfter?.status).toBe("scheduled");
    expect(otherAfter?.recurrenceRule).toBe("weekly:1@17:00");
  });

  it("creates a Meet-linked recurring team appointment and a member mirror", async () => {
    const owner = await registerUser(db, {
      email: "meet-organizer@example.com",
      name: "Organizer",
      password: "password123",
    });
    const member = await registerUser(db, {
      email: "meet-member@example.com",
      name: "Member",
      password: "password123",
    });
    const phoneE164 = "+5561993333333";
    const identity = await upsertUnknownIdentity(db, { phoneE164 });
    await db
      .update(whatsappIdentities)
      .set({
        userId: member.user.id,
        status: "paired",
        pairedAt: new Date(),
      })
      .where(eq(whatsappIdentities.id, identity.id));
    await db
      .update(users)
      .set({
        profileJson: {
          family_contacts: [
            {
              name: "Member",
              phoneE164,
              reminderConsent: {
                status: "opted_in",
                at: new Date().toISOString(),
                source: "whatsapp_invite",
              },
            },
          ],
          contact_groups: [{ name: "Trabalho", memberPhones: [phoneE164] }],
        },
      })
      .where(eq(users.id, owner.user.id));

    const createAppointment = getTool("create_appointment");
    expect(createAppointment).toBeDefined();
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await createAppointment!.handler(
      {
        db,
        userId: owner.user.id,
        workspaceId: owner.workspace.id,
        conversationId: "00000000-0000-4000-8000-000000000001",
        agentRunId: "00000000-0000-4000-8000-000000000002",
        timezone: "America/Sao_Paulo",
        userText: "avisa o grupo Trabalho também e me avisa 10 min antes",
      },
      {
        title: "Apresentação de produto",
        starts_at_iso: start.toISOString(),
        timezone: "America/Sao_Paulo",
        meet_url: "https://meet.google.com/abc-defg-hij",
        recurrence_rule: "weekly:1@17:00",
        reminder_before_minutes: 10,
      }
    );
    expect(result.summary).toContain("https://meet.google.com/abc-defg-hij");
    expect(result.summary).toContain("*Equipe:* Trabalho");
    expect(result.summary).toContain("10 minutos antes");
    expect(result.summary).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
    const ownerReminder = await db.query.reminders.findFirst({
      where: eq(reminders.userId, owner.user.id),
    });
    expect(ownerReminder?.fireAt.getTime()).toBe(start.getTime() - 10 * 60_000);
    expect(ownerReminder?.payload).toMatchObject({ reminder_before_minutes: 10 });

    const selected = await handlePendingTeamReminderTurn(db, {
      userId: owner.user.id,
      workspaceId: owner.workspace.id,
      text: "1",
    });
    expect(selected).toContain("*Member*");
    expect(selected).toContain("📞 ");
    await handlePendingTeamReminderTurn(db, {
      userId: owner.user.id,
      workspaceId: owner.workspace.id,
      text: "confirmar",
    });

    const mirror = await db.query.appointments.findFirst({
      where: eq(appointments.workspaceId, member.workspace.id),
    });
    expect(mirror).toMatchObject({
      title: "Trabalho: Apresentação de produto",
      status: "scheduled",
    });
    expect(mirror?.metadata).toMatchObject({
      team_event: true,
      team_group: "Trabalho",
      meet_url: "https://meet.google.com/abc-defg-hij",
      recurrence_rule: "weekly:1@17:00",
    });
    const memberReminder = await db.query.reminders.findFirst({
      where: eq(reminders.workspaceId, member.workspace.id),
    });
    expect(memberReminder).toMatchObject({
      recurrenceRule: "weekly:1@17:00",
      payload: {
        team_reminder: true,
        target_phone: phoneE164,
        member_appointment_id: mirror?.id,
        meet_url: "https://meet.google.com/abc-defg-hij",
      },
    });
    expect(String((memberReminder?.payload as Record<string, unknown>)?.note)).toContain(
      `appointment:${mirror?.id}`
    );
  });

  it("rejects a past meeting without exposing internal identifiers", async () => {
    const owner = await registerUser(db, {
      email: "past-meet-owner@example.com",
      name: "Organizer",
      password: "password123",
    });
    const createAppointment = getTool("create_appointment");
    const result = await createAppointment!.handler(
      {
        db,
        userId: owner.user.id,
        workspaceId: owner.workspace.id,
        conversationId: "00000000-0000-4000-8000-000000000001",
        agentRunId: "00000000-0000-4000-8000-000000000002",
        timezone: "America/Sao_Paulo",
        userText: "crie uma reunião com Meet",
      },
      {
        title: "Reunião antiga",
        starts_at_iso: new Date(Date.now() - 60_000).toISOString(),
        create_meet: true,
      }
    );

    expect(result).toMatchObject({ ok: false, errorCode: "appointment_in_past" });
    expect(result.summary).toContain("Qual data e horário futuro");
    expect(result.summary).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
    expect(await db.query.appointments.findMany({
      where: eq(appointments.userId, owner.user.id),
    })).toHaveLength(0);
  });

  it("sends the meeting invite template to an opted-in lead, then schedules recurring reminders", async () => {
    const originalEnv = {
      ZERNIO_MOCK: process.env.ZERNIO_MOCK,
      ZERNIO_API_KEY: process.env.ZERNIO_API_KEY,
      ZERNIO_API_URL: process.env.ZERNIO_API_URL,
      ZERNIO_ACCOUNT_ID: process.env.ZERNIO_ACCOUNT_ID,
    };
    process.env.ZERNIO_MOCK = "false";
    process.env.ZERNIO_API_KEY = "test-zernio-key";
    process.env.ZERNIO_API_URL = "https://zernio.com/api/v1";
    process.env.ZERNIO_ACCOUNT_ID = "0123456789abcdef01234567";
    resetEnvCache();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        success: true,
        data: { conversationId: "lead-conversation", messageId: "invite-1" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const owner = await registerUser(db, {
        email: "external-meet-owner@example.com",
        name: "Organizer",
        password: "password123",
      });
      const phoneE164 = "+5561995555555";
      await db
        .update(users)
        .set({
          profileJson: {
            family_contacts: [{
              name: "Lead",
              phoneE164,
              reminderConsent: {
                status: "opted_in",
                at: new Date().toISOString(),
                source: "whatsapp_invite",
              },
            }],
            contact_groups: [{ name: "CRM", memberPhones: [phoneE164] }],
          },
        })
        .where(eq(users.id, owner.user.id));
      await db.insert(whatsappTemplates).values({
        logicalName: "reminder",
        providerTemplateName: "assessor_reminder",
        language: "pt_BR",
        status: "approved",
      });

      const meetingStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
      await queueTeamReminderSelection(db, {
        ownerUserId: owner.user.id,
        ownerDisplayName: "Organizer",
        userText: "avisa o grupo CRM também",
        title: "Demonstração do produto",
        fireAt: meetingStart,
        endsAt: new Date(meetingStart.getTime() + 60 * 60 * 1000),
        timezone: "America/Sao_Paulo",
        recurrenceRule: "weekly:1@17:00",
        payload: {
          appointment_id: "83b07b07-5672-40a7-a726-7c9e5e593004",
          meet_url: "https://meet.google.com/abc-defg-hij",
          meet_required: true,
          note: "Material: https://example.com/demo.pdf",
        },
      });
      await handlePendingTeamReminderTurn(db, {
        userId: owner.user.id,
        workspaceId: owner.workspace.id,
        text: "todos",
      });
      const result = await handlePendingTeamReminderTurn(db, {
        userId: owner.user.id,
        workspaceId: owner.workspace.id,
        text: "confirmar",
      });

      expect(result).toContain("Lead convite enviado; aviso agendado");
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://zernio.com/api/v1/inbox/conversations");
      const body = JSON.parse(String(request.body));
      expect(body).toMatchObject({
        participantId: "5561995555555",
        templateName: "assessor_reminder",
        templateLanguage: "pt_BR",
      });
      expect(body.templateParams[0]).toContain("https://meet.google.com/abc-defg-hij");
      expect(body.templateParams[0]).toContain("https://example.com/demo.pdf");
      expect(body.templateParams[0]).toContain("📨 *CONVITE PARA REUNIÃO*");
      expect(body.templateParams[0]).toContain("👥 *Equipe:* CRM");
      expect(body.templateParams[0]).toContain("⏱️ *Duração:*");
      expect(body.templateParams[0]).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
      const reminder = await db.query.reminders.findFirst();
      expect(reminder).toMatchObject({
        requiresTemplate: true,
        recurrenceRule: "weekly:1@17:00",
      });
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetEnvCache();
    }
  });

  it("sends a Utility template when rescheduling an external team attendee", async () => {
    const originalEnv = {
      ZERNIO_MOCK: process.env.ZERNIO_MOCK,
      ZERNIO_API_KEY: process.env.ZERNIO_API_KEY,
      ZERNIO_API_URL: process.env.ZERNIO_API_URL,
      ZERNIO_ACCOUNT_ID: process.env.ZERNIO_ACCOUNT_ID,
    };
    process.env.ZERNIO_MOCK = "false";
    process.env.ZERNIO_API_KEY = "test-zernio-key";
    process.env.ZERNIO_API_URL = "https://zernio.com/api/v1";
    process.env.ZERNIO_ACCOUNT_ID = "0123456789abcdef01234567";
    resetEnvCache();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        success: true,
        data: { conversationId: "lead-conversation", messageId: "update-1" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const owner = await registerUser(db, {
        email: "external-reschedule-owner@example.com",
        name: "Organizer",
        password: "password123",
      });
      const phoneE164 = "+5561996666666";
      await db
        .update(users)
        .set({
          profileJson: {
            family_contacts: [{
              name: "Lead",
              phoneE164,
              reminderConsent: {
                status: "opted_in",
                at: new Date().toISOString(),
                source: "whatsapp_invite",
              },
            }],
            contact_groups: [{ name: "CRM", memberPhones: [phoneE164] }],
          },
        })
        .where(eq(users.id, owner.user.id));
      await db.insert(whatsappTemplates).values({
        logicalName: "reminder",
        providerTemplateName: "assessor_reminder",
        language: "pt_BR",
        status: "approved",
      });
      const appointmentId = "8e9e433f-551a-4a22-a8b7-5e704968c499";
      const [reminder] = await db
        .insert(reminders)
        .values({
          workspaceId: owner.workspace.id,
          userId: owner.user.id,
          title: "[equipe→Lead] Demonstração",
          fireAt: new Date(Date.now() + 60 * 60 * 1000),
          timezone: "America/Sao_Paulo",
          recurrenceRule: "weekly:1@17:00",
          payload: {
            team_external_oneshot: true,
            team_owner_user_id: owner.user.id,
            team_group: "CRM",
            target_phone: phoneE164,
            target_name: "Lead",
            appointment_id: appointmentId,
          },
        })
        .returning();
      const newStart = new Date(Date.now() + 3 * 60 * 60 * 1000);

      const result = await rescheduleAppointmentTeamDeliveries(db, {
        appointmentId,
        title: "Demonstração atualizada",
        startsAt: newStart,
        recurrenceRule: "weekly:1@17:00",
        meetUrl: "https://meet.google.com/abc-defg-hij",
      });

      expect(result).toEqual({ updated: 1, externalNoticeFailed: [] });
      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
      expect(body).toMatchObject({
        participantId: "5561996666666",
        templateName: "assessor_reminder",
      });
      expect(body.templateParams[0]).toContain("ATUALIZADA: Demonstração atualizada");
      expect(body.templateParams[0]).toContain("Google Meet: https://meet.google.com/abc-defg-hij");
      const updatedReminder = await db.query.reminders.findFirst({
        where: eq(reminders.id, reminder.id),
      });
      expect(updatedReminder).toMatchObject({
        fireAt: newStart,
        recurrenceRule: "weekly:1@17:00",
        status: "scheduled",
      });

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "provider unavailable",
      });
      const retryStart = new Date(newStart.getTime() + 60 * 60 * 1000);
      const failedNotice = await rescheduleAppointmentTeamDeliveries(db, {
        appointmentId,
        title: "Demonstração remarcada novamente",
        startsAt: retryStart,
        recurrenceRule: "weekly:1@17:00",
        meetUrl: "https://meet.google.com/abc-defg-hij",
      });
      expect(failedNotice).toEqual({
        updated: 1,
        externalNoticeFailed: ["Lead"],
      });
      const stillScheduled = await db.query.reminders.findFirst({
        where: eq(reminders.id, reminder.id),
      });
      expect(stillScheduled).toMatchObject({
        fireAt: retryStart,
        recurrenceRule: "weekly:1@17:00",
        status: "scheduled",
      });
      expect(stillScheduled?.lastError).toMatch(/^team_update_notice_failed:/);
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetEnvCache();
    }
  });
});
