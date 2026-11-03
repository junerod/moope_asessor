import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  conversations,
  messages,
  webhookEvents,
  users,
  whatsappChannels,
} from "@/db/schema";
import {
  isInboundMessageEvent,
  parseZernioWebhook,
  resolveZernioIdentity,
  verifyZernioSignature,
} from "@/channels/zernio";
import { createZernioClient } from "@/channels/zernio/client";
import { getEnv } from "@/config/env";
import { newCorrelationId } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import {
  findWhatsappIdentity,
  upsertUnknownIdentity,
} from "@/domain/whatsapp-identities";
import { getPersonalWorkspaceForUser } from "@/domain/workspaces";
import { enqueueAgentJob } from "@/domain/jobs";
import { resolveZernioRuntimeConfig } from "@/domain/providers";
import {
  findChannelByProviderAccountId,
  resolveInboundAssistantChannel,
} from "@/domain/whatsapp-channels";
import {
  isFinanceCustomerReminder,
  outboundDirection,
} from "@/channels/zernio/finance-reminder";

export type InboundWebhookResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function handleZernioWebhook(
  db: Db,
  input: {
    rawBody: string;
    signature: string | null;
    eventIdHeader?: string | null;
  }
): Promise<InboundWebhookResult> {
  const env = getEnv();
  const correlationId = newCorrelationId();
  const log = logger.child({ correlation_id: correlationId });

  const zernioCfg = await resolveZernioRuntimeConfig(db);
  const webhookSecret = zernioCfg.webhookSecret || env.ZERNIO_WEBHOOK_SECRET;

  const signatureValid = verifyZernioSignature({
    secret: webhookSecret,
    rawBody: input.rawBody,
    presented: input.signature,
  });

  if (!signatureValid) {
    log.warn("zernio_webhook_invalid_signature");
    return {
      ok: false,
      status: 401,
      body: { error: "invalid_signature" },
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, status: 400, body: { error: "invalid_json" } };
  }

  const normalized = parseZernioWebhook(payload);
  if (!normalized) {
    return { ok: false, status: 400, body: { error: "unrecognized_payload" } };
  }

  const externalEventId =
    normalized.eventId || input.eventIdHeader || correlationId;

  try {
    const inserted = await db
      .insert(webhookEvents)
      .values({
        provider: "zernio",
        externalEventId,
        eventType: normalized.eventType,
        status: "received",
        signatureValid: true,
        payload: normalized.raw,
        headers: {
          event_id: input.eventIdHeader ?? null,
        },
        correlationId,
      })
      .onConflictDoNothing({
        target: [webhookEvents.provider, webhookEvents.externalEventId],
      })
      .returning();

    if (!inserted.length) {
      log.info("zernio_webhook_duplicate", {
        external_event_id: externalEventId,
      });
      return {
        ok: true,
        status: 200,
        body: { ok: true, duplicate: true },
      };
    }

    const event = inserted[0];

    log.info("zernio_webhook_stored", {
      webhook_event_id: event.id,
      event_type: normalized.eventType,
    });

    if (normalized.eventType === "webhook.test") {
      await db
        .update(webhookEvents)
        .set({ status: "processed", processedAt: new Date() })
        .where(eq(webhookEvents.id, event.id));
      return {
        ok: true,
        status: 200,
        body: { ok: true, duplicate: false, type: "test" },
      };
    }

    const financeReminder =
      outboundDirection(normalized.raw) ||
      isFinanceCustomerReminder(normalized.text);
    if (!isInboundMessageEvent(normalized.eventType) || financeReminder) {
      await db
        .update(webhookEvents)
        .set({
          status: "ignored",
          error: financeReminder ? "finance_reminder_not_assessor" : null,
          processedAt: new Date(),
        })
        .where(eq(webhookEvents.id, event.id));
      if (financeReminder) {
        log.info("zernio_ignored_finance_reminder", {
          event_type: normalized.eventType,
        });
      }
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          ignored: true,
          event: normalized.eventType,
          reason: financeReminder ? "finance_reminder_not_assessor" : undefined,
        },
      };
    }

    let channelGate = await resolveInboundAssistantChannel(
      db,
      normalized.accountId
    );
    // Quem já usa o Assessor e escreve no número antigo (também chamado MOOPE Assessor)
    // não pode ficar sem resposta. Número desconhecido continua ignorado.
    if (
      !channelGate.ok &&
      channelGate.reason === "not_assistant" &&
      normalized.phoneE164
    ) {
      const known = await findWhatsappIdentity(db, {
        phoneE164: normalized.phoneE164,
        bsuid: normalized.bsuid,
      });
      if (known?.status === "paired" && known.userId) {
        const incoming = normalized.accountId
          ? await findChannelByProviderAccountId(db, normalized.accountId)
          : null;
        channelGate = { ok: true, channel: incoming ?? null, bootstrap: false };
        log.info("zernio_inbound_known_user_other_line", {
          account_id: normalized.accountId,
        });
      }
    }
    if (!channelGate.ok) {
      if (
        channelGate.reason === "not_assistant" &&
        isInboundMessageEvent(normalized.eventType) &&
        normalized.conversationId &&
        normalized.phoneE164
      ) {
        try {
          const cfg = await resolveZernioRuntimeConfig(db);
          const client = createZernioClient({
            mock: cfg.mock,
            apiKey: cfg.apiKey,
            apiUrl: cfg.apiUrl,
            accountId: normalized.accountId || cfg.accountId,
          });
          await client.sendText({
            conversationId: normalized.conversationId,
            accountId: normalized.accountId || cfg.accountId,
            idempotencyKey: `not_on_list_${event.id}`,
            message: [
              "👋 Oi! Esse número ainda não está no Assessor.",
              "",
              "Peça para o dono da locadora te incluir, ou configure em *MOOPE Gestão de Frotas*:",
              "Configurações → Meu Assessor",
              "https://frotas.moope.com.br",
            ].join("\n"),
          });
        } catch (err) {
          log.warn("zernio_not_on_list_reply_failed", {
            error: err instanceof Error ? err.message : "send_failed",
          });
        }
      }
      await db
        .update(webhookEvents)
        .set({
          status: "ignored",
          error: channelGate.reason,
          processedAt: new Date(),
        })
        .where(eq(webhookEvents.id, event.id));
      log.info("zernio_inbound_ignored_non_assistant", {
        reason: channelGate.reason,
        account_id: normalized.accountId,
      });
      return {
        ok: true,
        status: 200,
        body: { ok: true, ignored: true, reason: channelGate.reason },
      };
    }
    const receiverChannel = channelGate.channel;
    const outboundAccountId =
      receiverChannel?.providerAccountId ||
      normalized.accountId ||
      zernioCfg.accountId ||
      undefined;

    let identityKeys;
    try {
      identityKeys = resolveZernioIdentity({
        phoneE164: normalized.phoneE164,
        bsuid: normalized.bsuid,
        contactName: normalized.contactName,
      });
    } catch {
      await db
        .update(webhookEvents)
        .set({
          status: "failed",
          error: "identity_missing",
          processedAt: new Date(),
        })
        .where(eq(webhookEvents.id, event.id));
      return {
        ok: false,
        status: 422,
        body: { error: "identity_missing_phone_and_bsuid" },
      };
    }

    const identity = await upsertUnknownIdentity(db, identityKeys);
    const paired =
      identity.status === "paired" && identity.userId
        ? await db.query.users.findFirst({
            where: and(eq(users.id, identity.userId), isNull(users.deletedAt)),
          })
        : null;

    let workspaceId: string | null = null;
    let userId: string | null = null;
    let conversationStatus: "onboarding" | "active" = "onboarding";

    if (paired) {
      userId = paired.id;
      const personal = await getPersonalWorkspaceForUser(db, paired.id);
      workspaceId = personal?.id ?? null;
      conversationStatus = "active";
    }

    let conversation = normalized.conversationId
      ? await db.query.conversations.findFirst({
          where: eq(
            conversations.externalConversationId,
            normalized.conversationId
          ),
        })
      : null;

    if (!conversation) {
      const openForIdentity = await db.query.conversations.findFirst({
        where: and(
          eq(conversations.whatsappIdentityId, identity.id),
          isNull(conversations.deletedAt)
        ),
        orderBy: (c, { desc }) => [desc(c.createdAt)],
      });
      let sameLine = true;
      if (openForIdentity?.whatsappChannelId && normalized.accountId) {
        const openChannel = await db.query.whatsappChannels.findFirst({
          where: eq(whatsappChannels.id, openForIdentity.whatsappChannelId),
        });
        if (
          openChannel?.providerAccountId &&
          openChannel.providerAccountId !== normalized.accountId
        ) {
          sameLine = false;
        }
      }
      if (sameLine) conversation = openForIdentity ?? null;
    }

    if (!conversation) {
      const [created] = await db
        .insert(conversations)
        .values({
          workspaceId,
          userId,
          whatsappIdentityId: identity.id,
          whatsappChannelId: receiverChannel?.id ?? null,
          channel: "whatsapp",
          externalConversationId: normalized.conversationId,
          status: conversationStatus,
          onboardingStep: paired ? "completed" : "awaiting_name",
          lastMessageAt: new Date(),
        })
        .returning();
      conversation = created;
    } else {
      await db
        .update(conversations)
        .set({
          workspaceId: conversation.workspaceId ?? workspaceId,
          userId: conversation.userId ?? userId,
          status: paired ? "active" : conversation.status,
          externalConversationId:
            conversation.externalConversationId ?? normalized.conversationId,
          whatsappChannelId:
            conversation.whatsappChannelId ?? receiverChannel?.id ?? null,
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, conversation.id));
    }

    let messageRow = normalized.messageId
      ? await db.query.messages.findFirst({
          where: eq(messages.externalMessageId, normalized.messageId),
        })
      : null;

    if (!messageRow) {
      const [createdMsg] = await db
        .insert(messages)
        .values({
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId ?? workspaceId,
          direction: "inbound",
          status: "received",
          externalMessageId: normalized.messageId,
          bodyText: normalized.text,
          contentType: normalized.contentType,
          rawPayload: normalized.raw,
          correlationId,
        })
        .returning();
      messageRow = createdMsg;
    }

    const idempotencyKey = `inbound:${externalEventId}`;
    const { job, created } = await enqueueAgentJob(db, {
      jobType: paired ? "inbound_message" : "onboarding_message",
      workspaceId: conversation.workspaceId ?? workspaceId,
      conversationId: conversation.id,
      messageId: messageRow.id,
      webhookEventId: event.id,
      idempotencyKey,
      correlationId,
      payload: {
        paired: Boolean(paired),
        text: normalized.text,
        external_conversation_id: normalized.conversationId,
        account_id: outboundAccountId,
        whatsapp_channel_id: receiverChannel?.id ?? null,
        phone_e164: identity.phoneE164,
        bsuid: identity.bsuid,
        media_url: normalized.mediaUrl,
        media_mime_type: normalized.mediaMimeType,
        content_type: normalized.contentType,
        location: normalized.location,
        shared_contacts: normalized.sharedContacts,
      },
    });

    await db
      .update(webhookEvents)
      .set({ status: "processed", processedAt: new Date() })
      .where(eq(webhookEvents.id, event.id));

    log.info("zernio_inbound_enqueued", {
      webhook_event_id: event.id,
      job_id: job.id,
      conversation_id: conversation.id,
      workspace_id: conversation.workspaceId ?? workspaceId ?? undefined,
      paired: Boolean(paired),
      job_created: created,
      has_media: Boolean(normalized.mediaUrl),
      channel_id: receiverChannel?.id,
    });

    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        duplicate: false,
        job_id: job.id,
        conversation_id: conversation.id,
        paired: Boolean(paired),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    log.error("zernio_webhook_failed", { error: message });
    return {
      ok: false,
      status: 500,
      body: { error: "internal_error" },
    };
  }
}

export async function resolveIdentityLookup(
  db: Db,
  input: { phoneE164?: string | null; bsuid?: string | null }
) {
  return findWhatsappIdentity(db, input);
}
