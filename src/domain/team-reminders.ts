import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { createWhatsAppTemplateConversation } from "@/channels/zernio/templates-api";
import {
  getCatalogByLogical,
  packSingleBodyParam,
} from "@/domain/whatsapp-templates-catalog";
import {
  findContactByName,
  listContactGroups,
  listFamilyContacts,
  resolveLinkedIds,
  type FamilyContact,
} from "@/domain/family-contacts";
import { resolveZernioRuntimeConfig, getTemplate } from "@/domain/providers";
import { ensureReminderOutbox, reminderOccurrenceKey } from "@/domain/alert-delivery";
import { getAssessorWhatsAppPublic } from "@/lib/assessor-whatsapp";
import {
  platformSettings,
  appointments,
  reminders,
  users,
  workspaces,
} from "@/db/schema";

const CONSENT_NAMESPACE = "team_reminders";
const PENDING_PROFILE_KEY = "team_reminder_pending";
const PENDING_TTL_MS = 20 * 60 * 1000;

type TeamMember = {
  name: string;
  phoneE164: string;
  requireGroupMembership: boolean;
  inviteLink?: string | null;
};

type TeamReminderDraft = {
  id: string;
  groupName: string;
  appointmentId?: string | null;
  ownerDisplayName: string;
  title: string;
  fireAt: string;
  endsAt?: string | null;
  timezone: string;
  recurrenceRule?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
  status: "selecting" | "confirming" | "sending";
  members: TeamMember[];
  selectedPhones: string[];
  results: Record<string, "scheduled" | "failed">;
};

type ReminderConsent = NonNullable<FamilyContact["reminderConsent"]>;

function phoneDigits(phone: string): string {
  return String(phone || "").replace(/\D/g, "");
}

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

async function readProfile(db: Db, userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return user
    ? { user, profile: { ...((user.profileJson || {}) as Record<string, unknown>) } }
    : null;
}

async function writeProfile(
  db: Db,
  userId: string,
  patch: (profile: Record<string, unknown>) => void
): Promise<void> {
  const current = await readProfile(db, userId);
  if (!current) return;
  patch(current.profile);
  await db
    .update(users)
    .set({ profileJson: current.profile, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

async function updateOwnerConsent(
  db: Db,
  ownerUserId: string,
  phoneE164: string,
  consent: ReminderConsent
): Promise<boolean> {
  const contacts = await listFamilyContacts(db, ownerUserId);
  const contact = contacts.find((item) => item.phoneE164 === phoneE164);
  if (!contact) return false;
  contact.reminderConsent = consent;
  await writeProfile(db, ownerUserId, (profile) => {
    profile.family_contacts = contacts;
  });
  return true;
}

async function getConsent(
  db: Db,
  ownerUserId: string,
  phoneE164: string
): Promise<ReminderConsent | null> {
  const contact = (await listFamilyContacts(db, ownerUserId)).find(
    (item) => item.phoneE164 === phoneE164
  );
  return contact?.reminderConsent || null;
}

export async function createReminderConsentInvite(
  db: Db,
  input: { ownerUserId: string; contactPhone: string; contactName: string }
): Promise<string> {
  const publicWhatsApp = await getAssessorWhatsAppPublic();
  if (!publicWhatsApp.waUrl) {
    throw new Error("assessor_whatsapp_not_configured");
  }
  const token = randomBytes(24).toString("base64url");
  const key = `invite_${createHash("sha256").update(token).digest("hex")}`;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.insert(platformSettings).values({
    namespace: CONSENT_NAMESPACE,
    key,
    updatedByUserId: input.ownerUserId,
    valueJson: {
      kind: "reminder_consent_invite",
      ownerUserId: input.ownerUserId,
      contactPhone: input.contactPhone,
      contactName: input.contactName,
      expiresAt,
    },
  });

  const url = new URL(publicWhatsApp.waUrl);
  url.searchParams.set("text", `AUTORIZO LEMBRETES ${token}`);
  return url.toString();
}

async function setConsentForEveryOwner(
  db: Db,
  phoneE164: string,
  consent: ReminderConsent
): Promise<number> {
  const allUsers = await db.query.users.findMany({
    columns: { id: true, profileJson: true },
  });
  let updated = 0;
  for (const user of allUsers) {
    const profile = { ...((user.profileJson || {}) as Record<string, unknown>) };
    const contacts = Array.isArray(profile.family_contacts)
      ? (profile.family_contacts as Array<Record<string, unknown>>)
      : [];
    let changed = false;
    const next = contacts.map((contact) => {
      if (String(contact.phoneE164 || "") !== phoneE164) return contact;
      changed = true;
      return { ...contact, reminderConsent: consent };
    });
    if (!changed) continue;
    profile.family_contacts = next;
    await db
      .update(users)
      .set({ profileJson: profile, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    updated += 1;
  }
  if (consent.status === "opted_out") {
    await cancelTeamRemindersForRecipient(db, phoneE164);
  }
  return updated;
}

export async function cancelTeamRemindersForRecipient(
  db: Db,
  phoneE164: string,
  ownerUserId?: string,
  groupName?: string
): Promise<void> {
  const digits = phoneDigits(phoneE164);
  const filters = [
    sql`regexp_replace(coalesce(${reminders.payload}->>'target_phone', ''), '\\D', '', 'g') = ${digits}`,
    sql`(${reminders.payload}->>'team_reminder' = 'true' OR ${reminders.payload}->>'team_external_oneshot' = 'true')`,
    sql`${reminders.status} IN ('scheduled', 'queued', 'failed')`,
    isNull(reminders.deletedAt),
  ];
  if (ownerUserId) {
    filters.push(sql`${reminders.payload}->>'team_owner_user_id' = ${ownerUserId}`);
  }
  if (groupName) {
    filters.push(sql`${reminders.payload}->>'team_group' = ${groupName}`);
  }
  const rows = await db.query.reminders.findMany({
    where: and(...filters),
  });
  for (const row of rows) {
    const payload = (row.payload || {}) as Record<string, unknown>;
    await db
      .update(reminders)
      .set({ status: "cancelled", recurrenceRule: null, lastError: "recipient_opted_out", updatedAt: new Date() })
      .where(eq(reminders.id, row.id));
    await db.execute(sql`
      UPDATE alert_outbox
      SET status = 'cancelled', locked_at = NULL, locked_by = NULL, updated_at = NOW()
      WHERE source_id = ${row.id}
        AND source_type = 'reminder'
        AND status IN ('pending', 'processing', 'failed')
        AND delivered_at IS NULL
    `);
    const memberAppointmentId = String(payload.member_appointment_id || "");
    if (memberAppointmentId) {
      await db
        .update(appointments)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(appointments.id, memberAppointmentId));
    }
    const googleEventId = String(payload.google_event_id || "");
    if (googleEventId) {
      const { deleteAppointmentFromGoogle } = await import(
        "@/integrations/google/auto-push"
      );
      await deleteAppointmentFromGoogle(db, {
        workspaceId: row.workspaceId,
        eventId: googleEventId,
      });
    }
  }
}

export async function handleTeamReminderConsentMessage(
  db: Db,
  input: { phoneE164: string; text: string }
): Promise<string | null> {
  const text = String(input.text || "").trim();
  const phoneE164 = `+${phoneDigits(input.phoneE164)}`;
  if (/^SAIR\s+LEMBRETES$/i.test(text)) {
    await setConsentForEveryOwner(db, phoneE164, {
      status: "opted_out",
      at: new Date().toISOString(),
      source: "recipient_opt_out",
    });
    return "Pronto. Não enviaremos novos lembretes de equipes para este número. Para voltar a receber, peça um novo convite.";
  }

  const match = text.match(/^AUTORIZO\s+LEMBRETES\s+([A-Za-z0-9_-]{24,80})$/i);
  if (!match) return null;
  const key = `invite_${createHash("sha256").update(match[1]).digest("hex")}`;
  const invite = await db.query.platformSettings.findFirst({
    where: and(
      eq(platformSettings.namespace, CONSENT_NAMESPACE),
      eq(platformSettings.key, key)
    ),
  });
  const value = (invite?.valueJson || {}) as Record<string, unknown>;
  if (!invite || value.kind !== "reminder_consent_invite") {
    return "Esse convite de lembretes não é válido. Peça ao responsável um novo link.";
  }
  if (String(value.expiresAt || "") <= new Date().toISOString()) {
    await db.delete(platformSettings).where(eq(platformSettings.id, invite.id));
    return "Esse convite expirou. Peça ao responsável um novo link.";
  }
  if (String(value.contactPhone || "") !== phoneE164) {
    return "Este convite foi emitido para outro número. Peça um link individual para este WhatsApp.";
  }

  const ownerUserId = String(value.ownerUserId || "");
  const updated = await updateOwnerConsent(db, ownerUserId, phoneE164, {
    status: "opted_in",
    at: new Date().toISOString(),
    source: "whatsapp_invite",
  });
  await db.delete(platformSettings).where(eq(platformSettings.id, invite.id));
  return updated
    ? "Autorização registrada. Você poderá receber lembretes de equipe individuais pelo MOOPE Assessor. Envie *SAIR LEMBRETES* para parar a qualquer momento."
    : "Não encontrei mais este contato na lista do responsável. Peça um convite atualizado.";
}

async function saveDraft(
  db: Db,
  userId: string,
  draft: TeamReminderDraft | null
): Promise<void> {
  await writeProfile(db, userId, (profile) => {
    if (draft) profile[PENDING_PROFILE_KEY] = draft;
    else delete profile[PENDING_PROFILE_KEY];
  });
}

async function loadDraft(db: Db, userId: string): Promise<TeamReminderDraft | null> {
  const current = await readProfile(db, userId);
  if (!current) return null;
  const raw = current.profile[PENDING_PROFILE_KEY] as TeamReminderDraft | undefined;
  if (!raw || !raw.id || !Array.isArray(raw.members)) return null;
  return raw;
}

function formatWhen(fireAt: string, timezone: string): string {
  const date = DateTime.fromISO(fireAt).setZone(timezone || "America/Sao_Paulo");
  return date.isValid ? date.toFormat("dd/LL · HH:mm") : fireAt;
}

function formatMeetingInvite(input: {
  title: string;
  groupName: string;
  fireAt: string;
  timezone: string;
  endsAt?: string | null;
  meetUrl?: string | null;
  note?: string | null;
  organizer?: string | null;
}): string {
  const startsAt = DateTime.fromISO(input.fireAt);
  const endsAt = input.endsAt ? DateTime.fromISO(input.endsAt) : null;
  const duration = endsAt?.isValid && startsAt.isValid
    ? Math.round(endsAt.diff(startsAt, "minutes").minutes)
    : 0;
  const meetUrl = String(input.meetUrl || "").trim();
  const note = String(input.note || "").trim();
  return [
    "📨 *CONVITE PARA REUNIÃO*",
    `📌 *${input.title}*`,
    `👥 *Equipe:* ${input.groupName}`,
    `🗓️ *Quando:* ${formatWhen(input.fireAt, input.timezone)}`,
    ...(duration > 0 ? [`⏱️ *Duração:* ${duration} min`] : []),
    ...(meetUrl ? ["🎥 *Google Meet:*", meetUrl] : []),
    ...(note && note !== meetUrl ? [`📎 *Material:* ${note}`] : []),
    ...(input.organizer ? [`👤 *Organizado por:* ${input.organizer}`] : []),
    "",
    "Para cancelar só sua participação, responda *cancelar minha reunião*.",
  ].join("\n");
}

async function noticeWithOwnerChat(
  db: Db,
  ownerUserId: string,
  ownerName: string,
  body: string,
  ownerPhone?: string | null
): Promise<string> {
  const { ownerPhoneE164, withOrganizerChat } = await import("@/domain/external-notice");
  const phone = ownerPhone || (await ownerPhoneE164(db, ownerUserId));
  return withOrganizerChat(body, ownerName, phone);
}

export async function queueTeamReminderSelection(
  db: Db,
  input: {
    ownerUserId: string;
    ownerDisplayName?: string | null;
    userText?: string | null;
    alsoNotifyNames?: string[] | null;
    onlyNamedGroupMembers?: boolean;
    title: string;
    fireAt: Date;
    endsAt?: Date | null;
    timezone: string;
    recurrenceRule?: string | null;
    payload?: Record<string, unknown> | null;
  }
): Promise<{ queued: boolean; note: string }> {
  const { parseAlsoNotifyGroups } = await import("@/domain/family-contacts");
  const requestedGroups = parseAlsoNotifyGroups(input.userText || "");
  const alsoNotifyNames = [...new Set(
    (input.alsoNotifyNames || []).map((name) => String(name).trim()).filter(Boolean)
  )];
  if (!requestedGroups.length && !alsoNotifyNames.length) {
    return { queued: false, note: "" };
  }

  const existingDraft = await loadDraft(db, input.ownerUserId);
  if (existingDraft && Date.parse(existingDraft.expiresAt) > Date.now()) {
    return {
      queued: true,
      note: `\n⏳ Você já tem uma seleção de equipe pendente para *${existingDraft.groupName}*. Responda com os números, *todos* ou *cancelar* antes de criar outra.`,
    };
  }

  if (
    input.payload?.meet_required === true &&
    !String(input.payload?.meet_url || "").trim()
  ) {
    return {
      queued: true,
      note: "\n⚠️ Não consegui criar o link do Meet. Conecte o Google ou envie um link HTTPS antes de convidar a equipe. O compromisso pessoal foi salvo; nenhum convite foi enviado.",
    };
  }
  const groups = await listContactGroups(db, input.ownerUserId);
  const requestedGroupName = requestedGroups[0] || null;
  const group = requestedGroupName
    ? /^\d+$/.test(requestedGroupName)
      ? groups[Number(requestedGroupName) - 1] || null
      : groups.find((item) => fold(item.name) === fold(requestedGroupName)) || null
    : null;
  if (requestedGroupName && !group) {
    return {
      queued: true,
      note: `\n❓ Não encontrei o grupo *${requestedGroupName}*. Digite *grupos* para conferir.`,
    };
  }
  const groupName = group?.name || "Convidados";

  const contacts = await listFamilyContacts(db, input.ownerUserId);
  const requestedNameKeys = alsoNotifyNames.map(fold);
  const explicitlyRequested = (contact: FamilyContact) =>
    requestedNameKeys.some((key) =>
      fold(contact.name) === key || fold(contact.name).startsWith(key)
    );
  const members: TeamMember[] = [];
  for (const phone of group?.memberPhones || []) {
    const contact = contacts.find((item) => item.phoneE164 === phone);
    if (
      contact &&
      (!input.onlyNamedGroupMembers || explicitlyRequested(contact))
    ) {
      members.push({ name: contact.name, phoneE164: contact.phoneE164, requireGroupMembership: true });
    }
  }
  if (!input.onlyNamedGroupMembers) {
    for (const name of alsoNotifyNames) {
      const key = fold(name);
      const matches = contacts.filter((contact) =>
        fold(contact.name) === key || fold(contact.name).startsWith(key)
      );
      for (const contact of matches) {
        if (!members.some((member) => member.phoneE164 === contact.phoneE164)) {
          members.push({ name: contact.name, phoneE164: contact.phoneE164, requireGroupMembership: false });
        }
      }
    }
  }
  if (!members.length) {
    return {
      queued: true,
      note: input.onlyNamedGroupMembers && alsoNotifyNames.length
        ? `\n❓ Não encontrei *${alsoNotifyNames.join(", ")}* no grupo de trabalho *${groupName}*. Ninguém foi avisado. Digite *grupo ${groupName}* para conferir quem está nele.`
        : alsoNotifyNames.length
          ? `\n❓ Não encontrei *${alsoNotifyNames.join(", ")}* nos contatos. Envie o cartão ou o telefone completo. Ninguém foi avisado.`
          : `\n👥 O grupo *${groupName}* ainda não tem contatos salvos.`,
    };
  }

  const now = new Date();
  const draft: TeamReminderDraft = {
    id: randomBytes(16).toString("hex"),
    groupName,
    appointmentId: typeof input.payload?.appointment_id === "string"
      ? input.payload.appointment_id
      : null,
    ownerDisplayName: String(input.ownerDisplayName || "alguém").trim().split(/\s+/)[0] || "alguém",
    title: input.title.slice(0, 500),
    fireAt: input.fireAt.toISOString(),
    endsAt: input.endsAt?.toISOString() || null,
    timezone: input.timezone || "America/Sao_Paulo",
    recurrenceRule: input.recurrenceRule || null,
    payload: input.payload || null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
    status: "selecting",
    members,
    selectedPhones: [],
    results: {},
  };

  for (const member of draft.members) {
    const contact = contacts.find((item) => item.phoneE164 === member.phoneE164);
    if (contact?.reminderConsent?.status !== "opted_in") {
      if (contact?.reminderConsent?.status !== "opted_out") {
        try {
          member.inviteLink = await createReminderConsentInvite(db, {
            ownerUserId: input.ownerUserId,
            contactPhone: member.phoneE164,
            contactName: member.name,
          });
        } catch {
          member.inviteLink = null;
        }
      }
    }
  }
  await saveDraft(db, input.ownerUserId, draft);
  return {
    queued: true,
    note: `\n\n${await formatSelection(db, input.ownerUserId, draft)}`,
  };
}

async function getMemberStatus(
  db: Db,
  userId: string,
  draft: TeamReminderDraft,
  member: TeamMember,
  index: number
): Promise<{
  index: number;
  name: string;
  phoneE164: string;
  eligible: boolean;
  targetKind: "assessor" | "external" | null;
  reason: string;
  inviteLink?: string | null;
}> {
  const contacts = await listFamilyContacts(db, userId);
  const contact = contacts.find((item) => item.phoneE164 === member.phoneE164);
  if (!contact) {
    return { index, name: member.name, phoneE164: member.phoneE164, eligible: false, targetKind: null, reason: "contato removido" };
  }
  if (member.requireGroupMembership) {
    const groups = await listContactGroups(db, userId);
    const group = groups.find((item) => fold(item.name) === fold(draft.groupName));
    if (!group?.memberPhones.includes(member.phoneE164)) {
      return { index, name: member.name, phoneE164: member.phoneE164, eligible: false, targetKind: null, reason: "fora do grupo" };
    }
  }
  if (contact.reminderConsent?.status === "opted_out") {
    return { index, name: member.name, phoneE164: member.phoneE164, eligible: false, targetKind: null, reason: "não autorizou receber avisos" };
  }
  if (contact.reminderConsent?.status !== "opted_in") {
    return { index, name: member.name, phoneE164: member.phoneE164, eligible: false, targetKind: null, reason: "aguardando autorização", inviteLink: member.inviteLink };
  }
  const linked = await resolveLinkedIds(db, member.phoneE164);
  if (linked.linkedUserId === userId) {
    return { index, name: contact.name, phoneE164: member.phoneE164, eligible: false, targetKind: null, reason: "organizador não entra como convidado" };
  }
  if (linked.linkedUserId && linked.linkedWorkspaceId) {
    return { index, name: contact.name, phoneE164: member.phoneE164, eligible: true, targetKind: "assessor", reason: "MOOPE Assessor" };
  }
  return { index, name: contact.name, phoneE164: member.phoneE164, eligible: true, targetKind: "external", reason: "mensagem aprovada do WhatsApp" };
}

async function formatSelection(
  db: Db,
  userId: string,
  draft: TeamReminderDraft
): Promise<string> {
  const lines = [
    "📨 *CONVITE EM REVISÃO*",
    `📌 *${draft.title}*`,
    `👥 *Equipe:* ${draft.groupName}`,
    `🗓️ *Quando:* ${formatWhen(draft.fireAt, draft.timezone)}`,
    ...(draft.endsAt
      ? [`⏱️ *Duração:* ${Math.round((Date.parse(draft.endsAt) - Date.parse(draft.fireAt)) / 60_000)} min`]
      : []),
    ...(draft.payload?.meet_url
      ? ["🎥 *Google Meet:*", String(draft.payload.meet_url)]
      : []),
    ...(draft.payload?.note
      ? [`📎 *Material:* ${String(draft.payload.note)}`]
      : []),
    "",
  ];
  const statuses = await Promise.all(
    draft.members.map((member, index) => getMemberStatus(db, userId, draft, member, index + 1))
  );
  for (const item of statuses) {
    lines.push(`${item.eligible ? "✅" : "⏳"} ${item.index}. *${item.name}* · ${item.reason}`);
    lines.push(`   📞 ${item.phoneE164}`);
    if (item.inviteLink) lines.push(`   🔐 Autorizar lembretes: ${item.inviteLink}`);
  }
  lines.push("", "Nada será enviado até você confirmar.", "_Responda com um número ou *todos* e depois *confirmar*. Digite *cancelar* para descartar._");
  return lines.join("\n");
}

export function parseTeamReminderSelection(
  text: string,
  memberCount: number
): number[] | "all" | null {
  const normalized = String(text || "").trim().toLowerCase();
  if (/^(?:todos|todas|todo o grupo|toda a equipe)$/.test(normalized)) return "all";
  const values = normalized.split(/[\s,;+]+/).filter(Boolean);
  if (!values.length || values.some((value) => !/^\d+$/.test(value))) return null;
  const indexes = [...new Set(values.map(Number))];
  if (indexes.some((index) => index < 1 || index > memberCount)) return null;
  return indexes;
}

async function syncMemberAppointmentCalendar(
  db: Db,
  input: {
    reminderId: string;
    workspaceId: string;
    draft: TeamReminderDraft;
    member: TeamMember;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  if (!input.draft.appointmentId) return;
  const { autoPushAppointmentToGoogle } = await import(
    "@/integrations/google/auto-push"
  );
  const eventKey = `assessor-team-${input.draft.appointmentId}-${phoneDigits(input.member.phoneE164)}`
    .replace(/[^a-zA-Z0-9-_]/g, "")
    .slice(0, 64);
  const result = await autoPushAppointmentToGoogle(db, {
    workspaceId: input.workspaceId,
    title: input.draft.title,
    startsAt: new Date(input.draft.fireAt),
    endsAt: input.draft.endsAt
      ? new Date(input.draft.endsAt)
      : new Date(Date.parse(input.draft.fireAt) + 60 * 60 * 1000),
    timezone: input.draft.timezone,
    description: [
      `Reunião da equipe ${input.draft.groupName}`,
      String(input.payload.meet_url || "").trim(),
      String(input.payload.shared_note || "").trim(),
    ].filter(Boolean).join("\n"),
    recurrenceRule: input.draft.recurrenceRule,
    assessorId: eventKey,
    existingEventId: typeof input.payload.google_event_id === "string"
      ? input.payload.google_event_id
      : null,
  });
  if (result.eventId) {
    await db
      .update(reminders)
      .set({
        payload: { ...input.payload, google_event_id: result.eventId },
        updatedAt: new Date(),
      })
      .where(eq(reminders.id, input.reminderId));
  }
}

async function scheduleMemberReminder(
  db: Db,
  userId: string,
  workspaceId: string,
  draft: TeamReminderDraft,
  member: TeamMember,
  status: Awaited<ReturnType<typeof getMemberStatus>>
): Promise<boolean> {
  if (!status.eligible || !status.targetKind) return false;
  const deliveryId = `team:${draft.id}:${phoneDigits(member.phoneE164)}`;
  const linked = status.targetKind === "assessor"
    ? await resolveLinkedIds(db, member.phoneE164)
    : { linkedUserId: null, linkedWorkspaceId: null };
  const targetUserId = linked.linkedUserId || userId;
  const targetWorkspaceId = linked.linkedWorkspaceId || workspaceId;
  const existing = await db.query.reminders.findFirst({
    where: and(
      eq(reminders.workspaceId, targetWorkspaceId),
      eq(reminders.userId, targetUserId),
      sql`${reminders.payload}->>'team_delivery_id' = ${deliveryId}`,
      isNull(reminders.deletedAt)
    ),
  });
  if (existing) {
    if (status.targetKind === "assessor") {
      await syncMemberAppointmentCalendar(db, {
        reminderId: existing.id,
        workspaceId: targetWorkspaceId,
        draft,
        member,
        payload: (existing.payload || {}) as Record<string, unknown>,
      });
    }
    return true;
  }

  const externalPayload = status.targetKind === "external";
  const { ownerPhoneE164 } = await import("@/domain/external-notice");
  const organizerPhone = await ownerPhoneE164(db, userId);
  let memberAppointmentId: string | null = null;
  if (!externalPayload && draft.appointmentId) {
    const linkedAppointment = await db.query.appointments.findFirst({
      where: and(
        eq(appointments.workspaceId, targetWorkspaceId),
        sql`${appointments.metadata}->>'team_owner_appointment_id' = ${draft.appointmentId}`,
        isNull(appointments.deletedAt)
      ),
    });
    if (linkedAppointment) {
      memberAppointmentId = linkedAppointment.id;
    } else {
      const [mirror] = await db
        .insert(appointments)
        .values({
          workspaceId: targetWorkspaceId,
          createdByUserId: targetUserId,
          userId: targetUserId,
          title: `${draft.groupName}: ${draft.title}`.slice(0, 500),
          description: [
            `Convite de ${draft.ownerDisplayName}`,
            String(draft.payload?.meet_url || "").trim(),
            String(draft.payload?.note || "").trim(),
          ].filter(Boolean).join("\n"),
          startsAt: new Date(draft.fireAt),
          endsAt: draft.endsAt ? new Date(draft.endsAt) : new Date(Date.parse(draft.fireAt) + 60 * 60 * 1000),
          timezone: draft.timezone,
          status: "scheduled",
          metadata: {
            team_event: true,
            team_owner_appointment_id: draft.appointmentId,
            team_owner_user_id: userId,
            team_owner_phone: member.phoneE164,
            team_group: draft.groupName,
            meet_url: draft.payload?.meet_url || null,
            recurrence_rule: draft.recurrenceRule || null,
          },
        })
        .returning();
      memberAppointmentId = mirror.id;
    }
  }
  const title = externalPayload
    ? `[equipe→${member.name}] ${draft.title}`.slice(0, 500)
    : `Equipe ${draft.groupName}: ${draft.title}`.slice(0, 500);
  const payload: Record<string, unknown> = externalPayload
    ? {
        kind: "team_external_oneshot",
        team_external_oneshot: true,
        team_delivery_id: deliveryId,
        team_owner_user_id: userId,
        team_group: draft.groupName,
        appointment_id: draft.appointmentId || null,
        meet_url: draft.payload?.meet_url || null,
        shared_note: draft.payload?.note || null,
        target_phone: member.phoneE164,
        target_name: member.name,
        from_name: draft.ownerDisplayName,
        owner_phone: organizerPhone,
        real_title: draft.title,
      }
    : {
        kind: "team_reminder",
        team_reminder: true,
        team_delivery_id: deliveryId,
        team_group: draft.groupName,
        target_phone: member.phoneE164,
        appointment_id: draft.appointmentId || null,
        member_appointment_id: memberAppointmentId,
        meet_url: draft.payload?.meet_url || null,
        shared_note: draft.payload?.note || null,
        note: [
          memberAppointmentId ? `appointment:${memberAppointmentId}` : "",
          draft.payload?.meet_url ? `Meet: ${String(draft.payload.meet_url)}` : "",
          draft.payload?.note ? String(draft.payload.note) : "",
        ].filter(Boolean).join("\n") || null,
        shared_from: { user_id: userId, name: draft.ownerDisplayName },
        emoji: "👥",
      };
  const [row] = await db
    .insert(reminders)
    .values({
      workspaceId: targetWorkspaceId,
      userId: targetUserId,
      title,
      fireAt: new Date(draft.fireAt),
      timezone: draft.timezone,
      status: "scheduled",
      deliveryChannel: "whatsapp",
      requiresTemplate: externalPayload,
      templateName: externalPayload ? "assessor_reminder" : null,
      recurrenceRule: draft.recurrenceRule || null,
      payload,
      nextAttemptAt: new Date(draft.fireAt),
    })
    .returning();
  await ensureReminderOutbox(db, {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    title: row.title,
    fireAt: row.fireAt,
    payload: (row.payload || {}) as Record<string, unknown>,
  });
  await db
    .update(reminders)
    .set({
      occurrenceKey: reminderOccurrenceKey(row.id, row.fireAt),
      updatedAt: new Date(),
    })
    .where(eq(reminders.id, row.id));
  if (status.targetKind === "assessor") {
    await syncMemberAppointmentCalendar(db, {
      reminderId: row.id,
      workspaceId: targetWorkspaceId,
      draft,
      member,
      payload,
    });
  }
  return true;
}

async function sendTeamMeetingInviteNow(
  db: Db,
  userId: string,
  draft: TeamReminderDraft,
  member: TeamMember
): Promise<{ ok: boolean; reason?: string }> {
  const index = draft.members.findIndex((item) => item.phoneE164 === member.phoneE164) + 1;
  const status = await getMemberStatus(db, userId, draft, member, index);
  if (!status.eligible || !status.targetKind) return { ok: false, reason: status.reason };
  const template = await getTemplate(db, "reminder");
  const catalog = getCatalogByLogical("reminder");
  if (
    !template ||
    !["approved", "active"].includes(String(template.status || "").toLowerCase()) ||
    catalog?.category !== "UTILITY"
  ) {
    return { ok: false, reason: "mensagem de aviso aprovada indisponível" };
  }
  const config = await resolveZernioRuntimeConfig(db);
  if (config.mock) return { ok: false, reason: "Zernio não está configurado" };
  const body = await noticeWithOwnerChat(
    db,
    userId,
    draft.ownerDisplayName,
    formatMeetingInvite({
      title: draft.title,
      groupName: draft.groupName,
      fireAt: draft.fireAt,
      endsAt: draft.endsAt,
      timezone: draft.timezone,
      meetUrl: String(draft.payload?.meet_url || ""),
      note: String(draft.payload?.note || ""),
      organizer: draft.ownerDisplayName,
    })
  );
  const sent = await createWhatsAppTemplateConversation(
    {
      phoneE164: member.phoneE164,
      templateName: template.providerTemplateName,
      templateLanguage: template.language || catalog.language,
      templateParams: packSingleBodyParam(body),
      idempotencyKey: `team-invite:${draft.appointmentId || draft.id}:${phoneDigits(member.phoneE164)}`,
      accountId: config.accountId,
    },
    {
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      accountId: config.accountId,
      mock: config.mock,
    }
  );
  return sent.ok
    ? { ok: true }
    : { ok: false, reason: sent.error || "falha na mensagem aprovada" };
}

export function isTeamSelectionAnswer(
  text: string,
  memberCount: number,
  status: "selecting" | "confirming" | "sending"
): boolean {
  const raw = String(text || "").trim();
  if (/^(?:cancelar|cancela|desfaz|desfazer|deixa|esquece|desisto|para|0)$/i.test(raw)) {
    return true;
  }
  if (status === "confirming" || status === "sending") {
    return /^(?:confirmar|confirma|sim|pode enviar|envie)$/i.test(raw);
  }
  return parseTeamReminderSelection(raw, memberCount) != null;
}

export async function handlePendingTeamReminderTurn(
  db: Db,
  input: { userId: string; workspaceId: string; text: string }
): Promise<string | null> {
  let draft = await loadDraft(db, input.userId);
  if (!draft) return null;
  if (Date.parse(draft.expiresAt) <= Date.now()) {
    await saveDraft(db, input.userId, null);
    return null;
  }

  const text = String(input.text || "").trim();
  const { isAbandon, isFreshCommand } = await import("@/domain/desk-router");
  if (isFreshCommand(text) || isAbandon(text) || !isTeamSelectionAnswer(text, draft.members.length, draft.status)) {
    await saveDraft(db, input.userId, null);
    if (isAbandon(text)) {
      return `Beleza, desisti. Cancelei os avisos para *${draft.groupName}*.`;
    }
    return null;
  }
  if (/^(?:cancelar|cancela|desfaz|desfazer|deixa|esquece|desisto|para|0)$/i.test(text)) {
    await saveDraft(db, input.userId, null);
    return `Cancelei os avisos para o grupo *${draft.groupName}*. Seu lembrete pessoal continua ativo.`;
  }
  if (draft.status === "sending") {
    return "Já estou agendando esse envio. Aguarde a confirmação antes de tentar novamente.";
  }

  if (draft.status === "selecting") {
    const selection = parseTeamReminderSelection(text, draft.members.length);
    if (!selection) {
      return `Responda com um número de 1 a ${draft.members.length}, *todos* ou *cancelar*.\n\n${await formatSelection(db, input.userId, draft)}`;
    }
    const statuses = await Promise.all(
      draft.members.map((member, index) => getMemberStatus(db, input.userId, draft!, member, index + 1))
    );
    const selected = selection === "all"
      ? statuses.filter((status) => status.eligible)
      : selection.map((index) => statuses[index - 1]);
    const blocked = selected.filter((status) => !status?.eligible);
    if (blocked.length) {
      return `Não posso incluir ${blocked.map((item) => `*${item.name}* (${item.reason})`).join(", ")}. Cada pessoa precisa autorizar antes de receber avisos.\n\n${await formatSelection(db, input.userId, draft)}`;
    }
    const eligible = selected.filter((item) => item?.eligible);
    if (!eligible.length) {
      return `Ninguém da seleção autorizou os avisos ainda. Envie o convite individual e aguarde a autorização; seu lembrete pessoal continua ativo.`;
    }
    draft = {
      ...draft,
      status: "confirming",
      selectedPhones: eligible.map((item) => item.phoneE164),
    };
    await saveDraft(db, input.userId, draft);
    const recipientText = eligible.map((item) => `• *${item.name}*\n  📞 ${item.phoneE164} · ${item.reason}`).join("\n");
    const excluded = statuses.filter((item) => !item.eligible);
    return [
      `📨 *CONFIRME OS CONVIDADOS* · ${draft.groupName}`,
      `*${draft.title}* · ${formatWhen(draft.fireAt, draft.timezone)}`,
      recipientText,
      ...(excluded.length
        ? [
            "",
            `Não incluídos: ${excluded.map((item) => `${item.name} (${item.reason})`).join(", ")}.`,
          ]
        : []),
      "",
      "Confira os nomes e telefones. Responda *confirmar* para enviar ou *cancelar*.",
    ].join("\n");
  }

  if (!/^(?:confirmar|confirma|sim|pode enviar|envie)$/i.test(text)) {
    return `Os avisos para *${draft.groupName}* estão prontos. Responda *confirmar* ou *cancelar*.`;
  }

  draft = { ...draft, status: "sending" };
  await saveDraft(db, input.userId, draft);
  const outcomes: string[] = [];
  for (const phone of draft.selectedPhones) {
    if (draft.results[phone] === "scheduled") continue;
    const member = draft.members.find((item) => item.phoneE164 === phone);
    if (!member) continue;
    const index = draft.members.findIndex((item) => item.phoneE164 === phone) + 1;
    const status = await getMemberStatus(db, input.userId, draft, member, index);
    let inviteError: string | undefined;
    let inviteSent = true;
    if (draft.appointmentId && status.targetKind === "external") {
      const invitation = await sendTeamMeetingInviteNow(
        db,
        input.userId,
        draft,
        member
      );
      inviteSent = invitation.ok;
      inviteError = invitation.reason;
    }
    const scheduled = inviteSent && await scheduleMemberReminder(
      db,
      input.userId,
      input.workspaceId,
      draft,
      member,
      status
    );
    draft.results[phone] = scheduled ? "scheduled" : "failed";
    await saveDraft(db, input.userId, draft);
    outcomes.push(`${scheduled ? "✅" : "⚠️"} ${member.name}${scheduled ? draft.appointmentId ? " convite enviado; aviso agendado" : " aviso agendado" : ` não agendado (${inviteError || status.reason || "autorização ou grupo mudou"})`}`);
  }

  const failed = draft.selectedPhones.some((phone) => draft?.results[phone] !== "scheduled");
  if (failed) {
    draft.status = "confirming";
    await saveDraft(db, input.userId, draft);
    return `Resultado dos avisos para *${draft.groupName}*:\n${outcomes.join("\n")}\n\nResponda *confirmar* para tentar só quem falta ou *cancelar*.`;
  }

  await writeProfile(db, input.userId, (profile) => {
    delete profile[PENDING_PROFILE_KEY];
    profile.team_reminder_last = {
      id: draft!.id,
      groupName: draft!.groupName,
      completedAt: new Date().toISOString(),
      results: draft!.results,
    };
  });
  return `✅ Avisos de *${draft.groupName}* confirmados para ${formatWhen(draft.fireAt, draft.timezone)}:\n${outcomes.join("\n")}`;
}

export async function tryDeliverTeamReminderExternal(
  db: Db,
  reminder: {
    id: string;
    fireAt: Date;
    timezone: string;
    recurrenceRule?: string | null;
    payload: Record<string, unknown> | null;
  }
): Promise<{ handled: boolean; ok?: boolean; errorCode?: string; nextFireAt?: Date | null }> {
  const payload = reminder.payload || {};
  if (payload.desk_external_oneshot === true) {
    const ownerUserId = String(payload.team_owner_user_id || "");
    const targetPhone = String(payload.target_phone || "");
    const contacts = ownerUserId ? await listFamilyContacts(db, ownerUserId) : [];
    const contact = contacts.find((item) => item.phoneE164 === targetPhone);
    if (!contact || contact.reminderConsent?.status === "opted_out") {
      return { handled: true, ok: false, errorCode: "team_recipient_opted_out" };
    }
    const { sendApprovedUtilityNotice, withOrganizerChat } = await import(
      "@/domain/external-notice"
    );
    const body = withOrganizerChat(
      String(payload.notice_body || payload.real_title || ""),
      String(payload.from_name || ""),
      String(payload.owner_phone || "")
    );
    const sent = await sendApprovedUtilityNotice(db, {
      phoneE164: targetPhone,
      body,
      idempotencyKey: `desk-notice:${reminder.id}:${reminder.fireAt.toISOString()}`,
    });
    return sent.ok
      ? { handled: true, ok: true, nextFireAt: null }
      : { handled: true, ok: false, errorCode: sent.error || "zernio_template_send_failed" };
  }
  if (payload.team_external_oneshot !== true) return { handled: false };
  const ownerUserId = String(payload.team_owner_user_id || "");
  const targetPhone = String(payload.target_phone || "");
  const targetName = String(payload.target_name || "");
  const groupName = String(payload.team_group || "");
  const contacts = await listFamilyContacts(db, ownerUserId);
  const contact = contacts.find((item) => item.phoneE164 === targetPhone);
  const groups = await listContactGroups(db, ownerUserId);
  const group = groups.find((item) => fold(item.name) === fold(groupName));
  const deskNamed = !groupName || fold(groupName) === "convidados";
  if (
    !contact ||
    contact.reminderConsent?.status === "opted_out" ||
    (!deskNamed &&
      (contact.reminderConsent?.status !== "opted_in" ||
        !group?.memberPhones.includes(targetPhone)))
  ) {
    return { handled: true, ok: false, errorCode: "team_recipient_not_authorized" };
  }

  const template = await getTemplate(db, "reminder");
  const catalog = getCatalogByLogical("reminder");
  const status = String(template?.status || "").toLowerCase();
  if (
    !template ||
    !["approved", "active"].includes(status) ||
    catalog?.category !== "UTILITY"
  ) {
    return { handled: true, ok: false, errorCode: "approved_utility_template_unavailable" };
  }
  const config = await resolveZernioRuntimeConfig(db);
  if (config.mock) {
    return { handled: true, ok: false, errorCode: "zernio_not_configured_for_external_send" };
  }
  const when = DateTime.fromJSDate(reminder.fireAt)
    .setZone(reminder.timezone || "America/Sao_Paulo")
    .toFormat("dd/LL · HH:mm");
  const meetUrl = String(payload.meet_url || "").trim();
  const sharedNote = String(payload.shared_note || "").trim();
  const sharedFrom = payload.shared_from as Record<string, unknown> | undefined;
  const organizer = String(sharedFrom?.name || payload.from_name || "");
  const body = await noticeWithOwnerChat(
    db,
    ownerUserId,
    organizer,
    formatMeetingInvite({
      title: String(payload.real_title || "Lembrete de equipe"),
      groupName,
      fireAt: reminder.fireAt.toISOString(),
      timezone: reminder.timezone || "America/Sao_Paulo",
      meetUrl,
      note: sharedNote,
      organizer,
    }),
    String(payload.owner_phone || "")
  );
  const sent = await createWhatsAppTemplateConversation(
    {
      phoneE164: targetPhone,
      templateName: template.providerTemplateName,
      templateLanguage: template.language || catalog.language,
      templateParams: packSingleBodyParam(body),
      idempotencyKey: `team-reminder:${reminder.id}:${reminder.fireAt.toISOString()}`,
      accountId: config.accountId,
    },
    {
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      accountId: config.accountId,
      mock: config.mock,
    }
  );
  const { nextFireFromRecurrence } = await import("@/lib/recurrence");
  const nextFireAt = sent.ok
    ? nextFireFromRecurrence(
        reminder.fireAt,
        reminder.timezone,
        reminder.recurrenceRule
      )
    : null;
  return sent.ok
    ? { handled: true, ok: true, nextFireAt }
    : { handled: true, ok: false, errorCode: sent.error || "zernio_template_send_failed" };
}

export async function cancelUnauthorizedTeamReminder(
  db: Db,
  reminder: {
    id: string;
    fireAt: Date;
    payload: Record<string, unknown> | null;
  }
): Promise<boolean> {
  const payload = reminder.payload || {};
  if (payload.team_reminder !== true) return false;
  const ownerUserId = String(payload.shared_from && typeof payload.shared_from === "object"
    ? (payload.shared_from as Record<string, unknown>).user_id || ""
    : "");
  const targetPhone = String(payload.target_phone || "");
  const groupName = String(payload.team_group || "");
  const contact = (await listFamilyContacts(db, ownerUserId)).find(
    (item) => item.phoneE164 === targetPhone
  );
  const groups = await listContactGroups(db, ownerUserId);
  const group = groups.find((item) => fold(item.name) === fold(groupName));
  if (
    contact?.reminderConsent?.status === "opted_in" &&
    group?.memberPhones.includes(targetPhone)
  ) {
    return false;
  }

  const { reminderOccurrenceKey } = await import("@/domain/alert-delivery");
  const occurrenceKey = reminderOccurrenceKey(reminder.id, reminder.fireAt);
  await db
    .update(reminders)
    .set({
      status: "cancelled",
      lastError: "team_recipient_not_authorized",
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(reminders.id, reminder.id));
  await db.execute(sql`
    UPDATE alert_outbox
    SET status = 'cancelled', locked_at = NULL, locked_by = NULL, updated_at = NOW()
    WHERE occurrence_key = ${occurrenceKey}
      AND status IN ('pending', 'processing', 'failed')
      AND delivered_at IS NULL
  `);
  const memberAppointmentId = String(payload.member_appointment_id || "");
  if (memberAppointmentId) {
    await db
      .update(appointments)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(appointments.id, memberAppointmentId));
  }
  return true;
}

export async function handleTeamAppointmentResponse(
  db: Db,
  input: { phoneE164: string; userId?: string | null; text: string }
): Promise<string | null> {
  const normalized = String(input.text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
  const action = /^(?:cancelar|cancela|desmarcar|desmarque)\s+(?:(?:minha|minha participacao|o|a)\s+)?(?:reuniao|compromisso)(?:\s+(\d+))?$/.exec(normalized);
  const completed = /^(?:baixa|concluir|conclui|finalizar)\s+(?:(?:minha|o|a)\s+)?(?:reuniao|compromisso)(?:\s+(\d+))?$/.exec(normalized);
  if (!action && !completed) return null;

  const phone = `+${phoneDigits(input.phoneE164)}`;
  const conditions = [
    eq(reminders.status, "scheduled"),
    isNull(reminders.deletedAt),
    sql`${reminders.payload}->>'target_phone' = ${phone}`,
    sql`(${reminders.payload}->>'team_reminder' = 'true' OR ${reminders.payload}->>'team_external_oneshot' = 'true')`,
  ];
  if (input.userId) {
    conditions.push(
      or(
        eq(reminders.userId, input.userId),
        sql`${reminders.payload}->'shared_from'->>'user_id' = ${input.userId}`
      )!
    );
  } else {
    conditions.push(sql`${reminders.payload}->>'team_external_oneshot' = 'true'`);
  }
  const rows = await db.query.reminders.findMany({
    where: and(...conditions),
    orderBy: (table, { asc }) => [asc(table.fireAt)],
    limit: 30,
  });
  const validRows = rows.filter((row) => {
    const payload = (row.payload || {}) as Record<string, unknown>;
    return phoneDigits(String(payload.target_phone || "")) === phoneDigits(phone);
  });
  if (
    input.userId &&
    !/minha participacao/i.test(normalized) &&
    validRows.some((row) => {
      const payload = (row.payload || {}) as Record<string, unknown>;
      const sharedFrom = payload.shared_from as Record<string, unknown> | undefined;
      return String(sharedFrom?.user_id || "") === input.userId;
    })
  ) {
    return null;
  }
  if (!validRows.length) return "Não encontrei reunião de equipe futura para este número.";
  const requestedIndex = Number((action || completed)?.[1] || 0);
  if (!requestedIndex && validRows.length > 1) {
    return [
      "Encontrei mais de uma reunião de equipe:",
      ...validRows.map((row, index) => `${index + 1}. ${row.title} · ${formatWhen(row.fireAt.toISOString(), row.timezone)}`),
      "",
      `Responda *cancelar reunião 1* ou *baixa reunião 1*.`,
    ].join("\n");
  }
  const row = validRows[requestedIndex ? requestedIndex - 1 : 0];
  if (!row) return `Escolha um número de 1 a ${validRows.length}.`;
  const { reminderOccurrenceKey } = await import("@/domain/alert-delivery");
  const occurrenceKey = reminderOccurrenceKey(row.id, row.fireAt);
  await db
    .update(reminders)
    .set({
      status: action ? "cancelled" : "sent",
      recurrenceRule: null,
      lastDeliveredAt: action ? row.lastDeliveredAt : new Date(),
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(reminders.id, row.id));
  await db.execute(sql`
    UPDATE alert_outbox
    SET status = 'cancelled', locked_at = NULL, locked_by = NULL, updated_at = NOW()
    WHERE source_id = ${row.id}
      AND source_type = 'reminder'
      AND status IN ('pending', 'processing', 'failed')
      AND delivered_at IS NULL
  `);
  const payload = (row.payload || {}) as Record<string, unknown>;
  const memberAppointmentId = String(payload.member_appointment_id || "");
  if (memberAppointmentId) {
    await db
      .update(appointments)
      .set({ status: action ? "cancelled" : "completed", updatedAt: new Date() })
      .where(eq(appointments.id, memberAppointmentId));
  }
  if (typeof payload.google_event_id === "string") {
    const { deleteAppointmentFromGoogle } = await import(
      "@/integrations/google/auto-push"
    );
    await deleteAppointmentFromGoogle(db, {
      workspaceId: row.workspaceId,
      eventId: payload.google_event_id,
    });
  }
  return action
    ? `Cancelei sua participação em *${row.title}*. O compromisso continua para os demais convidados.`
    : `Baixa registrada para *${row.title}*. Não enviarei os próximos avisos desta série para você.`;
}

export async function cancelAppointmentTeamDeliveries(
  db: Db,
  appointmentId: string
): Promise<void> {
  const linked = await db.query.reminders.findMany({
    where: and(
      sql`${reminders.payload}->>'appointment_id' = ${appointmentId}`,
      isNull(reminders.deletedAt),
      sql`${reminders.status} IN ('scheduled', 'queued', 'failed')`
    ),
  });
  for (const row of linked) {
    const payload = (row.payload || {}) as Record<string, unknown>;
    if (payload.team_external_oneshot === true) {
      const ownerUserId = String(payload.team_owner_user_id || "");
      const targetPhone = String(payload.target_phone || "");
      const contact = (await listFamilyContacts(db, ownerUserId)).find(
        (item) => item.phoneE164 === targetPhone
      );
      if (contact?.reminderConsent?.status === "opted_in") {
        const template = await getTemplate(db, "reminder");
        const catalog = getCatalogByLogical("reminder");
        const config = await resolveZernioRuntimeConfig(db);
        if (
          template &&
          ["approved", "active"].includes(String(template.status || "").toLowerCase()) &&
          catalog?.category === "UTILITY" &&
          !config.mock
        ) {
          const cancellation = await createWhatsAppTemplateConversation(
            {
              phoneE164: targetPhone,
              templateName: template.providerTemplateName,
              templateLanguage: template.language || catalog.language,
              templateParams: packSingleBodyParam(
                `CANCELADA: ${String(payload.real_title || row.title)} · reunião ${String(payload.team_group || "equipe")}`
              ),
              idempotencyKey: `team-cancel:${appointmentId}:${phoneDigits(targetPhone)}`,
              accountId: config.accountId,
            },
            {
              apiKey: config.apiKey,
              apiUrl: config.apiUrl,
              accountId: config.accountId,
              mock: config.mock,
            }
          );
          if (!cancellation.ok) {
            await db
              .update(reminders)
              .set({
                lastError: `cancel_notice_failed:${cancellation.error || "template_error"}`,
                updatedAt: new Date(),
              })
              .where(eq(reminders.id, row.id));
          }
        }
      }
    }
    await db.update(reminders)
      .set({
        status: "cancelled",
        recurrenceRule: null,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(reminders.id, row.id));
    await db.execute(sql`
      UPDATE alert_outbox
      SET status = 'cancelled', locked_at = NULL, locked_by = NULL, updated_at = NOW()
      WHERE source_id = ${row.id}
        AND source_type = 'reminder'
        AND status IN ('pending', 'processing', 'failed')
        AND delivered_at IS NULL
    `);
    const memberAppointmentId = String(payload.member_appointment_id || "");
    if (memberAppointmentId) {
      await db
        .update(appointments)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(appointments.id, memberAppointmentId));
    }
    if (typeof payload.google_event_id === "string") {
      const { deleteAppointmentFromGoogle } = await import(
        "@/integrations/google/auto-push"
      );
      await deleteAppointmentFromGoogle(db, {
        workspaceId: row.workspaceId,
        eventId: payload.google_event_id,
      });
    }
  }
}

export async function rescheduleAppointmentTeamDeliveries(
  db: Db,
  input: {
    appointmentId: string;
    title: string;
    startsAt: Date;
    recurrenceRule?: string | null;
    meetUrl?: string | null;
    note?: string | null;
  }
): Promise<{ updated: number; externalNoticeFailed: string[] }> {
  let updated = 0;
  const externalNoticeFailed: string[] = [];
  const linked = await db.query.reminders.findMany({
    where: and(
      sql`${reminders.payload}->>'appointment_id' = ${input.appointmentId}`,
      sql`(${reminders.payload}->>'team_reminder' = 'true' OR ${reminders.payload}->>'team_external_oneshot' = 'true')`,
      isNull(reminders.deletedAt),
      sql`${reminders.status} IN ('scheduled', 'queued', 'failed')`
    ),
  });
  for (const row of linked) {
    const payload = { ...((row.payload || {}) as Record<string, unknown>) };
    const external = payload.team_external_oneshot === true;
    const groupName = String(payload.team_group || "");
    let noticeError: string | null = null;
    if (input.startsAt.getTime() <= Date.now()) {
      await db.execute(sql`
        UPDATE alert_outbox
        SET status = 'cancelled', locked_at = NULL, locked_by = NULL, updated_at = NOW()
        WHERE source_id = ${row.id}
          AND source_type = 'reminder'
          AND status IN ('pending', 'processing', 'failed')
          AND delivered_at IS NULL
      `);
      await db
        .update(reminders)
        .set({ status: "cancelled", recurrenceRule: null, updatedAt: new Date() })
        .where(eq(reminders.id, row.id));
      if (typeof payload.google_event_id === "string") {
        const { deleteAppointmentFromGoogle } = await import(
          "@/integrations/google/auto-push"
        );
        await deleteAppointmentFromGoogle(db, {
          workspaceId: row.workspaceId,
          eventId: payload.google_event_id,
        });
      }
      continue;
    }

    if (external) {
      const ownerUserId = String(payload.team_owner_user_id || "");
      const targetPhone = String(payload.target_phone || "");
      const contact = (await listFamilyContacts(db, ownerUserId)).find(
        (item) => item.phoneE164 === targetPhone
      );
      const groups = await listContactGroups(db, ownerUserId);
      const group = groups.find((item) => fold(item.name) === fold(groupName));
      if (
        !contact ||
        contact.reminderConsent?.status !== "opted_in" ||
        !group?.memberPhones.includes(targetPhone)
      ) {
        await db
          .update(reminders)
          .set({ status: "cancelled", recurrenceRule: null, lastError: "team_recipient_not_authorized", updatedAt: new Date() })
          .where(eq(reminders.id, row.id));
        continue;
      }
      const template = await getTemplate(db, "reminder");
      const catalog = getCatalogByLogical("reminder");
      const config = await resolveZernioRuntimeConfig(db);
      if (
        !template ||
        !["approved", "active"].includes(String(template.status || "").toLowerCase()) ||
        catalog?.category !== "UTILITY" ||
        config.mock
      ) {
        externalNoticeFailed.push(String(payload.target_name || targetPhone));
        noticeError = "team_update_template_unavailable";
      } else {
        const when = DateTime.fromJSDate(input.startsAt)
          .setZone(row.timezone || "America/Sao_Paulo")
          .toFormat("dd/LL · HH:mm");
        const updateBody = [
          `ATUALIZADA: ${input.title}`,
          `Equipe ${groupName} · ${when}`,
          ...(input.meetUrl ? [`Google Meet: ${input.meetUrl}`] : []),
          ...(input.note ? [input.note] : []),
        ].join("\n");
        const updateId = createHash("sha256")
          .update(`${input.appointmentId}:${phoneDigits(targetPhone)}:${input.startsAt.toISOString()}:${updateBody}`)
          .digest("hex")
          .slice(0, 32);
        const notice = await createWhatsAppTemplateConversation(
          {
            phoneE164: targetPhone,
            templateName: template.providerTemplateName,
            templateLanguage: template.language || catalog.language,
            templateParams: packSingleBodyParam(updateBody),
            idempotencyKey: `team-update:${updateId}`,
            accountId: config.accountId,
          },
          {
            apiKey: config.apiKey,
            apiUrl: config.apiUrl,
            accountId: config.accountId,
            mock: config.mock,
          }
        );
        if (!notice.ok) {
          externalNoticeFailed.push(String(payload.target_name || targetPhone));
          noticeError = `team_update_notice_failed:${notice.error || "template_error"}`;
        }
      }
    }

    await db.execute(sql`
      UPDATE alert_outbox
      SET status = 'cancelled', locked_at = NULL, locked_by = NULL, updated_at = NOW()
      WHERE source_id = ${row.id}
        AND source_type = 'reminder'
        AND status IN ('pending', 'processing', 'failed')
        AND delivered_at IS NULL
    `);
    payload.real_title = input.title;
    payload.meet_url = input.meetUrl || null;
    payload.shared_note = input.note || null;
    if (noticeError) payload.team_update_notice_error = noticeError;
    else delete payload.team_update_notice_error;
    const title = external
      ? `[equipe→${String(payload.target_name || "convidado")}] ${input.title}`.slice(0, 500)
      : `Equipe ${groupName}: ${input.title}`.slice(0, 500);
    const occurrenceKey = reminderOccurrenceKey(row.id, input.startsAt);
    await db
      .update(reminders)
      .set({
        title,
        fireAt: input.startsAt,
        recurrenceRule: input.recurrenceRule || null,
        payload,
        status: "scheduled",
        attemptCount: 0,
        nextAttemptAt: input.startsAt,
        occurrenceKey,
        lockedAt: null,
        lockedBy: null,
        lastError: noticeError,
        updatedAt: new Date(),
      })
      .where(eq(reminders.id, row.id));
    await ensureReminderOutbox(db, {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      title,
      fireAt: input.startsAt,
      payload,
    });
    updated += 1;
    if (payload.team_reminder === true) {
      const memberAppointmentId = String(payload.member_appointment_id || "");
      if (memberAppointmentId) {
        await db
          .update(appointments)
          .set({
            title: `${groupName}: ${input.title}`.slice(0, 500),
            startsAt: input.startsAt,
            endsAt: new Date(input.startsAt.getTime() + 60 * 60 * 1000),
            description: [
              `Convite de ${String((payload.shared_from as Record<string, unknown> | undefined)?.name || "organizador")}`,
              String(payload.meet_url || "").trim(),
              String(payload.shared_note || "").trim(),
            ].filter(Boolean).join("\n"),
            metadata: {
              team_event: true,
              team_owner_appointment_id: input.appointmentId,
              team_owner_user_id: String((payload.shared_from as Record<string, unknown> | undefined)?.user_id || ""),
              team_owner_phone: String(payload.target_phone || ""),
              team_group: groupName,
              meet_url: input.meetUrl || null,
              recurrence_rule: input.recurrenceRule || null,
            },
            updatedAt: new Date(),
          })
          .where(eq(appointments.id, memberAppointmentId));
      }
      const { autoPushAppointmentToGoogle } = await import(
        "@/integrations/google/auto-push"
      );
      const digits = phoneDigits(String(payload.target_phone || ""));
      const assessorId = `assessor-team-${input.appointmentId}-${digits}`
        .replace(/[^a-zA-Z0-9-_]/g, "")
        .slice(0, 64);
      const googleEvent = await autoPushAppointmentToGoogle(db, {
        workspaceId: row.workspaceId,
        title: input.title,
        startsAt: input.startsAt,
        endsAt: new Date(input.startsAt.getTime() + 60 * 60 * 1000),
        timezone: row.timezone,
        description: [
          `Reunião da equipe ${groupName}`,
          String(payload.meet_url || "").trim(),
          String(payload.shared_note || "").trim(),
        ].filter(Boolean).join("\n"),
        recurrenceRule: input.recurrenceRule,
        assessorId,
        existingEventId: typeof payload.google_event_id === "string"
          ? payload.google_event_id
          : null,
      });
      if (googleEvent.eventId) {
        payload.google_event_id = googleEvent.eventId;
        await db
          .update(reminders)
          .set({ payload, updatedAt: new Date() })
          .where(eq(reminders.id, row.id));
      }
    }
  }
  return { updated, externalNoticeFailed };
}

export async function rescheduleAppointmentOwnerReminder(
  db: Db,
  input: {
    appointmentId: string;
    workspaceId: string;
    userId: string;
    title: string;
    startsAt: Date;
    recurrenceRule?: string | null;
    reminderOffsetMinutes?: number | null;
    meetUrl?: string | null;
    note?: string | null;
  }
): Promise<void> {
  const rows = await db.query.reminders.findMany({
    where: and(
      eq(reminders.workspaceId, input.workspaceId),
      eq(reminders.userId, input.userId),
      sql`${reminders.payload}->>'appointment_id' = ${input.appointmentId}`,
      isNull(reminders.deletedAt)
    ),
  });
  for (const row of rows) {
    const oldPayload = (row.payload || {}) as Record<string, unknown>;
    if (oldPayload.team_reminder === true || oldPayload.team_external_oneshot === true) continue;
    const reminderOffsetMinutes = Math.max(
      0,
      Math.min(1440, Math.round(Number(input.reminderOffsetMinutes || 0)))
    );
    const reminderFireAt = new Date(
      input.startsAt.getTime() - reminderOffsetMinutes * 60_000
    );
    const payload = {
      ...oldPayload,
      appointment_id: input.appointmentId,
      meet_url: input.meetUrl || null,
      reminder_before_minutes: reminderOffsetMinutes,
      note: [
        `appointment:${input.appointmentId}`,
        input.meetUrl ? `Meet: ${input.meetUrl}` : "",
        input.note || "",
      ].filter(Boolean).join("\n"),
    };
    await db.execute(sql`
      UPDATE alert_outbox
      SET status = 'cancelled', locked_at = NULL, locked_by = NULL, updated_at = NOW()
      WHERE source_id = ${row.id}
        AND source_type = 'reminder'
        AND status IN ('pending', 'processing', 'failed')
        AND delivered_at IS NULL
    `);
    if (reminderFireAt.getTime() <= Date.now()) {
      await db
        .update(reminders)
        .set({ status: "cancelled", recurrenceRule: null, updatedAt: new Date() })
        .where(eq(reminders.id, row.id));
      continue;
    }
    const occurrenceKey = reminderOccurrenceKey(row.id, reminderFireAt);
    const title = `${reminderOffsetMinutes ? "Lembrete" : "Compromisso"}: ${input.title}`.slice(0, 500);
    await db
      .update(reminders)
      .set({
        title,
        fireAt: reminderFireAt,
        recurrenceRule: input.recurrenceRule || null,
        payload,
        status: "scheduled",
        attemptCount: 0,
        nextAttemptAt: reminderFireAt,
        occurrenceKey,
        lastError: null,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(reminders.id, row.id));
    await ensureReminderOutbox(db, {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      title,
      fireAt: reminderFireAt,
      payload,
    });
  }
}
