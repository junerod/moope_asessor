import type { Db } from "@/db/client";
import { createZernioClient } from "@/channels/zernio";
import { sendWhatsAppTemplateMessage } from "@/channels/zernio/templates-api";
import {
  getCatalogByLogical,
  packSingleBodyParam,
} from "@/domain/whatsapp-templates-catalog";
import { getTemplate } from "@/domain/providers";
import { resolveZernioRuntimeConfig } from "@/domain/providers";
import {
  alreadySentSameBody,
  claimOutboundKey,
  isClearReject,
  isUncertainSendFailure,
  looksLikeScheduledSend,
  releaseOutboundKey,
  shouldReleaseSendClaim,
} from "@/domain/send-once";
import { logger } from "@/lib/logger";

export type ProactiveSendInput = {
  conversationId: string;
  message: string;
  idempotencyKey: string;
  accountId?: string;
  forceTemplate?: boolean;
  withinCustomerCareWindow?: boolean;
  logicalTemplate?: string;
  templateParams?: string[];
  /** Admin/force: pode repetir a mesma chave. */
  allowDuplicate?: boolean;
};

export type ProactiveSendResult = {
  ok: boolean;
  mode: "free_form" | "template" | "mock";
  mocked: boolean;
  error?: string;
  errorCode?: string;
  externalMessageId?: string;
  providerTemplateName?: string;
};

function templateIsSendable(status: string | null | undefined): boolean {
  const s = String(status || "").toLowerCase();
  return s === "active" || s === "approved";
}

const inflight = new Map<string, Promise<ProactiveSendResult>>();
const done = new Map<string, ProactiveSendResult>();
const DONE_MAX = 2000;

function rememberDone(key: string, result: ProactiveSendResult) {
  if (done.size >= DONE_MAX) {
    const first = done.keys().next().value;
    if (first) done.delete(first);
  }
  done.set(key, result);
}

export function resetProactiveSendCache() {
  inflight.clear();
  done.clear();
}

export async function sendProactiveMessage(
  db: Db,
  input: ProactiveSendInput
): Promise<ProactiveSendResult> {
  const key = String(input.idempotencyKey || "").trim();
  if (key) {
    const cached = done.get(key);
    if (cached) return cached;
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const run = (async () => {
    if (!input.allowDuplicate && key) {
      const won = await claimOutboundKey(db, key);
      if (!won) {
        logger.info("outbound_already_claimed", { key: key.slice(0, 80) });
        return {
          ok: false,
          mode: "free_form" as const,
          mocked: false,
          error: "claim_held",
          errorCode: "CLAIM_HELD",
        };
      }
    }
    if (
      !input.allowDuplicate &&
      looksLikeScheduledSend(key) &&
      (await alreadySentSameBody(db, {
        conversationId: input.conversationId,
        message: input.message,
      }))
    ) {
      logger.info("outbound_same_body_skipped", { key: key.slice(0, 80) });
      return {
        ok: true,
        mode: "free_form" as const,
        mocked: false,
        errorCode: "ALREADY_SENT",
      };
    }
    const result = await sendProactiveMessageOnce(db, input);
    if (
      key &&
      !input.allowDuplicate &&
      !result.ok &&
      shouldReleaseSendClaim(result)
    ) {
      await releaseOutboundKey(db, key);
    }
    return result;
  })()
    .then((result) => {
      if (key && result.ok && result.errorCode !== "SEND_UNCERTAIN") {
        rememberDone(key, result);
      }
      return result;
    })
    .finally(() => {
      if (key) inflight.delete(key);
    });

  if (key) inflight.set(key, run);
  return run;
}

async function sendProactiveMessageOnce(
  db: Db,
  input: ProactiveSendInput
): Promise<ProactiveSendResult> {
  const cfg = await resolveZernioRuntimeConfig(db);
  const client = createZernioClient({
    mock: cfg.mock,
    apiKey: cfg.apiKey,
    apiUrl: cfg.apiUrl,
    accountId: cfg.accountId,
  });
  const withinWindow =
    input.withinCustomerCareWindow !== false && !input.forceTemplate;

  if (withinWindow) {
    const send = await client.sendText({
      conversationId: input.conversationId,
      message: input.message,
      idempotencyKey: input.idempotencyKey,
      accountId: input.accountId || cfg.accountId,
    });
    const uncertain = !send.ok && isUncertainSendFailure(send);
    return {
      ok: send.ok,
      mode: send.mocked ? "mock" : "free_form",
      mocked: send.mocked,
      error: send.error,
      errorCode: uncertain ? "SEND_UNCERTAIN" : send.ok ? undefined : send.error,
      externalMessageId: send.externalMessageId,
    };
  }

  const logical = input.logicalTemplate || "reminder";
  const template = await getTemplate(db, logical);
  const catalog = getCatalogByLogical(logical);
  const providerName =
    template?.providerTemplateName || catalog?.name || null;
  const language = template?.language || catalog?.language || "pt_BR";

  if (!providerName || !templateIsSendable(template?.status)) {
    logger.warn("proactive_template_missing", {
      logical,
      status: template?.status || null,
      provider: providerName,
    });
    if (logical !== "notification") {
      return sendProactiveMessageOnce(db, {
        ...input,
        logicalTemplate: "notification",
        forceTemplate: true,
        withinCustomerCareWindow: false,
        idempotencyKey: `${input.idempotencyKey}:notif`,
      });
    }
    const fallback = await client.sendText({
      conversationId: input.conversationId,
      message: input.message,
      idempotencyKey: `${input.idempotencyKey}:fallback_ff`,
      accountId: input.accountId || cfg.accountId,
    });
    return {
      ok: fallback.ok,
      mode: fallback.mocked ? "mock" : "free_form",
      mocked: fallback.mocked,
      error: fallback.ok
        ? undefined
        : fallback.error || "template_not_configured",
      errorCode: fallback.ok ? undefined : "TEMPLATE_NOT_CONFIGURED_FALLBACK",
      externalMessageId: fallback.externalMessageId,
    };
  }

  const params =
    input.templateParams && input.templateParams.length
      ? input.templateParams
      : packSingleBodyParam(input.message);

  const send = await sendWhatsAppTemplateMessage(
    {
      conversationId: input.conversationId,
      templateName: providerName,
      templateLanguage: language,
      templateParams: params,
      idempotencyKey: `${input.idempotencyKey}:template`,
      accountId: input.accountId || cfg.accountId,
    },
    {
      apiKey: cfg.apiKey,
      apiUrl: cfg.apiUrl,
      accountId: cfg.accountId,
    }
  );

  if (!send.ok) {
    logger.warn("proactive_template_send_failed", {
      logical,
      provider: providerName,
      status: send.status,
    });
    if (!isClearReject(send)) {
      return {
        ok: false,
        mode: "template",
        mocked: Boolean(send.mocked),
        error: send.error || "template_send_uncertain",
        errorCode: "SEND_UNCERTAIN",
        providerTemplateName: providerName,
      };
    }
    const fallback = await client.sendText({
      conversationId: input.conversationId,
      message: input.message,
      idempotencyKey: `${input.idempotencyKey}:tpl_fail_ff`,
      accountId: input.accountId || cfg.accountId,
    });
    return {
      ok: fallback.ok,
      mode: fallback.mocked ? "mock" : "free_form",
      mocked: Boolean(fallback.mocked),
      error: fallback.ok ? send.error : fallback.error || send.error,
      errorCode: fallback.ok
        ? "TEMPLATE_SEND_FAILED_FALLBACK"
        : "TEMPLATE_SEND_FAILED",
      externalMessageId: fallback.externalMessageId,
      providerTemplateName: providerName,
    };
  }

  return {
    ok: true,
    mode: send.mocked ? "mock" : "template",
    mocked: Boolean(send.mocked),
    externalMessageId: send.externalMessageId,
    providerTemplateName: providerName,
  };
}
