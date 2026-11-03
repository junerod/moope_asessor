/**
 * Zernio WhatsApp Templates API (create / list / send).
 */
import { getEnv } from "@/config/env";
import { logger } from "@/lib/logger";
import { sanitizeTemplateParams } from "@/lib/whatsapp-template-params";

function normalizeBaseUrl(raw: string): string {
  let s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) s = "https://zernio.com/api/v1";
  if (/\/api$/i.test(s)) return `${s}/v1`;
  if (/zernio\.com$/i.test(s)) return `${s}/api/v1`;
  return s;
}

async function parseJsonSafe(text: string): Promise<unknown> {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text.slice(0, 400) };
  }
}

export type ZernioTemplateCreds = {
  apiKey: string;
  apiUrl?: string;
  accountId: string;
  timeoutMs?: number;
  mock?: boolean;
};

function resolveCreds(overrides?: Partial<ZernioTemplateCreds>): ZernioTemplateCreds {
  const env = getEnv();
  const apiKey = overrides?.apiKey || env.ZERNIO_API_KEY || "";
  const accountId = overrides?.accountId || env.ZERNIO_ACCOUNT_ID || "";
  return {
    apiKey,
    accountId,
    apiUrl: normalizeBaseUrl(overrides?.apiUrl || env.ZERNIO_API_URL),
    timeoutMs: overrides?.timeoutMs ?? env.ZERNIO_TIMEOUT_MS ?? 20000,
  };
}

async function zernioFetch(
  creds: ZernioTemplateCreds,
  path: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!creds.apiKey || !creds.accountId) {
    return {
      ok: false,
      status: 400,
      data: { error: "zernio_credentials_missing" },
    };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), creds.timeoutMs || 20000);
  try {
    const res = await fetch(`${creds.apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: ac.signal,
    });
    const text = await res.text();
    const data = await parseJsonSafe(text);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: {
        error: err instanceof Error ? err.message : "zernio_unreachable",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export type ListedTemplate = {
  id?: string;
  name: string;
  status: string;
  category?: string;
  language?: string;
  components?: unknown[];
  reason?: string;
};

export async function listWhatsAppTemplates(
  overrides?: Partial<ZernioTemplateCreds> & { status?: string; name?: string }
): Promise<{ ok: boolean; templates: ListedTemplate[]; error?: string; raw?: unknown }> {
  const creds = resolveCreds(overrides);
  const qs = new URLSearchParams({ accountId: creds.accountId });
  if (overrides?.status) qs.set("status", overrides.status);
  if (overrides?.name) qs.set("name", overrides.name);
  const res = await zernioFetch(creds, `/whatsapp/templates?${qs}`, {
    method: "GET",
  });
  if (!res.ok) {
    return {
      ok: false,
      templates: [],
      error: `list_${res.status}`,
      raw: res.data,
    };
  }
  const record = res.data as Record<string, unknown> | null;
  const templates = (record?.templates || []) as ListedTemplate[];
  return { ok: true, templates, raw: res.data };
}

export async function createWhatsAppTemplate(
  body: Record<string, unknown>,
  overrides?: Partial<ZernioTemplateCreds>
): Promise<{
  ok: boolean;
  status: number;
  template?: ListedTemplate;
  error?: string;
  raw?: unknown;
}> {
  const creds = resolveCreds(overrides);
  const payload = { ...body, accountId: body.accountId || creds.accountId };
  const res = await zernioFetch(creds, "/whatsapp/templates", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const record = res.data as Record<string, unknown> | null;
  const template = (record?.template || record) as ListedTemplate | undefined;
  if (!res.ok) {
    logger.warn("zernio_template_create_failed", {
      status: res.status,
      name: body.name,
    });
    return {
      ok: false,
      status: res.status,
      error: `create_${res.status}`,
      raw: res.data,
    };
  }
  return { ok: true, status: res.status, template, raw: res.data };
}

export type SendTemplateInput = {
  conversationId: string;
  templateName: string;
  templateLanguage: string;
  templateParams: string[];
  idempotencyKey: string;
  accountId?: string;
};

export type CreateTemplateConversationInput = {
  phoneE164: string;
  templateName: string;
  templateLanguage: string;
  templateParams: string[];
  idempotencyKey: string;
  accountId?: string;
};

export async function createWhatsAppTemplateConversation(
  input: CreateTemplateConversationInput,
  overrides?: Partial<ZernioTemplateCreds>
): Promise<{
  ok: boolean;
  mocked?: boolean;
  status: number;
  conversationId?: string;
  externalMessageId?: string;
  error?: string;
}> {
  const participantId = String(input.phoneE164 || "").replace(/\D/g, "");
  if (!/^\d{10,15}$/.test(participantId)) {
    return { ok: false, status: 400, error: "invalid_recipient_phone" };
  }
  if (!/^[a-z][a-z0-9_]{0,100}$/.test(input.templateName)) {
    return { ok: false, status: 400, error: "invalid_template_name" };
  }
  if (!input.templateLanguage.trim()) {
    return { ok: false, status: 400, error: "invalid_template_language" };
  }

  const creds = resolveCreds(overrides);
  const env = getEnv();
  const mock =
    overrides?.mock ??
    (env.ZERNIO_MOCK || !creds.apiKey || !creds.accountId);
  if (mock) {
    return {
      ok: true,
      mocked: true,
      status: 201,
      conversationId: `mock_conv_${input.idempotencyKey}`,
      externalMessageId: `mock_tpl_${input.idempotencyKey}`,
    };
  }

  const res = await zernioFetch(creds, "/inbox/conversations", {
    method: "POST",
    headers: { "Idempotency-Key": input.idempotencyKey },
    body: JSON.stringify({
      accountId: input.accountId || creds.accountId,
      participantId,
      templateName: input.templateName,
      templateLanguage: input.templateLanguage,
      templateParams: sanitizeTemplateParams(input.templateParams),
    }),
  });
  if (!res.ok) {
    logger.warn("zernio_template_conversation_failed", {
      status: res.status,
      templateName: input.templateName,
      data: res.data,
    });
    return {
      ok: false,
      status: res.status,
      error: "zernio_template_conversation_failed",
    };
  }

  const root = res.data as Record<string, unknown> | null;
  const nested = (root?.data as Record<string, unknown> | undefined) || root || {};
  const conversation = (nested.conversation as Record<string, unknown> | undefined) || {};
  const message = (nested.message as Record<string, unknown> | undefined) || {};
  const conversationId = String(
    nested.conversationId || conversation.id || conversation._id || root?.conversationId || ""
  );
  const externalMessageId = String(
    nested.messageId ||
      nested.externalMessageId ||
      message.id ||
      message._id ||
      message.messageId ||
      ""
  );
  return {
    ok: true,
    status: res.status,
    conversationId: conversationId || undefined,
    externalMessageId: externalMessageId || undefined,
  };
}

export async function sendWhatsAppTemplateMessage(
  input: SendTemplateInput,
  overrides?: Partial<ZernioTemplateCreds>
): Promise<{
  ok: boolean;
  mocked?: boolean;
  status: number;
  externalMessageId?: string;
  error?: string;
  data?: unknown;
}> {
  const creds = resolveCreds(overrides);
  const env = getEnv();
  const mock =
    overrides?.mock ??
    (env.ZERNIO_MOCK || !creds.apiKey || !creds.accountId);

  const params = sanitizeTemplateParams(input.templateParams);

  if (mock) {
    return {
      ok: true,
      mocked: true,
      status: 200,
      externalMessageId: `mock_tpl_${input.idempotencyKey}`,
      data: {
        templateName: input.templateName,
        templateParams: params,
      },
    };
  }

  const res = await zernioFetch(
    creds,
    `/inbox/conversations/${encodeURIComponent(input.conversationId)}/messages`,
    {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        accountId: input.accountId || creds.accountId,
        templateName: input.templateName,
        templateLanguage: input.templateLanguage,
        templateParams: params,
      }),
    }
  );

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: "zernio_template_send_failed",
      data: res.data,
    };
  }

  const record = res.data as Record<string, unknown> | null;
  const messageObj =
    (record?.message as Record<string, unknown> | undefined) ||
    (record?.data as Record<string, unknown> | undefined) ||
    record;
  const externalMessageId =
    (messageObj &&
      (String(messageObj._id || messageObj.id || messageObj.messageId || "") ||
        undefined)) ||
    undefined;

  return {
    ok: true,
    status: res.status,
    externalMessageId,
    data: res.data,
  };
}
