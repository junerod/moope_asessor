/**
 * Modo família — compartilha LEMBRETE no Zap de quem você cadastrar.
 *
 * O que faz:
 * • No horário, a pessoa recebe o aviso no WhatsApp dela.
 * • O texto deixa claro que o RECADO É SEU (não “do Assessor”).
 * • Se ela já usa o Assessor → lembrete completo no chat dela.
 * • Se ela já falou com o Assessor (mesmo sem conta) → aviso por template/texto.
 * • Se nunca falou → não dá pra mandar frio (regra WhatsApp); te mando o link.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { conversations, reminders, users, whatsappIdentities } from "@/db/schema";
import {
  findWhatsappIdentity,
  normalizePhoneE164,
} from "@/domain/whatsapp-identities";
import { getPersonalWorkspaceForUser } from "@/domain/workspaces";
import { getAssessorWhatsAppPublic } from "@/lib/assessor-whatsapp";
import { sendProactiveMessage } from "@/channels/zernio/proactive";

export type FamilyContact = {
  name: string;
  phoneE164: string;
  linkedUserId?: string | null;
  linkedWorkspaceId?: string | null;
  reminderConsent?: {
    status: "opted_in" | "opted_out";
    at: string;
    source: "whatsapp_invite" | "owner_revocation" | "recipient_opt_out";
  } | null;
};

export type ContactGroup = {
  name: string;
  memberPhones: string[];
};

const MAX_CONTACTS = 50;
const MAX_CONTACT_GROUPS = 20;
const PENDING_GROUP_CONTACT_KEY = "contact_group_pending_add";
const PENDING_GROUP_CONTACT_TTL_MS = 20 * 60 * 1000;
const PENDING_PHONE_FIX_KEY = "contact_phone_fix";

function norm(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function foldName(name: string): string {
  return norm(name)
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/filha|filho|esposa|marido|mae|pai/g, "");
}

function cleanDisplayName(name: string): string {
  return String(name || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/❤️|❤|️/g, "")
    .replace(/^👤\s*/u, "")
    .trim()
    .slice(0, 40);
}

function explainBlock(): string {
  return [
    "👨‍👩‍👧 *Modo família*",
    "",
    "✅ *Faz:* no horário do lembrete, *a pessoa recebe no Zap dela* um aviso.",
    "O texto deixa claro que *você* pediu (não o Assessor sozinho).",
    "",
    "Ex.: você diz “me lembra 18h de buscar o Pedro — *avisa a Ju também*”",
    "→ você recebe o lembrete",
    "→ Ju recebe: *Recado de você:* buscar o Pedro · 18:00",
    "",
    "❌ *Não faz:* ler conversas nem compartilhar Agenda/gastos.",
    "👥 Grupos enviam avisos individuais no Zap de cada pessoa; não criam grupo no WhatsApp.",
    "",
    "*Cadastrar (mais fácil):*",
    "1. Digite *família*",
    "2. 📎 → *Contato* → escolha a pessoa",
    "",
    "_Ou:_ `família Ju 61 99999-0000`",
    "_Ou:_ `adicionar Ju família` e depois manda o contato 📎",
    "",
    "_Grupo:_ `criar grupo Trabalho` · `adicionar Ju ao grupo Trabalho`",
    "_Lembrete:_ “avisa o grupo Trabalho também”",
    "_Privacidade:_ cada pessoa precisa autorizar pelo convite individual; cadastro não autoriza envio.",
  ].join("\n");
}

export async function listFamilyContacts(
  db: Db,
  userId: string
): Promise<FamilyContact[]> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const profile = (user?.profileJson || {}) as Record<string, unknown>;
  const raw = Array.isArray(profile.family_contacts)
    ? (profile.family_contacts as FamilyContact[])
    : [];
  return raw
    .filter((c) => c && c.name && c.phoneE164)
    .map((c) => ({
      name: String(c.name).slice(0, 40),
      phoneE164: String(c.phoneE164),
      linkedUserId: c.linkedUserId || null,
      linkedWorkspaceId: c.linkedWorkspaceId || null,
      reminderConsent:
        c.reminderConsent &&
        (c.reminderConsent.status === "opted_in" ||
          c.reminderConsent.status === "opted_out")
          ? c.reminderConsent
          : null,
    }));
}

async function saveFamilyContacts(
  db: Db,
  userId: string,
  contacts: FamilyContact[]
): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error("user_not_found");
  const profile = {
    ...((user.profileJson || {}) as Record<string, unknown>),
    family_contacts: contacts.slice(0, MAX_CONTACTS),
  };
  await db
    .update(users)
    .set({ profileJson: profile, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function listContactGroups(
  db: Db,
  userId: string
): Promise<ContactGroup[]> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const profile = (user?.profileJson || {}) as Record<string, unknown>;
  const raw = Array.isArray(profile.contact_groups)
    ? (profile.contact_groups as Array<Record<string, unknown>>)
    : [];
  return raw
    .filter((group) => group && typeof group.name === "string")
    .map((group) => ({
      name: String(group.name).trim().slice(0, 40),
      memberPhones: Array.isArray(group.memberPhones)
        ? group.memberPhones.map(String).filter(Boolean)
        : [],
    }))
    .filter((group) => group.name);
}

async function saveContactGroups(
  db: Db,
  userId: string,
  groups: ContactGroup[]
): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error("user_not_found");
  const profile = {
    ...((user.profileJson || {}) as Record<string, unknown>),
    contact_groups: groups.slice(0, MAX_CONTACT_GROUPS),
  };
  await db
    .update(users)
    .set({ profileJson: profile, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

function validGroupName(name: string): string | null {
  const clean = String(name || "").trim().replace(/\s+/g, " ");
  if (
    clean.length < 2 ||
    clean.length > 40 ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(clean)
  ) {
    return null;
  }
  return clean;
}

export type ContactGroupCommand =
  | { action: "list" }
  | { action: "create"; groupName: string }
  | { action: "delete"; groupName: string }
  | { action: "show"; groupName: string }
  | { action: "add"; contactName: string; groupName: string }
  | { action: "remove"; contactName: string; groupName: string }
  | { action: "invite"; contactName: string }
  | { action: "revokeConsent"; contactName: string }
  | { action: "message"; groupName: string; message: string }
  | { action: "ask-reminder"; groupName: string };

export function parseContactGroupCommand(
  text: string
): ContactGroupCommand | null {
  const raw = String(text || "").trim().replace(/[.!?]+$/g, "");
  if (
    /^(?:grupos|meus grupos|lista(?:r)? grupos|lista de grupos|quais grupos(?: eu)?(?: estou| tenho)?|em quais grupos(?: eu)? estou|grupos que eu (?:tenho|estou))\s*\?*$/i.test(
      raw
    )
  ) {
    return { action: "list" };
  }

  let match = raw.match(
    /^(?:convide|convidar|opt[- ]?in link para)\s+(.+?)\s+(?:para|a receber)\s+(?:lembretes|avisos)(?:\s+do\s+assessor)?$/i
  );
  if (match) return { action: "invite", contactName: match[1].trim() };

  match = raw.match(
    /^(?:revogar|remover|cancelar)\s+(?:a\s+)?autoriza(?:c|ç)[aã]o\s+(?:de\s+)?(.+)$/i
  );
  if (match) return { action: "revokeConsent", contactName: match[1].trim() };

  match = raw.match(/^(?:criar|cria|novo|nova)\s+(?:um\s+|uma\s+)?grupo(?:\s+de\s+trabalho)?\s+(.+)$/i);
  if (match) return { action: "create", groupName: match[1].trim() };

  match = raw.match(/^(?:apagar|excluir|deletar)\s+grupo\s+(.+)$/i);
  if (match) return { action: "delete", groupName: match[1].trim() };

  if (!/^(como|onde|quando|o que)\b/i.test(raw)) {
    match = raw.match(
      /(?:adicionar|adiciona|adicione|colocar|coloca|incluir|inclui)\s+(.+?)\s+(?:(?:no|na|ao|a)\s+)(?:grupo(?:\s+de\s+trabalho)?|lista(?:\s+de\s+trabalho)?)\s*(.*)$/i
    );
    if (match) {
      return {
        action: "add",
        contactName: match[1].trim(),
        groupName: match[2].trim(),
      };
    }
  }

  match = raw.match(
    /^(?:remover|remove|tirar|tira)\s+(.+?)\s+(?:(?:do|da)\s+)?(?:grupo(?:\s+de\s+trabalho)?|lista(?:\s+de\s+trabalho)?)\s+(.+)$/i
  );
  if (match) {
    return {
      action: "remove",
      contactName: match[1].trim(),
      groupName: match[2].trim(),
    };
  }

  match = raw.match(
    /^(?:quem\s+(?:est[aá]|ta|tem)\s+(?:no|na)\s+grupo|membros\s+do\s+grupo|pessoas\s+do\s+grupo)\s+(.+)$/i
  );
  if (match) return { action: "show", groupName: match[1].trim() };

  match = raw.match(
    /^(?:lembrete|me lembra|me lembre|me avisa)\s+(?:para|pro)\s+(?:o\s+)?grupo\s+(.+)$/i
  );
  if (match && !/\d{1,2}\s*[:h]|\b[àa]s\b|\bamanh|\bhoje\b/i.test(raw)) {
    return { action: "ask-reminder", groupName: match[1].trim() };
  }

  if (!/^(?:me\s+lembr|lembrete|me\s+avisa)/i.test(raw)) {
    match = raw.match(
      /^(?:manda|mande|envia|envie|fala|avisa|avise|diz)\s+(?:a\s+mensagem\s+)?(.+?)\s+(?:para|pro)\s+(?:o\s+)?grupo\s+(.+)$/i
    );
    if (!match) {
      match = raw.match(/^(.+?)\s+(?:para|pro)\s+(?:o\s+)?grupo\s+(.+)$/i);
      const head = match?.[1]?.trim().split(/\s+/)[0] || "";
      if (
        /^(adicionar|adiciona|adicione|incluir|inclui|colocar|coloca|criar|cria|remover|remove|tirar|tira|quem|grupo|grupos|meus|listar|lista)$/i.test(
          head
        )
      ) {
        match = null;
      }
    }
    if (match?.[1]?.trim() && match[2]?.trim()) {
      return {
        action: "message",
        message: match[1].trim(),
        groupName: match[2].trim(),
      };
    }
  }

  match = raw.match(/^grupo\s+(.+)$/i);
  if (match) return { action: "show", groupName: match[1].trim() };
  return null;
}

export function looksLikeContactGroupIntent(text: string): boolean {
  return parseContactGroupCommand(text) !== null;
}

export async function isPendingGroupContactPhone(
  db: Db,
  userId: string,
  text: string
): Promise<boolean> {
  if (!/^\+?\d[\d\s().-]{8,}\d$/.test(String(text || "").trim())) {
    return false;
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const profile = (user?.profileJson || {}) as Record<string, unknown>;
  const pending = profile[PENDING_GROUP_CONTACT_KEY] as
    | { contactName?: string; groupName?: string; expiresAt?: string }
    | undefined;
  return Boolean(
    pending?.contactName &&
    pending.groupName &&
    pending.expiresAt &&
    Date.parse(pending.expiresAt) > Date.now()
  );
}

export async function handleContactGroupTurn(
  db: Db,
  input: { userId: string; text: string }
): Promise<string> {
  const command = parseContactGroupCommand(input.text);
  if (!command) {
    const user = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
    const profile = (user?.profileJson || {}) as Record<string, unknown>;
    const pending = profile[PENDING_GROUP_CONTACT_KEY] as
      | { contactName?: string; groupName?: string; expiresAt?: string }
      | undefined;
    const phoneMatch = String(input.text || "").trim().match(/^\+?\d[\d\s().-]{8,}\d$/);
    if (pending?.contactName && pending.groupName && phoneMatch) {
      if (!pending.expiresAt || Date.parse(pending.expiresAt) <= Date.now()) {
        await patchProfile(db, input.userId, (current) => {
          delete current[PENDING_GROUP_CONTACT_KEY];
        });
        return `⌛ O pedido para incluir *${pending.contactName}* no grupo *${pending.groupName}* expirou. Ninguém foi adicionado; repita o pedido para tentar novamente.`;
      }
      const saved = await upsertFamilyContact(db, input.userId, {
        name: pending.contactName,
        phone: phoneMatch[0],
        via: "typed",
      });
      if (!saved.contact.phoneE164) return saved.reply;
      const currentGroups = await listContactGroups(db, input.userId);
      const group = currentGroups.find(
        (item) => foldName(item.name) === foldName(pending.groupName!)
      );
      if (!group) {
        await patchProfile(db, input.userId, (current) => {
          delete current[PENDING_GROUP_CONTACT_KEY];
        });
        return `Salvei *${saved.contact.name}* nos contatos, mas o grupo *${pending.groupName}* não existe mais. Ninguém foi vinculado nem avisado.`;
      }
      if (!group.memberPhones.includes(saved.contact.phoneE164)) {
        group.memberPhones.push(saved.contact.phoneE164);
        await saveContactGroups(db, input.userId, currentGroups);
      }
      await patchProfile(db, input.userId, (current) => {
        delete current[PENDING_GROUP_CONTACT_KEY];
      });
      return [
        `✅ *${saved.contact.name}* vinculada ao grupo de trabalho *${group.name}*.`,
        `📞 ${saved.contact.phoneE164}`,
        "Ainda não enviei convite nem mensagem. Confira o nome e o telefone; vou pedir confirmação antes de avisar alguém.",
      ].join("\n");
    }
    return [
      "👥 *Grupos de contatos*",
      "Crie: `criar grupo Trabalho`",
      "Inclua contato salvo: `adicionar Ana ao grupo Trabalho`",
      "Peça autorização para avisos: `convidar Ana para lembretes`",
      "Lembrete: “me lembra … — avisa o grupo Trabalho também”",
      "Digite `grupos` para ver seus grupos.",
    ].join("\n");
  }

  const groups = await listContactGroups(db, input.userId);
  if (command.action === "invite" || command.action === "revokeConsent") {
    const contacts = await listFamilyContacts(db, input.userId);
    const contact = findContactByNameOrPhone(contacts, command.contactName);
    if (!contact) {
      return `Não achei *${command.contactName}* nos contatos salvos. Digite *contatos* para conferir.`;
    }
    if (command.action === "invite") {
      if (contact.reminderConsent?.status === "opted_in") {
        return `*${contact.name}* já autorizou receber lembretes.`;
      }
      const { createReminderConsentInvite } = await import(
        "@/domain/team-reminders"
      );
      const link = await createReminderConsentInvite(db, {
        ownerUserId: input.userId,
        contactPhone: contact.phoneE164,
        contactName: contact.name,
      });
      return [
        `Envie este convite individual para *${contact.name}* autorizar os avisos:`,
        link,
        "Só depois que a própria pessoa autorizar, ela poderá receber lembretes de equipe.",
      ].join("\n\n");
    }
    contact.reminderConsent = {
      status: "opted_out",
      at: new Date().toISOString(),
      source: "owner_revocation",
    };
    const updated = contacts.map((item) =>
      item.phoneE164 === contact.phoneE164 ? contact : item
    );
    await saveFamilyContacts(db, input.userId, updated);
    const { cancelTeamRemindersForRecipient } = await import(
      "@/domain/team-reminders"
    );
    await cancelTeamRemindersForRecipient(db, contact.phoneE164, input.userId);
    return `Revoguei a autorização de lembretes de *${contact.name}*. Ela não receberá novos avisos de equipe.`;
  }
  if (command.action === "list") {
    if (!groups.length) return "Você ainda não criou grupos de trabalho. Exemplo: `criar grupo Trabalho`.";
    return [
      "👥 *Seus grupos de trabalho*",
      ...groups.map((group, index) => {
        const count = group.memberPhones.length;
        return `${index + 1}. *${group.name}* · ${count} ${count === 1 ? "pessoa" : "pessoas"}`;
      }),
    ].join("\n");
  }

  if (command.action === "create") {
    const groupName = validGroupName(command.groupName);
    if (!groupName) return "Nome de grupo inválido. Use de 2 a 40 letras ou números.";
    const groupIndex = groups.findIndex(
      (group) => foldName(group.name) === foldName(groupName)
    );
    if (groupIndex >= 0) return `O grupo *${groups[groupIndex].name}* já existe.`;
    if (groups.length >= MAX_CONTACT_GROUPS) {
      return `Você já tem ${MAX_CONTACT_GROUPS} grupos. Apague um antes de criar outro.`;
    }
    groups.push({ name: groupName, memberPhones: [] });
    await saveContactGroups(db, input.userId, groups);
    return [
      `✅ Grupo *${groupName}* criado.`,
      "",
      "Quem entra agora?",
      "Manda o *nome e o número*, ou compartilha o contato 📎.",
      "",
      `Exemplo: *adicionar Ana 11999998888 ao grupo ${groupName}*`,
      "",
      "Quem já usa o Assessor recebe a mensagem direto. Quem ainda não usa recebe um convite oficial, sem risco de bloqueio.",
    ].join("\n");
  }

  if (command.action === "add" && !command.groupName.trim()) {
    if (!groups.length) {
      return "Você ainda não criou grupos. Primeiro diga `criar grupo Trabalho`; depois, `adicionar Ana ao grupo Trabalho`.";
    }
    return [
      `👥 *Em qual grupo incluo ${command.contactName}?*`,
      ...groups.map((group, index) => `${index + 1}. *${group.name}*`),
      "",
      "Repita o pedido com o número ou nome, por exemplo: `adicionar Ana ao grupo 2`.",
    ].join("\n");
  }

  let groupIndex = -1;
  if (/^\d+$/.test(command.groupName)) {
    groupIndex = Number(command.groupName) - 1;
  } else {
    const groupName = validGroupName(command.groupName);
    if (!groupName) return "Não reconheci esse grupo. Diga `grupos` para ver a lista.";
    groupIndex = groups.findIndex(
      (group) => foldName(group.name) === foldName(groupName)
    );
  }
  if (groupIndex < 0 || groupIndex >= groups.length) {
    return /^\d+$/.test(command.groupName)
      ? `Não há grupo número ${command.groupName}. Digite *grupos* para ver os números disponíveis.`
      : `Não achei o grupo *${command.groupName}*. Digite *grupos* para listar.`;
  }
  const group = groups[groupIndex];

  if (command.action === "delete") {
    groups.splice(groupIndex, 1);
    await saveContactGroups(db, input.userId, groups);
    return `Removi o grupo *${group.name}*. Os contatos continuam salvos.`;
  }

  if (command.action === "ask-reminder") {
    return [
      `🔔 Qual o lembrete do grupo *${group.name}*, e a que horas?`,
      "",
      `Exemplo: *me lembra amanhã às 10 reunião para o grupo ${group.name}*`,
      "",
      "Para avisar agora, sem horário: *texto para o grupo " + group.name + "*",
    ].join("\n");
  }

  if (command.action === "message") {
    return broadcastGroupNotice(db, input.userId, group, command.message);
  }

  if (command.action === "show") {
    const contacts = await listFamilyContacts(db, input.userId);
    const members = group.memberPhones
      .map((phone) => contacts.find((contact) => contact.phoneE164 === phone))
      .filter((contact): contact is FamilyContact => Boolean(contact));
    return members.length
      ? `👥 *${group.name}*\n${members
          .map((contact, index) => {
            const consent = contact.reminderConsent?.status === "opted_in"
              ? "autorizou avisos"
              : contact.reminderConsent?.status === "opted_out"
                ? "não autorizou avisos"
                : "aguardando autorização";
            return `${index + 1}. *${contact.name}*\n   📞 ${contact.phoneE164} · ${consent}`;
          })
          .join("\n")}`
      : `O grupo *${group.name}* ainda não tem contatos.`;
  }

  if (command.action !== "add" && command.action !== "remove") return "";
  const contacts = await listFamilyContacts(db, input.userId);
  let contact = findContactByNameOrPhone(contacts, command.contactName);
  let addedContactNote = "";
  if (!contact && command.action === "add") {
    const phoneMatch = command.contactName.match(/\+?\d[\d\s().-]{8,}\d/);
    if (phoneMatch) {
      const contactName = command.contactName
        .replace(phoneMatch[0], " ")
        .trim() || `Contato ${phoneMatch[0].replace(/\D/g, "").slice(-4)}`;
      const saved = await upsertFamilyContact(db, input.userId, {
        name: contactName,
        phone: phoneMatch[0],
        via: "typed",
      });
      if (saved.contact.phoneE164) {
        contact = (await listFamilyContacts(db, input.userId)).find(
          (item) => item.phoneE164 === saved.contact.phoneE164
        ) || null;
        addedContactNote = " A pessoa ainda precisa autorizar os avisos antes de receber lembretes.";
      } else {
        return saved.reply;
      }
    } else {
      await setAwaitingFamilyContact(db, input.userId, false);
      await patchProfile(db, input.userId, (profile) => {
        profile[PENDING_GROUP_CONTACT_KEY] = {
          contactName: command.contactName,
          groupName: group.name,
          expiresAt: new Date(Date.now() + PENDING_GROUP_CONTACT_TTL_MS).toISOString(),
        };
      });
      return [
        `👥 *Vou incluir ${command.contactName} no grupo de trabalho ${group.name}.*`,
        "",
        "Não encontrei esse contato salvo. Envie o cartão do WhatsApp dessa pessoa ou digite o número completo.",
        "Vou conferir o nome e telefone antes de vincular. Isso não envia convite nem mensagem; ninguém será colocado na lista Família por este pedido.",
      ].join("\n");
    }
  }
  if (!contact) {
    return `Não achei *${command.contactName}* nos contatos. Envie o cartão pelo WhatsApp ou inclua o telefone junto do pedido.`;
  }
  const hasContact = group.memberPhones.includes(contact.phoneE164);
  if (command.action === "add") {
    if (hasContact) {
      return `✅ *${contact.name}* já está no grupo de trabalho *${group.name}*.\n📞 ${contact.phoneE164}\nAinda não enviei convite ou mensagem.`;
    }
    group.memberPhones.push(contact.phoneE164);
    await saveContactGroups(db, input.userId, groups);
    return `✅ Incluí *${contact.name}* no grupo de trabalho *${group.name}*.\n📞 ${contact.phoneE164}\n${addedContactNote || "Ninguém foi avisado. Antes de qualquer convite, vou mostrar nome e telefone para você confirmar."}`;
  }
  if (!hasContact) return `*${contact.name}* não está no grupo *${group.name}*.`;
  group.memberPhones = group.memberPhones.filter((phone) => phone !== contact.phoneE164);
  await saveContactGroups(db, input.userId, groups);
  const { cancelTeamRemindersForRecipient } = await import(
    "@/domain/team-reminders"
  );
  await cancelTeamRemindersForRecipient(
    db,
    contact.phoneE164,
    input.userId,
    group.name
  );
  return `Removi *${contact.name}* do grupo *${group.name}*.`;
}

async function broadcastGroupNotice(
  db: Db,
  userId: string,
  group: ContactGroup,
  message: string
): Promise<string> {
  const text = message.trim().slice(0, 700);
  if (text.length < 1) return "Qual é a mensagem? Exemplo: *reunião às 15h para o grupo " + group.name + "*.";
  if (!group.memberPhones.length) {
    return `O grupo *${group.name}* ainda não tem ninguém. Diga *adiciona Ana ao grupo ${group.name}*.`;
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const from = String(user?.name || "").trim().split(/\s+/)[0] || "Alguém";
  const owner = await db.query.whatsappIdentities.findFirst({
    where: eq(whatsappIdentities.userId, userId),
  });
  const ownerPhone = owner?.phoneE164 || "";
  const contacts = await listFamilyContacts(db, userId);
  const notice = [
    `📩 *${from} mandou avisar:*`,
    text,
    "",
    `👥 Grupo *${group.name}*`,
  ].join("\n");

  const delivered: string[] = [];
  const invited: string[] = [];
  const failed: string[] = [];

  const { createWhatsAppTemplateConversation } = await import(
    "@/channels/zernio/templates-api"
  );
  const { getCatalogByLogical, packSingleBodyParam } = await import(
    "@/domain/whatsapp-templates-catalog"
  );
  const { getTemplate, resolveZernioRuntimeConfig } = await import(
    "@/domain/providers"
  );

  for (const phone of group.memberPhones) {
    if (ownerPhone && phone === ownerPhone) continue;
    const contact = contacts.find((item) => item.phoneE164 === phone);
    const label = contact?.name || phone;
    const conv = await findConversationForPhone(db, phone);
    if (conv) {
      const sent = await sendProactiveMessage(db, {
        conversationId: conv.externalConversationId,
        message: notice,
        idempotencyKey: `group-note:${userId}:${phone}:${Date.now()}`,
        withinCustomerCareWindow: true,
        forceTemplate: false,
      });
      if (sent.ok) {
        delivered.push(label);
        continue;
      }
    }
    const template = await getTemplate(db, "notification");
    const catalog = getCatalogByLogical("notification");
    const config = await resolveZernioRuntimeConfig(db);
    const providerName = template?.providerTemplateName || catalog?.name;
    const templateOk = ["approved", "active"].includes(
      String(template?.status || "").toLowerCase()
    );
    if (!providerName || !templateOk || config.mock) {
      failed.push(label);
      continue;
    }
    const viaTemplate = await createWhatsAppTemplateConversation(
      {
        phoneE164: phone,
        templateName: providerName,
        templateLanguage: template?.language || catalog?.language || "pt_BR",
        templateParams: packSingleBodyParam(notice),
        idempotencyKey: `group-note-tpl:${userId}:${phone}:${Date.now()}`,
        accountId: config.accountId,
      },
      {
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        accountId: config.accountId,
        mock: config.mock,
      }
    );
    if (viaTemplate.ok) invited.push(label);
    else failed.push(label);
  }

  const lines = [`📤 *${group.name}*`, ""];
  if (delivered.length) lines.push(`✅ Avisados: *${delivered.join(", ")}*`);
  if (invited.length) {
    lines.push(
      `📨 Convite oficial para *${invited.join(", ")}* — ainda não falam com o Assessor, então foi pelo modelo aprovado.`
    );
  }
  if (failed.length) lines.push(`⚠️ Não saiu para *${failed.join(", ")}*.`);
  if (!delivered.length && !invited.length) {
    lines.push("Ninguém recebeu. Confira se o grupo tem pessoas com telefone.");
  }
  return lines.join("\n");
}

async function patchProfile(
  db: Db,
  userId: string,
  patch: (p: Record<string, unknown>) => void
) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return;
  const profile = {
    ...((user.profileJson || {}) as Record<string, unknown>),
  };
  patch(profile);
  await db
    .update(users)
    .set({ profileJson: profile, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function setAwaitingFamilyContact(
  db: Db,
  userId: string,
  awaiting: boolean,
  pendingName?: string | null
): Promise<void> {
  await patchProfile(db, userId, (profile) => {
    if (awaiting) {
      profile.family_awaiting_contact = true;
      if (pendingName) profile.family_pending_name = pendingName.slice(0, 40);
    } else {
      delete profile.family_awaiting_contact;
      delete profile.family_pending_name;
    }
  });
}

export async function isAwaitingFamilyContact(
  db: Db,
  userId: string
): Promise<boolean> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const profile = (user?.profileJson || {}) as Record<string, unknown>;
  return profile.family_awaiting_contact === true;
}

export async function getPendingFamilyName(
  db: Db,
  userId: string
): Promise<string | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const profile = (user?.profileJson || {}) as Record<string, unknown>;
  const n = profile.family_pending_name;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

export async function resolveLinkedIds(
  db: Db,
  phoneE164: string
): Promise<{ linkedUserId: string | null; linkedWorkspaceId: string | null }> {
  const identity = await findWhatsappIdentity(db, { phoneE164 });
  if (!identity?.userId || identity.status !== "paired") {
    return { linkedUserId: null, linkedWorkspaceId: null };
  }
  const ws = await getPersonalWorkspaceForUser(db, identity.userId);
  return {
    linkedUserId: identity.userId,
    linkedWorkspaceId: ws?.id || null,
  };
}

/** Conversa Zernio existente pra esse telefone (mesmo sem conta Assessor). */
export async function findConversationForPhone(
  db: Db,
  phoneE164: string
): Promise<{ externalConversationId: string; conversationId: string } | null> {
  const identity = await findWhatsappIdentity(db, { phoneE164 });
  if (!identity) return null;
  const conv = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.whatsappIdentityId, identity.id),
      isNull(conversations.deletedAt)
    ),
    orderBy: (c, { desc }) => [desc(c.lastMessageAt)],
  });
  if (!conv?.externalConversationId) return null;
  return {
    externalConversationId: conv.externalConversationId,
    conversationId: conv.id,
  };
}

export async function upsertFamilyContact(
  db: Db,
  userId: string,
  input: { name: string; phone: string; via?: "share" | "typed" }
): Promise<{ contact: FamilyContact; reply: string }> {
  let name = cleanDisplayName(input.name);
  const pending = await getPendingFamilyName(db, userId);
  if (pending && (!name || name.length < 2 || /^[0-9+]+$/.test(name))) {
    name = pending;
  }
  // Prefer pending short name if contact card is long ("Ana Filha ❤️")
  if (pending && foldName(pending) && foldName(name).startsWith(foldName(pending))) {
    name = pending;
  }

  const phoneE164 = normalizePhoneE164(input.phone);
  if (!name || name.length < 2) {
    return {
      contact: { name: "", phoneE164: "" },
      reply: "Me diga o *nome* (ex.: Ju) e mande o *contato* 📎.",
    };
  }
  if (!phoneE164) {
    await setAwaitingFamilyContact(db, userId, true, name);
    return {
      contact: { name, phoneE164: "" },
      reply: [
        `Quase! Pra *${name}* preciso do número.`,
        "",
        "📎 Manda o *contato* agora (📎 → Contato)",
        `_Ou digite:_ família ${name} 61 99999-0000`,
      ].join("\n"),
    };
  }

  const linked = await resolveLinkedIds(db, phoneE164);
  const contact: FamilyContact = {
    name,
    phoneE164,
    linkedUserId: linked.linkedUserId,
    linkedWorkspaceId: linked.linkedWorkspaceId,
  };

  const existing = await listFamilyContacts(db, userId);
  const idx = existing.findIndex(
    (c) =>
      foldName(c.name) === foldName(name) || c.phoneE164 === phoneE164
  );
  if (idx >= 0) existing[idx] = contact;
  else {
    if (existing.length >= MAX_CONTACTS) {
      return {
        contact,
        reply: `Limite de ${MAX_CONTACTS}. Remova com “esquece família Nome”.`,
      };
    }
    existing.push(contact);
  }
  await saveFamilyContacts(db, userId, existing);
  await setAwaitingFamilyContact(db, userId, false);

  const viaNote =
    input.via === "share" ? " _(contato que você mandou)_" : "";
  const hasConv = await findConversationForPhone(db, phoneE164);

  if (linked.linkedUserId) {
    return {
      contact,
      reply: [
        `✅ *${name}* na família${viaNote}`,
        `${phoneE164} · *usa o Assessor* → recebe lembrete completo`,
        "",
        `Uso: “me lembra às 18h de … — *avisa a ${name} também*”`,
        `Ela vê: *Recado de você:* …`,
      ].join("\n"),
    };
  }

  if (hasConv) {
    return {
      contact,
      reply: [
        `✅ *${name}* na família${viaNote}`,
        `${phoneE164} · já falou com o Assessor → consigo avisar por mensagem`,
        "",
        `Uso: “me lembra às 18h de … — *avisa a ${name} também*”`,
        `Ela vê: *Recado de você:* …`,
      ].join("\n"),
    };
  }

  const wa = await getAssessorWhatsAppPublic();
  const link = wa.waUrl || "o WhatsApp do Assessor";
  return {
    contact,
    reply: [
      `✅ *${name}* salva${viaNote}`,
      `${phoneE164}`,
      "",
      "⏳ Ela *ainda nunca* falou com o Assessor.",
      "WhatsApp *não deixa* eu mandar mensagem fria pra número novo.",
      "",
      "Manda este link pra ela mandar um *Oi*:",
      link,
      "",
      "Assim que ela entrar, “avisa também” funciona de verdade.",
    ].join("\n"),
  };
}

export async function handleSharedContacts(
  db: Db,
  input: {
    userId: string;
    contacts: Array<{ name: string; phoneE164: string }>;
  }
): Promise<string | null> {
  if (!input.contacts.length) return null;
  const phoneFix = await readPhoneFix(db, input.userId);
  if (phoneFix && input.contacts[0]?.phoneE164) {
    return replaceContactPhone(
      db,
      input.userId,
      phoneFix.name,
      input.contacts[0].phoneE164
    );
  }
  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, input.userId),
  });
  const currentProfile = (currentUser?.profileJson || {}) as Record<string, unknown>;
  const pending = currentProfile[PENDING_GROUP_CONTACT_KEY] as
    | { contactName?: string; groupName?: string; expiresAt?: string }
    | undefined;
  if (pending?.contactName && pending.groupName) {
    if (!pending.expiresAt || Date.parse(pending.expiresAt) <= Date.now()) {
      await patchProfile(db, input.userId, (profile) => {
        delete profile[PENDING_GROUP_CONTACT_KEY];
      });
      return `⌛ O pedido para incluir *${pending.contactName}* no grupo *${pending.groupName}* expirou. Ninguém foi adicionado. Repita “adicionar ${pending.contactName} ao grupo ${pending.groupName}” para tentar de novo.`;
    }
    const expected = foldName(pending.contactName);
    const matchingCard = input.contacts.find((shared) => {
      const received = foldName(cleanDisplayName(shared.name));
      return received === expected || received.startsWith(expected);
    });
    if (!matchingCard) {
      return `⚠️ Esse cartão não parece ser de *${pending.contactName}*. Não salvei nem adicionei ninguém. Envie o cartão correto ou digite o telefone de ${pending.contactName}.`;
    }
    const saved = await upsertFamilyContact(db, input.userId, {
      name: matchingCard.name,
      phone: matchingCard.phoneE164,
      via: "share",
    });
    if (!saved.contact.phoneE164) return saved.reply;
    const groups = await listContactGroups(db, input.userId);
    const group = groups.find((item) => foldName(item.name) === foldName(pending.groupName!));
    if (!group) {
      await patchProfile(db, input.userId, (profile) => {
        delete profile[PENDING_GROUP_CONTACT_KEY];
      });
      return `Salvei *${saved.contact.name}* nos contatos, mas o grupo *${pending.groupName}* não existe mais. Ninguém foi vinculado nem avisado.`;
    }
    if (!group.memberPhones.includes(saved.contact.phoneE164)) {
      group.memberPhones.push(saved.contact.phoneE164);
      await saveContactGroups(db, input.userId, groups);
    }
    await patchProfile(db, input.userId, (profile) => {
      delete profile[PENDING_GROUP_CONTACT_KEY];
    });
    return [
      `✅ *${saved.contact.name}* vinculada ao grupo de trabalho *${group.name}*.`,
      `📞 ${saved.contact.phoneE164}`,
      "Ainda não enviei convite nem mensagem. Na hora de marcar a reunião, vou mostrar o nome e o telefone para você confirmar antes de avisar alguém.",
    ].join("\n");
  }
  const { resumeNoticeFromSharedContact } = await import("@/domain/desk-router");
  if (input.contacts[0]) {
    const resumed = await resumeNoticeFromSharedContact(db, input.userId, input.contacts[0]);
    if (resumed) return resumed;
  }
  const replies: string[] = [];
  for (const c of input.contacts.slice(0, 3)) {
    const r = await upsertFamilyContact(db, input.userId, {
      name: c.name,
      phone: c.phoneE164,
      via: "share",
    });
    replies.push(r.reply);
  }
  if (replies.length === 1) return replies[0];
  return `👨‍👩‍👧 Salvei *${replies.length}* contatos.\n\n${replies.join("\n\n────────────\n\n")}`;
}

/** Texto “👤 Nome” (Zernio às vezes só manda isso) — tenta extrair do raw. */
export function looksLikeContactShareText(text: string): boolean {
  const t = String(text || "").trim();
  return /^👤/.test(t) || /^[\u{1F464}]/u.test(t);
}

export async function removeFamilyContact(
  db: Db,
  userId: string,
  name: string
): Promise<string> {
  const existing = await listFamilyContacts(db, userId);
  const removed = existing.find((c) => foldName(c.name) === foldName(name));
  const next = existing.filter((c) => foldName(c.name) !== foldName(name));
  if (next.length === existing.length) {
    return `Não achei *${name}*. Digite *família* pra listar.`;
  }
  await saveFamilyContacts(db, userId, next);
  if (removed) {
    const groups = await listContactGroups(db, userId);
    let changed = false;
    for (const group of groups) {
      const members = group.memberPhones.filter((phone) => phone !== removed.phoneE164);
      if (members.length !== group.memberPhones.length) {
        group.memberPhones = members;
        changed = true;
      }
    }
    if (changed) await saveContactGroups(db, userId, groups);
    const { cancelTeamRemindersForRecipient } = await import(
      "@/domain/team-reminders"
    );
    await cancelTeamRemindersForRecipient(db, removed.phoneE164, userId);
  }
  return `Removi *${name}* da família.`;
}

export function findContactByName(
  contacts: FamilyContact[],
  name: string
): FamilyContact | null {
  const key = foldName(name);
  if (!key) return null;
  return (
    contacts.find((c) => foldName(c.name) === key) ||
    contacts.find((c) => foldName(c.name).startsWith(key)) ||
    contacts.find((c) => key.startsWith(foldName(c.name))) ||
    null
  );
}

export function findContactByNameOrPhone(
  contacts: FamilyContact[],
  query: string
): FamilyContact | null {
  const raw = String(query || "").trim();
  const phoneMatch = raw.match(/\+?\d[\d\s().-]{8,}\d/);
  if (phoneMatch) {
    const phone = normalizePhoneE164(phoneMatch[0]);
    const byPhone = phone
      ? contacts.find(
          (contact) => normalizePhoneE164(contact.phoneE164) === phone
        )
      : null;
    if (byPhone) return byPhone;
  }
  const name = raw.replace(/\+?\d[\d\s().-]{8,}\d/g, " ").trim();
  return findContactByName(contacts, name || raw);
}

export function parseAlsoNotifyNames(text: string): string[] {
  const raw = String(text || "");
  const m = raw.match(
    /\bavis[ae]\s+(?:a\s+|o\s+|pra\s+|para\s+)?(.+?)\s+tamb[eé]m\b/i
  ) || raw.match(
    /\b(?:avis[ae]|convida|convidar)\s+(?:a\s+|o\s+)?(.+?)\s+(?:da|do)\s+(?:minha\s+)?lista\b/i
  );
  if (!m?.[1]) return [];
  return m[1]
    .trim()
    .split(/\s*(?:e|,|\/|\+|e\s+a|e\s+o)\s+/i)
    .map((s) => s.replace(/^(a|o|pra|para)\s+/i, "").trim())
    .filter((s) => /^[A-Za-zÀ-ÿ]{2,40}$/.test(s) && !/^grupo\s+/i.test(s))
    .slice(0, 3);
}

export function parseAlsoNotifyGroups(text: string): string[] {
  const raw = String(text || "");
  const match = raw.match(
    /\bavis[ae]\s+(?:o\s+)?grupo\s+(.+?)(?=\s+tamb[eé]m\b|\s+e\s+(?:me\s+)?(?:avisa|avise|lembra|lembre)\b|[,.!?;]|$)/i
  ) || raw.match(
    /\b(?:para|pro)\s+(?:o\s+)?grupo\s+(.+?)$/i
  );
  const listMatch = raw.match(
    /\b(?:da|do)\s+(?:minha\s+)?lista\s+(?:de\s+)?([\p{L}\p{N}][\p{L}\p{N} ._-]*?)(?=\s+(?:amanh[ãa]|hoje|às|as|para|com|tamb[eé]m)\b|\s+e\s+(?:me\s+)?(?:avisa|avise|lembra|lembre)\b|[,.!?;]|$)/iu
  );
  const groupName = (match?.[1] || listMatch?.[1] || "")
    .replace(/\s+(?:amanh[ãa]|hoje|[àa]s|as|\d{1,2}[:h].*)$/i, "")
    .trim();
  if (!groupName) return [];
  const name = validGroupName(groupName);
  return name ? [name] : [];
}

export function looksLikeFamilyIntent(text: string): boolean {
  const t = norm(text);
  if (!t || t.length > 200) return false;
  if (/\bfamilia\b/.test(t)) return true;
  if (/^(lista familia|quem (esta|tá) na familia)\b/.test(t)) return true;
  if (/^(o que e|o que é|como funciona)\s+(o\s+)?(modo\s+)?familia\b/.test(t))
    return true;
  if (/^(esquece|remove|apaga)\s+familia\b/.test(t)) return true;
  if (parseChangeContactPhone(text)) return true;
  return false;
}

/** “troca o telefone do José” / “o número do José é 61…” */
export function parseChangeContactPhone(
  text: string
): { name: string; phone: string | null } | null {
  const raw = String(text || "").trim().replace(/[.!?]+$/g, "");
  let match = raw.match(
    /^(?:o\s+)?(?:telefone|n[uú]mero|zap|contato)\s+d[oa]\s+([A-Za-zÀ-ÿ]{2,40})\s+(?:[eé]|eh|:)\s+(.+)$/i
  );
  if (match) {
    const digits = match[2].replace(/\D/g, "");
    return { name: match[1].trim(), phone: digits.length >= 10 ? match[2].trim() : null };
  }
  match = raw.match(
    /^(?:troca|trocar|muda|mudar|corrige|corrigir|atualiza|atualizar|errei)\s+(?:o\s+)?(?:telefone|n[uú]mero|zap|contato)\s+d[oa]\s+([A-Za-zÀ-ÿ]{2,40})(?:\s+(?:para|pra|pro|:)\s+(.+))?$/i
  );
  if (match) {
    const digits = String(match[2] || "").replace(/\D/g, "");
    return { name: match[1].trim(), phone: digits.length >= 10 ? match[2].trim() : null };
  }
  match = raw.match(
    /^(?:telefone|n[uú]mero|zap|contato)\s+errado\s+d[oa]\s+([A-Za-zÀ-ÿ]{2,40})$/i
  );
  if (match) return { name: match[1].trim(), phone: null };
  match = raw.match(
    /^(?:mande[ei]\s+errado\s+(?:o\s+)?)(?:telefone|n[uú]mero|contato)\s+d[oa]\s+([A-Za-zÀ-ÿ]{2,40})$/i
  );
  if (match) return { name: match[1].trim(), phone: null };
  return null;
}

async function writePhoneFix(
  db: Db,
  userId: string,
  name: string | null
): Promise<void> {
  await patchProfile(db, userId, (profile) => {
    if (!name) {
      delete profile[PENDING_PHONE_FIX_KEY];
      return;
    }
    profile[PENDING_PHONE_FIX_KEY] = {
      name: name.slice(0, 40),
      expiresAt: new Date(Date.now() + PENDING_GROUP_CONTACT_TTL_MS).toISOString(),
    };
  });
}

async function readPhoneFix(
  db: Db,
  userId: string
): Promise<{ name: string } | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const profile = (user?.profileJson || {}) as Record<string, unknown>;
  const pending = profile[PENDING_PHONE_FIX_KEY] as
    | { name?: string; expiresAt?: string }
    | undefined;
  if (!pending?.name) return null;
  if (pending.expiresAt && Date.parse(pending.expiresAt) <= Date.now()) {
    await writePhoneFix(db, userId, null);
    return null;
  }
  return { name: pending.name };
}

export async function isPendingContactPhoneFix(
  db: Db,
  userId: string,
  text: string
): Promise<boolean> {
  if (!/(\+?\d[\d\s().-]{8,}\d)/.test(String(text || "").trim())) return false;
  return Boolean(await readPhoneFix(db, userId));
}

export async function replaceContactPhone(
  db: Db,
  userId: string,
  name: string,
  phone: string
): Promise<string> {
  const phoneE164 = normalizePhoneE164(phone);
  if (!phoneE164) {
    await writePhoneFix(db, userId, name);
    return `Manda o número certo de *${name}*, ou o contato.`;
  }
  const contacts = await listFamilyContacts(db, userId);
  const found = findContactByName(contacts, name);
  const oldPhone = found?.phoneE164 || "";
  const linked = await resolveLinkedIds(db, phoneE164);
  const next: FamilyContact = {
    name: found?.name || name,
    phoneE164,
    linkedUserId: linked.linkedUserId,
    linkedWorkspaceId: linked.linkedWorkspaceId,
  };
  if (found) {
    const idx = contacts.findIndex((item) => item.phoneE164 === found.phoneE164);
    if (idx >= 0) contacts[idx] = next;
  } else {
    const samePhone = contacts.findIndex((item) => item.phoneE164 === phoneE164);
    if (samePhone >= 0) contacts[samePhone] = next;
    else contacts.push(next);
  }
  await saveFamilyContacts(db, userId, contacts);
  if (oldPhone && oldPhone !== phoneE164) {
    const groups = await listContactGroups(db, userId);
    let changed = false;
    for (const group of groups) {
      const nextPhones = group.memberPhones.map((item) =>
        item === oldPhone ? phoneE164 : item
      );
      if (nextPhones.some((item, index) => item !== group.memberPhones[index])) {
        group.memberPhones = nextPhones;
        changed = true;
      }
    }
    if (changed) await saveContactGroups(db, userId, groups);
  }
  await writePhoneFix(db, userId, null);
  await setAwaitingFamilyContact(db, userId, false);
  return `Troquei o número de *${next.name}*.`;
}

/** “adicionar Ju família” / “família Ju 61…” / só nome pendente */
export function parseFamilySave(
  text: string
): { name: string; phone: string } | { name: string; phone: null } | null {
  const raw = String(text || "").trim();

  // família Ju 61 99999-0000
  let m = raw.match(
    /^(?:fam[ií]lia|contato)\s+([A-Za-zÀ-ÿ]{2,40})\s+(.+)$/i
  );
  if (m) {
    const phoneDigits = m[2].replace(/\D/g, "");
    if (phoneDigits.length >= 10) {
      return { name: m[1].trim(), phone: m[2].trim() };
    }
    // família Ju (só nome)
    return { name: m[1].trim(), phone: null };
  }

  // adicionar/adiciona/salva/coloca Ju (na) família
  m = raw.match(
    /^(?:adicionar|adiciona|salva|cadastra|coloca|incluir|inclui)\s+(?:a\s+|o\s+)?([A-Za-zÀ-ÿ]{2,40})\s+(?:na\s+)?fam[ií]lia\b/i
  );
  if (m) return { name: m[1].trim(), phone: null };

  // Ju na família / pra família
  m = raw.match(
    /^([A-Za-zÀ-ÿ]{2,40})\s+(?:na|pra|para|da)\s+fam[ií]lia\b/i
  );
  if (m) return { name: m[1].trim(), phone: null };

  m = raw.match(
    /^(?:adiciona|salva|cadastra)\s+(?:na\s+)?(?:fam[ií]lia|contato(?:\s+fam[ií]lia)?)\s+([A-Za-zÀ-ÿ]{2,40})\s+(.+)$/i
  );
  if (m) {
    const phoneDigits = m[2].replace(/\D/g, "");
    if (phoneDigits.length >= 10) return { name: m[1].trim(), phone: m[2].trim() };
    return { name: m[1].trim(), phone: null };
  }

  return null;
}

export async function handleFamilyTurn(
  db: Db,
  input: { userId: string; text: string }
): Promise<string> {
  const text = String(input.text || "").trim();
  const t = norm(text);

  const change = parseChangeContactPhone(text);
  if (change) {
    if (change.phone) return replaceContactPhone(db, input.userId, change.name, change.phone);
    await writePhoneFix(db, input.userId, change.name);
    return `Manda o número certo de *${change.name}*, ou o contato.`;
  }
  const pendingFix = await readPhoneFix(db, input.userId);
  if (pendingFix) {
    if (/^(cancelar|cancela|deixa|esquece|desisto)$/i.test(t)) {
      await writePhoneFix(db, input.userId, null);
      return "Beleza, desisti.";
    }
    const typed = text.match(/(\+?\d[\d\s().-]{8,}\d)/);
    if (typed) return replaceContactPhone(db, input.userId, pendingFix.name, typed[1]);
    return `Manda o número certo de *${pendingFix.name}*, ou o contato.`;
  }

  if (/^(o que e|o que é|como funciona)\s+(o\s+)?(modo\s+)?familia\b/.test(t)) {
    return explainBlock();
  }

  if (/^(esquece|remove|apaga)\s+familia\s+(.+)$/.test(t)) {
    const name = text
      .replace(/^(esquece|remove|apaga)\s+fam[ií]lia\s+/i, "")
      .trim();
    return removeFamilyContact(db, input.userId, name);
  }

  const save = parseFamilySave(text);
  if (save) {
    if (save.phone) {
      const r = await upsertFamilyContact(db, input.userId, {
        name: save.name,
        phone: save.phone,
        via: "typed",
      });
      return r.reply;
    }
    await setAwaitingFamilyContact(db, input.userId, true, save.name);
    return [
      `Perfeito — vou colocar *${save.name}* na família.`,
      "",
      "📎 Agora manda o *contato* (📎 → Contato).",
      `_Ou:_ família ${save.name} 61 99999-0000`,
    ].join("\n");
  }

  if (
    /^(familia|modo familia|lista familia|meus contatos familia)\s*\?*$/.test(t)
  ) {
    await setAwaitingFamilyContact(db, input.userId, true);
    const contacts = await listFamilyContacts(db, input.userId);
    if (!contacts.length) {
      return [
        explainBlock(),
        "",
        "────────────",
        "📎 *Agora:* manda o *contato* (📎 → Contato).",
        "Estou esperando…",
      ].join("\n");
    }
    const lines = contacts.map((c) => {
      const ok = c.linkedUserId
        ? "✅ Assessor (lembrete completo)"
        : "📲 aviso se ela já falou comigo";
      return `• *${c.name}* · ${ok}`;
    });
    return [
      "👨‍👩‍👧 *Sua família*",
      ...lines,
      "",
      "📎 Manda outro *contato* pra adicionar.",
      "_Uso:_ “me lembra … — *avisa a Nome também*”",
    ].join("\n");
  }

  await setAwaitingFamilyContact(db, input.userId, true);
  return [
    explainBlock(),
    "",
    "📎 Manda o *contato* agora, ou digite o número.",
  ].join("\n");
}

export type ShareReminderResult = {
  shared: string[];
  pendingInvite: string[];
  unknown: string[];
  unknownGroups: string[];
  emptyGroups: string[];
  note: string;
};

function formatFamilyNudge(
  from: string,
  title: string,
  whenTxt: string,
  groupName?: string
): string {
  return [
    `📩 *Recado de ${from}*`,
    ...(groupName ? [`👥 Grupo: *${groupName}*`, ""] : []),
    title,
    `🗓️ ${whenTxt}`,
    "",
    "_Mensagem encaminhada pelo MOOPE Assessor a pedido desta pessoa._",
  ].join("\n");
}

/** Após criar lembrete — avisa família (Assessor completo OU one-shot se já tem conversa). */
export async function shareReminderToFamily(
  db: Db,
  input: {
    ownerUserId: string;
    ownerWorkspaceId: string;
    ownerDisplayName?: string | null;
    userText?: string | null;
    alsoNotifyNames?: string[] | null;
    title: string;
    fireAt: Date;
    timezone: string;
    recurrenceRule?: string | null;
    payload?: Record<string, unknown> | null;
  }
): Promise<ShareReminderResult> {
  const names = [
    ...(input.alsoNotifyNames || []),
    ...parseAlsoNotifyNames(input.userText || ""),
  ]
    .map((n) => n.trim())
    .filter(Boolean);
  const uniqueNames = [...new Set(names.map((n) => foldName(n)))].map(
    (key) => names.find((n) => foldName(n) === key)!
  );
  const requestedGroups = [
    ...parseAlsoNotifyGroups(input.userText || ""),
  ];

  if (!uniqueNames.length && !requestedGroups.length) {
    return {
      shared: [],
      pendingInvite: [],
      unknown: [],
      unknownGroups: [],
      emptyGroups: [],
      note: "",
    };
  }

  const { DateTime } = await import("luxon");
  const whenTxt = DateTime.fromJSDate(input.fireAt)
    .setZone(input.timezone || "America/Sao_Paulo")
    .toFormat("dd/LL · HH:mm");

  const contacts = await listFamilyContacts(db, input.ownerUserId);
  const groups = await listContactGroups(db, input.ownerUserId);
  const shared: string[] = [];
  const pendingInvite: string[] = [];
  const unknown: string[] = [];
  const unknownGroups: string[] = [];
  const emptyGroups: string[] = [];
  const from =
    String(input.ownerDisplayName || "").trim().split(/\s+/)[0] || "alguém";

  const targets = new Map<string, { contact: FamilyContact; groupName?: string }>();
  for (const name of uniqueNames) {
    const contact = findContactByName(contacts, name);
    if (!contact) {
      unknown.push(name);
      continue;
    }
    targets.set(contact.phoneE164, { contact });
  }
  for (const requestedName of requestedGroups) {
    const group = groups.find(
      (candidate) => foldName(candidate.name) === foldName(requestedName)
    );
    if (!group) {
      unknownGroups.push(requestedName);
      continue;
    }
    const members = contacts.filter((contact) =>
      group.memberPhones.includes(contact.phoneE164)
    );
    if (!members.length) emptyGroups.push(group.name);
    for (const contact of members) {
      const current = targets.get(contact.phoneE164);
      targets.set(contact.phoneE164, {
        contact,
        groupName: current?.groupName || group.name,
      });
    }
  }

  for (const target of targets.values()) {
    const { contact, groupName } = target;
    const linked = await resolveLinkedIds(db, contact.phoneE164);
    if (linked.linkedUserId && linked.linkedWorkspaceId) {
      contact.linkedUserId = linked.linkedUserId;
      contact.linkedWorkspaceId = linked.linkedWorkspaceId;
      const all = await listFamilyContacts(db, input.ownerUserId);
      const i = all.findIndex((c) => c.phoneE164 === contact.phoneE164);
      if (i >= 0) {
        all[i] = contact;
        await saveFamilyContacts(db, input.ownerUserId, all);
      }

      const sharedTitle = `Recado de ${from}: ${input.title}`.slice(0, 500);
      const payload = {
        ...(input.payload || {}),
        shared_from: { user_id: input.ownerUserId, name: from },
        family_share: true,
        ...(groupName ? { shared_group: groupName } : {}),
        emoji: "📩",
      };

      const [row] = await db
        .insert(reminders)
        .values({
          workspaceId: linked.linkedWorkspaceId,
          userId: linked.linkedUserId,
          title: sharedTitle,
          fireAt: input.fireAt,
          timezone: input.timezone,
          status: "scheduled",
          deliveryChannel: "whatsapp",
          recurrenceRule: input.recurrenceRule || null,
          payload,
          nextAttemptAt: input.fireAt,
        })
        .returning();

      const { ensureReminderOutbox, reminderOccurrenceKey } = await import(
        "@/domain/alert-delivery"
      );
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

      shared.push(contact.name);
      continue;
    }

    // Sem Assessor completo: one-shot se já tem conversa Zernio
    const conv = await findConversationForPhone(db, contact.phoneE164);
    if (conv) {
      // Agenda lembrete “fantasma” no workspace do DONO com payload pra disparar one-shot
      // Mais simples: cria reminder no owner workspace tagged family_oneshot
      const [row] = await db
        .insert(reminders)
        .values({
          workspaceId: input.ownerWorkspaceId,
          userId: input.ownerUserId,
          title: `[família→${contact.name}] ${input.title}`.slice(0, 500),
          fireAt: input.fireAt,
          timezone: input.timezone,
          status: "scheduled",
          deliveryChannel: "whatsapp",
          payload: {
            kind: "family_oneshot",
            family_oneshot: true,
            target_phone: contact.phoneE164,
            target_name: contact.name,
            target_external_conversation_id: conv.externalConversationId,
            from_name: from,
            ...(groupName ? { group_name: groupName } : {}),
            real_title: input.title,
            emoji: "📩",
          },
          nextAttemptAt: input.fireAt,
        })
        .returning();

      const { ensureReminderOutbox, reminderOccurrenceKey } = await import(
        "@/domain/alert-delivery"
      );
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

      shared.push(contact.name);
      continue;
    }

    pendingInvite.push(contact.name);
  }

  const parts: string[] = [];
  if (shared.length) {
    parts.push(
      `👨‍👩‍👧 *${shared.join(", ")}* vai receber *Recado de ${from}* no horário`
    );
  }
  if (pendingInvite.length || unknown.length) {
    const wa = await getAssessorWhatsAppPublic();
    const link = wa.waUrl || "o WhatsApp do Assessor";
    if (pendingInvite.length) {
      parts.push(
        `⏳ *${pendingInvite.join(", ")}* nunca falou com o Assessor — WhatsApp bloqueia mensagem fria. Manda: ${link}`
      );
    }
    if (unknown.length) {
      parts.push(
        `❓ *${unknown.join(", ")}* não está na família. Digite *família* e mande o contato 📎`
      );
    }
  }
  if (unknownGroups.length) {
    parts.push(`❓ Não achei o grupo *${unknownGroups.join(", ")}*. Digite *grupos* para conferir.`);
  }
  if (emptyGroups.length) {
    parts.push(
      `👥 O grupo *${emptyGroups.join(", ")}* ainda não tem contatos. Inclua alguém salvo: adicionar Nome ao grupo ${emptyGroups[0]}.`
    );
  }

  return {
    shared,
    pendingInvite,
    unknown,
    unknownGroups,
    emptyGroups,
    note: parts.length ? `\n${parts.join("\n")}` : "",
  };
}

/**
 * No disparo: se for family_oneshot, manda pro Zap da família (não pro dono)
 * e marca sent. Retorna true se consumiu o job.
 */
export async function tryDeliverFamilyOneshot(
  db: Db,
  reminder: {
    id: string;
    title: string;
    fireAt: Date;
    timezone: string;
    payload: Record<string, unknown> | null;
  }
): Promise<{ handled: boolean; ok?: boolean }> {
  const p = (reminder.payload || {}) as Record<string, unknown>;
  if (!p.family_oneshot) return { handled: false };

  const externalId = String(p.target_external_conversation_id || "");
  const from = String(p.from_name || "alguém");
  const groupName = String(p.group_name || "").trim();
  const title = String(p.real_title || reminder.title);
  const { DateTime } = await import("luxon");
  const whenTxt = DateTime.fromJSDate(reminder.fireAt)
    .setZone(reminder.timezone || "America/Sao_Paulo")
    .toFormat("dd/LL · HH:mm");

  if (!externalId) return { handled: true, ok: false };

  const text = formatFamilyNudge(from, title, whenTxt, groupName || undefined);
  const send = await sendProactiveMessage(db, {
    conversationId: externalId,
    message: text,
    idempotencyKey: `family-oneshot:${reminder.id}:${reminder.fireAt.toISOString()}`,
    withinCustomerCareWindow: true,
    forceTemplate: false,
    logicalTemplate: "notification",
    templateParams: [text.slice(0, 900)],
  });

  return { handled: true, ok: send.ok };
}

export async function hasActiveConversation(
  db: Db,
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const conv = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.userId, userId),
      eq(conversations.workspaceId, workspaceId),
      isNull(conversations.deletedAt)
    ),
  });
  return Boolean(conv?.externalConversationId);
}

// silence unused import warning in some builds
void whatsappIdentities;
