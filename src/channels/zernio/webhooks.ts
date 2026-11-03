/**
 * Zernio Webhooks API — create/list/update via API Key.
 * Docs: POST/GET/PUT /v1/webhooks/settings
 */

import { normalizeZernioApiUrl } from "./accounts";

export type ZernioWebhookSettings = {
  id: string;
  name: string;
  url: string;
  secret?: string | null;
  events: string[];
  is_active: boolean;
};

const ASSESSOR_EVENTS = [
  "message.received",
  "message.edited",
  "message.deleted",
  "message.sent",
  "message.delivered",
  "message.read",
  "message.failed",
  "account.connected",
  "account.disconnected",
] as const;

export const MOOPE_ASSESSOR_WEBHOOK_NAME = "MOOPE Meu Assessor";

function parseWebhook(raw: Record<string, unknown>): ZernioWebhookSettings | null {
  const id = String(raw._id || raw.id || "").trim();
  const url = String(raw.url || "").trim();
  if (!id || !url) return null;
  const events = Array.isArray(raw.events)
    ? raw.events.map((e) => String(e))
    : [];
  return {
    id,
    name: String(raw.name || ""),
    url,
    secret: raw.secret != null ? String(raw.secret) : null,
    events,
    is_active: raw.isActive !== false && raw.is_active !== false,
  };
}

async function zernioJson(
  input: {
    apiKey: string;
    apiUrl?: string;
    method: string;
    path: string;
    body?: unknown;
    timeoutMs?: number;
  }
): Promise<
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: string; errorCode: string; data?: unknown }
> {
  const base = normalizeZernioApiUrl(input.apiUrl);
  try {
    const res = await fetch(`${base}${input.path}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json",
        ...(input.body != null
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: input.body != null ? JSON.stringify(input.body) : undefined,
      signal: AbortSignal.timeout(input.timeoutMs ?? 20000),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        error: "Chave Zernio inválida ou sem permissão de webhooks.",
        errorCode: "invalid_credentials",
        data,
      };
    }
    if (!res.ok) {
      const msg =
        typeof data === "object" &&
        data &&
        "error" in data &&
        typeof (data as { error?: unknown }).error === "string"
          ? String((data as { error: string }).error)
          : typeof data === "object" &&
              data &&
              "message" in data &&
              typeof (data as { message?: unknown }).message === "string"
            ? String((data as { message: string }).message)
            : `Zernio HTTP ${res.status}`;
      return {
        ok: false,
        status: res.status,
        error: msg,
        errorCode: "provider_error",
        data,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    const timeout = /abort|timeout/i.test(msg);
    return {
      ok: false,
      status: 0,
      error: timeout ? "Zernio não respondeu a tempo." : "Zernio inacessível.",
      errorCode: timeout ? "timeout" : "provider_error",
    };
  }
}

export async function listZernioWebhooks(input: {
  apiKey: string;
  apiUrl?: string;
  timeoutMs?: number;
}): Promise<
  | { ok: true; webhooks: ZernioWebhookSettings[] }
  | { ok: false; status: number; error: string; errorCode: string }
> {
  const res = await zernioJson({
    ...input,
    method: "GET",
    path: "/webhooks/settings",
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.error,
      errorCode: res.errorCode,
    };
  }
  const root = res.data as Record<string, unknown> | unknown[];
  let list: unknown[] = [];
  if (Array.isArray(root)) list = root;
  else if (root && typeof root === "object") {
    if (Array.isArray((root as { webhooks?: unknown[] }).webhooks)) {
      list = (root as { webhooks: unknown[] }).webhooks;
    } else if (Array.isArray((root as { data?: unknown[] }).data)) {
      list = (root as { data: unknown[] }).data;
    } else if (
      (root as { webhook?: unknown }).webhook &&
      typeof (root as { webhook: unknown }).webhook === "object"
    ) {
      list = [(root as { webhook: unknown }).webhook];
    }
  }
  const webhooks = list
    .map((item) =>
      item && typeof item === "object"
        ? parseWebhook(item as Record<string, unknown>)
        : null
    )
    .filter((w): w is ZernioWebhookSettings => Boolean(w));
  return { ok: true, webhooks };
}

export async function createZernioWebhook(input: {
  apiKey: string;
  apiUrl?: string;
  timeoutMs?: number;
  name: string;
  url: string;
  secret: string;
  events?: string[];
}): Promise<
  | { ok: true; webhook: ZernioWebhookSettings }
  | { ok: false; status: number; error: string; errorCode: string }
> {
  const res = await zernioJson({
    apiKey: input.apiKey,
    apiUrl: input.apiUrl,
    timeoutMs: input.timeoutMs,
    method: "POST",
    path: "/webhooks/settings",
    body: {
      name: input.name.slice(0, 50),
      url: input.url.trim(),
      secret: input.secret,
      events: input.events?.length ? input.events : [...ASSESSOR_EVENTS],
      isActive: true,
    },
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.error,
      errorCode: res.errorCode,
    };
  }
  const root = res.data as Record<string, unknown>;
  const raw =
    (root?.webhook as Record<string, unknown> | undefined) ||
    (root?.data as Record<string, unknown> | undefined) ||
    root;
  const webhook = raw ? parseWebhook(raw) : null;
  if (!webhook) {
    return {
      ok: false,
      status: 502,
      error: "Zernio criou webhook mas a resposta veio incompleta.",
      errorCode: "provider_error",
    };
  }
  return { ok: true, webhook };
}

export async function updateZernioWebhook(input: {
  apiKey: string;
  apiUrl?: string;
  timeoutMs?: number;
  id: string;
  name?: string;
  url?: string;
  secret?: string;
  events?: string[];
  isActive?: boolean;
}): Promise<
  | { ok: true; webhook: ZernioWebhookSettings }
  | { ok: false; status: number; error: string; errorCode: string }
> {
  const body: Record<string, unknown> = { _id: input.id };
  if (input.name) body.name = input.name.slice(0, 50);
  if (input.url) body.url = input.url.trim();
  if (input.secret) body.secret = input.secret;
  if (input.events) body.events = input.events;
  if (input.isActive != null) body.isActive = input.isActive;

  const res = await zernioJson({
    apiKey: input.apiKey,
    apiUrl: input.apiUrl,
    timeoutMs: input.timeoutMs,
    method: "PUT",
    path: "/webhooks/settings",
    body,
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.error,
      errorCode: res.errorCode,
    };
  }
  const root = res.data as Record<string, unknown>;
  const raw =
    (root?.webhook as Record<string, unknown> | undefined) ||
    (root?.data as Record<string, unknown> | undefined) ||
    root;
  const webhook = raw ? parseWebhook(raw) : null;
  if (!webhook) {
    return {
      ok: false,
      status: 502,
      error: "Zernio atualizou webhook mas a resposta veio incompleta.",
      errorCode: "provider_error",
    };
  }
  return { ok: true, webhook };
}

export function isPublicWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/i.test(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent: find webhook by URL (or name) and update; otherwise create.
 */
export async function ensureAssessorWebhook(input: {
  apiKey: string;
  apiUrl?: string;
  timeoutMs?: number;
  webhookUrl: string;
  secret: string;
}): Promise<
  | {
      ok: true;
      action: "created" | "updated";
      webhook: ZernioWebhookSettings;
      public_url: boolean;
    }
  | { ok: false; status: number; error: string; errorCode: string }
> {
  const url = input.webhookUrl.trim();
  if (!url) {
    return {
      ok: false,
      status: 400,
      error: "Informe a URL pública do webhook.",
      errorCode: "missing_url",
    };
  }
  const publicUrl = isPublicWebhookUrl(url);
  if (!publicUrl) {
    return {
      ok: false,
      status: 400,
      error:
        "A Zernio precisa de uma URL pública (HTTPS). localhost não recebe webhook. Defina APP_BASE_URL com um túnel/domínio público.",
      errorCode: "local_url_not_reachable",
    };
  }

  const listed = await listZernioWebhooks(input);
  if (!listed.ok) return listed;

  const existing =
    listed.webhooks.find(
      (w) => w.url.replace(/\/+$/, "") === url.replace(/\/+$/, "")
    ) ||
    listed.webhooks.find((w) => w.name === MOOPE_ASSESSOR_WEBHOOK_NAME) ||
    null;

  if (existing) {
    const updated = await updateZernioWebhook({
      ...input,
      id: existing.id,
      name: MOOPE_ASSESSOR_WEBHOOK_NAME,
      url,
      secret: input.secret,
      events: [...ASSESSOR_EVENTS],
      isActive: true,
    });
    if (!updated.ok) return updated;
    return {
      ok: true,
      action: "updated",
      webhook: updated.webhook,
      public_url: true,
    };
  }

  const created = await createZernioWebhook({
    ...input,
    name: MOOPE_ASSESSOR_WEBHOOK_NAME,
    url,
    secret: input.secret,
    events: [...ASSESSOR_EVENTS],
  });
  if (!created.ok) return created;
  return {
    ok: true,
    action: "created",
    webhook: created.webhook,
    public_url: true,
  };
}
