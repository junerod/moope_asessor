/**
 * Aviso one-shot para quem NÃO usa o Assessor.
 * Vai no template aprovado do Zernio, com link wa.me do organizador.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { reminders, whatsappIdentities, whatsappTemplates } from "@/db/schema";
import { createWhatsAppTemplateConversation } from "@/channels/zernio/templates-api";
import {
  getCatalogByLogical,
  packSingleBodyParam,
} from "@/domain/whatsapp-templates-catalog";
import { getTemplate, resolveZernioRuntimeConfig } from "@/domain/providers";
import { findContactByName, listFamilyContacts } from "@/domain/family-contacts";
import { ensureReminderOutbox, reminderOccurrenceKey } from "@/domain/alert-delivery";
import { logger } from "@/lib/logger";

export function localStatusFromZernio(status: string): string {
  const meta = String(status || "").toUpperCase();
  if (meta === "APPROVED") return "active";
  if (meta === "PENDING") return "pending";
  return meta.toLowerCase();
}

async function refreshUtilityTemplateStatus(
  db: Db,
  config: { apiKey: string; apiUrl: string; accountId: string }
): Promise<void> {
  const { listWhatsAppTemplates } = await import("@/channels/zernio/templates-api");
  const listed = await listWhatsAppTemplates({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    accountId: config.accountId,
  });
  if (!listed.ok) return;
  for (const logical of ["reminder", "notification"] as const) {
    const catalog = getCatalogByLogical(logical);
    if (!catalog) continue;
    const hit = listed.templates.find((row) => row.name === catalog.name);
    if (!hit) continue;
    const status = localStatusFromZernio(hit.status);
    await db
      .update(whatsappTemplates)
      .set({
        status,
        lastSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(whatsappTemplates.logicalName, logical));
  }
}

function digits(phone: string): string {
  return String(phone || "").replace(/\D/g, "");
}

export function organizerChatUrl(phoneE164: string, opener = "Oi"): string | null {
  const d = digits(phoneE164);
  if (d.length < 10) return null;
  return `https://wa.me/${d}?text=${encodeURIComponent(opener)}`;
}

export function withOrganizerChat(
  body: string,
  ownerName: string,
  ownerPhone: string | null | undefined
): string {
  const name = String(ownerName || "").trim().split(/\s+/)[0] || "mim";
  const url = organizerChatUrl(ownerPhone || "", `Oi, ${name}`);
  if (!url) return String(body || "").trim();
  return [String(body || "").trim(), "", `Fale com ${name}:`, url].join("\n");
}

export async function ownerPhoneE164(db: Db, userId: string): Promise<string | null> {
  const identity = await db.query.whatsappIdentities.findFirst({
    where: eq(whatsappIdentities.userId, userId),
  });
  const phone = String(identity?.phoneE164 || "").trim();
  return phone || null;
}

export async function sendApprovedUtilityNotice(
  db: Db,
  input: { phoneE164: string; body: string; idempotencyKey: string }
): Promise<{ ok: boolean; error?: string }> {
  const config = await resolveZernioRuntimeConfig(db);
  if (config.mock) return { ok: false, error: "zernio_not_configured" };

  await refreshUtilityTemplateStatus(db, config);

  for (const logical of ["reminder", "notification"] as const) {
    const template = await getTemplate(db, logical);
    const catalog = getCatalogByLogical(logical);
    if (!catalog || catalog.category !== "UTILITY") continue;
    const status = String(template?.status || "").toLowerCase();
    if (status === "rejected") continue;
    const templateName = template?.providerTemplateName || catalog.name;
    const sent = await createWhatsAppTemplateConversation(
      {
        phoneE164: input.phoneE164,
        templateName,
        templateLanguage: template?.language || catalog.language,
        templateParams: packSingleBodyParam(input.body),
        idempotencyKey: `${input.idempotencyKey}:${logical}`,
        accountId: config.accountId,
      },
      {
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        accountId: config.accountId,
        mock: config.mock,
      }
    );
    if (sent.ok) return { ok: true };
    logger.warn("desk_utility_notice_failed", {
      logical,
      templateName,
      localStatus: status || null,
      error: sent.error || null,
      http: sent.status,
    });
  }

  const { findConversationForPhone } = await import("@/domain/family-contacts");
  const conv = await findConversationForPhone(db, input.phoneE164);
  if (conv?.externalConversationId) {
    const { sendProactiveMessage } = await import("@/channels/zernio/proactive");
    const fallback = await sendProactiveMessage(db, {
      conversationId: conv.externalConversationId,
      message: input.body,
      idempotencyKey: `${input.idempotencyKey}:ff`,
      withinCustomerCareWindow: true,
      forceTemplate: false,
    });
    if (fallback.ok) return { ok: true };
  }

  return { ok: false, error: "approved_utility_template_unavailable" };
}

async function scheduleDeskNotice(
  db: Db,
  input: {
    ownerUserId: string;
    ownerWorkspaceId: string;
    ownerName: string;
    ownerPhone: string | null;
    contactName: string;
    contactPhone: string;
    body: string;
    fireAt: Date;
    timezone: string;
    kind: string;
  }
): Promise<void> {
  const [row] = await db
    .insert(reminders)
    .values({
      workspaceId: input.ownerWorkspaceId,
      userId: input.ownerUserId,
      title: `[aviso→${input.contactName}] ${input.body}`.slice(0, 500),
      fireAt: input.fireAt,
      timezone: input.timezone,
      status: "scheduled",
      deliveryChannel: "whatsapp",
      requiresTemplate: true,
      templateName: "assessor_reminder",
      payload: {
        kind: "desk_external_oneshot",
        desk_external_oneshot: true,
        team_external_oneshot: true,
        team_owner_user_id: input.ownerUserId,
        target_phone: input.contactPhone,
        target_name: input.contactName,
        from_name: input.ownerName,
        owner_phone: input.ownerPhone,
        notice_body: input.body,
        real_title: input.body,
        notice_kind: input.kind,
      },
      nextAttemptAt: input.fireAt,
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
}

export async function sendDeskNoticeToContacts(
  db: Db,
  input: {
    ownerUserId: string;
    ownerWorkspaceId: string;
    ownerName: string;
    names: string[];
    body: string;
    fireAt: Date;
    timezone: string;
    kind: "charge" | "meeting_notice";
    whenLabel?: string;
  }
): Promise<string> {
  const contacts = await listFamilyContacts(db, input.ownerUserId);
  const ownerPhone = await ownerPhoneE164(db, input.ownerUserId);
  const ownerName = String(input.ownerName || "").trim().split(/\s+/)[0] || "Alguém";
  const notice = withOrganizerChat(input.body, ownerName, ownerPhone);
  const soon = input.fireAt.getTime() <= Date.now() + 2 * 60 * 1000;
  const sent: string[] = [];
  const scheduled: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const rawName of input.names) {
    const name = String(rawName || "").trim();
    if (!name) continue;
    const contact = findContactByName(contacts, name);
    if (!contact) {
      skipped.push(`*${name}* (sem contato)`);
      continue;
    }
    if (ownerPhone && digits(contact.phoneE164) === digits(ownerPhone)) {
      skipped.push(`*${contact.name}* (é você)`);
      continue;
    }
    if (contact.reminderConsent?.status === "opted_out") {
      skipped.push(`*${contact.name}* (pediu para não receber)`);
      continue;
    }

    if (soon) {
      const result = await sendApprovedUtilityNotice(db, {
        phoneE164: contact.phoneE164,
        body: notice,
        idempotencyKey: `desk-notice:${input.ownerUserId}:${digits(contact.phoneE164)}:${Date.now()}`,
      });
      if (result.ok) sent.push(contact.name);
      else failed.push(contact.name);
      continue;
    }

    await scheduleDeskNotice(db, {
      ownerUserId: input.ownerUserId,
      ownerWorkspaceId: input.ownerWorkspaceId,
      ownerName,
      ownerPhone,
      contactName: contact.name,
      contactPhone: contact.phoneE164,
      body: input.body,
      fireAt: input.fireAt,
      timezone: input.timezone,
      kind: input.kind,
    });
    scheduled.push(contact.name);
  }

  const when = String(input.whenLabel || "").trim();

  const lines: string[] = [];
  if (sent.length) {
    lines.push(`Mandei o aviso para *${sent.join(" e ")}* pelo WhatsApp.`);
    if (ownerPhone) {
      const url = organizerChatUrl(ownerPhone, `Oi, ${ownerName}`);
      if (url) {
        lines.push("Ele fala com você neste link:");
        lines.push(url);
      }
    }
  }
  if (scheduled.length) {
    lines.push(
      `Vou avisar *${scheduled.join(" e ")}*${when ? ` ${when}` : ""}, pelo WhatsApp.`
    );
    lines.push("Ele abre conversa com você, não comigo.");
  }
  if (failed.length) {
    lines.push(
      `Não saiu para *${failed.join(" e ")}*. O modelo do WhatsApp está fora.`
    );
  }
  if (skipped.length) {
    lines.push(`Não mandei para ${skipped.join(", ")}.`);
  }
  if (!sent.length && !scheduled.length && !failed.length && !skipped.length) {
    lines.push("Não achei ninguém para avisar. Manda o número com DDD.");
  }
  return lines.join("\n");
}
