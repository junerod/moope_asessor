import { getEnv } from "@/config/env";
import { logger } from "@/lib/logger";

export type ZernioSendTextInput = {
  conversationId: string;
  message: string;
  idempotencyKey: string;
  accountId?: string;
};

export type ZernioSendMediaInput = {
  conversationId: string;
  attachmentUrl: string;
  attachmentType: "image" | "video" | "audio" | "file";
  message?: string;
  attachmentName?: string;
  idempotencyKey: string;
  accountId?: string;
};

export type ZernioSendResult = {
  ok: boolean;
  mocked: boolean;
  status: number;
  externalMessageId?: string;
  error?: string;
  data?: unknown;
};

export type ZernioTypingInput = {
  conversationId: string;
  accountId?: string;
};

export interface ZernioClient {
  sendText(input: ZernioSendTextInput): Promise<ZernioSendResult>;
  sendMedia(input: ZernioSendMediaInput): Promise<ZernioSendResult>;
  sendTyping(input: ZernioTypingInput): Promise<{ ok: boolean; mocked?: boolean }>;
  uploadMedia(input: {
    buffer: Buffer;
    filename: string;
    mimeType?: string;
  }): Promise<{ ok: boolean; url?: string; error?: string; mocked?: boolean }>;
}

type MockStore = {
  sends: Array<
    (ZernioSendTextInput | ZernioSendMediaInput) & { at: string; kind: string }
  >;
  failNext?: boolean;
};

const globalMock = globalThis as unknown as {
  __zernioMockStore?: MockStore;
};

function mockStore(): MockStore {
  if (!globalMock.__zernioMockStore) {
    globalMock.__zernioMockStore = { sends: [] };
  }
  return globalMock.__zernioMockStore;
}

export function resetZernioMock() {
  globalMock.__zernioMockStore = { sends: [] };
}

export function getZernioMockSends() {
  return [...mockStore().sends];
}

export function setZernioMockFailNext(fail: boolean) {
  mockStore().failNext = fail;
}

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

export function createZernioClient(overrides?: {
  mock?: boolean;
  apiKey?: string;
  apiUrl?: string;
  accountId?: string;
  timeoutMs?: number;
}): ZernioClient {
  const env = getEnv();
  const mock =
    overrides?.mock ??
    (env.ZERNIO_MOCK || !env.ZERNIO_API_KEY || !env.ZERNIO_ACCOUNT_ID);
  const apiKey = overrides?.apiKey ?? env.ZERNIO_API_KEY;
  const apiUrl = normalizeBaseUrl(overrides?.apiUrl ?? env.ZERNIO_API_URL);
  const accountId = overrides?.accountId ?? env.ZERNIO_ACCOUNT_ID;
  const timeoutMs = overrides?.timeoutMs ?? env.ZERNIO_TIMEOUT_MS;

  async function postMessage(
    conversationId: string,
    body: Record<string, unknown>,
    idempotencyKey: string
  ): Promise<ZernioSendResult> {
    if (!apiKey || !accountId) {
      return {
        ok: false,
        mocked: false,
        status: 400,
        error: "zernio_credentials_missing",
      };
    }
    const url = `${apiUrl}/inbox/conversations/${encodeURIComponent(
      conversationId
    )}/messages`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          accountId: body.accountId || accountId,
          ...body,
        }),
        signal: ac.signal,
      });
      const text = await res.text();
      const data = await parseJsonSafe(text);
      if (!res.ok) {
        return {
          ok: false,
          mocked: false,
          status: res.status,
          error: "zernio_send_failed",
          data,
        };
      }
      const record = data as Record<string, unknown> | null;
      const messageObj =
        (record?.message as Record<string, unknown> | undefined) ||
        (record?.data as Record<string, unknown> | undefined) ||
        record;
      const externalMessageId =
        (messageObj &&
          (String(messageObj._id || messageObj.id || "") || undefined)) ||
        undefined;
      return {
        ok: true,
        mocked: false,
        status: res.status,
        externalMessageId,
        data,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "zernio_unreachable";
      return { ok: false, mocked: false, status: 0, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async sendText(input) {
      if (mock) {
        const store = mockStore();
        if (store.failNext) {
          store.failNext = false;
          return {
            ok: false,
            mocked: true,
            status: 500,
            error: "zernio_mock_forced_failure",
          };
        }
        store.sends.push({ ...input, at: new Date().toISOString(), kind: "text" });
        return {
          ok: true,
          mocked: true,
          status: 200,
          externalMessageId: `mock_${input.idempotencyKey}`,
        };
      }
      return postMessage(
        input.conversationId,
        {
          accountId: input.accountId || accountId,
          message: input.message,
        },
        input.idempotencyKey
      );
    },

    async sendTyping(input) {
      if (mock) return { ok: true, mocked: true };
      if (!apiKey || !accountId) return { ok: false };
      const url = `${apiUrl}/inbox/conversations/${encodeURIComponent(
        input.conversationId
      )}/typing`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Math.min(timeoutMs, 5000));
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            accountId: input.accountId || accountId,
          }),
          signal: ac.signal,
        });
        return { ok: res.ok };
      } catch {
        return { ok: false };
      } finally {
        clearTimeout(timer);
      }
    },

    async sendMedia(input) {
      if (mock) {
        const store = mockStore();
        store.sends.push({
          ...input,
          at: new Date().toISOString(),
          kind: "media",
        });
        return {
          ok: true,
          mocked: true,
          status: 200,
          externalMessageId: `mock_media_${input.idempotencyKey}`,
        };
      }
      return postMessage(
        input.conversationId,
        {
          accountId: input.accountId || accountId,
          message: input.message || undefined,
          attachmentUrl: input.attachmentUrl,
          attachmentType: input.attachmentType,
          attachmentName: input.attachmentName || undefined,
        },
        input.idempotencyKey
      );
    },

    async uploadMedia(input) {
      if (mock) {
        return {
          ok: true,
          mocked: true,
          url: `https://zernio.example/mock/${encodeURIComponent(input.filename)}`,
        };
      }
      if (!apiKey) {
        return { ok: false, error: "zernio_credentials_missing" };
      }
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(input.buffer)], {
          type: input.mimeType || "application/octet-stream",
        }),
        input.filename
      );
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        // Prefer upload-direct; fall back to /media/upload
        const endpoints = [
          `${apiUrl}/media/upload-direct`,
          `${apiUrl}/media/upload`,
        ];
        let lastErr = "upload_failed";
        for (const url of endpoints) {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: "application/json",
            },
            body: form,
            signal: ac.signal,
          });
          const text = await res.text();
          const data = (await parseJsonSafe(text)) as Record<string, unknown> | null;
          if (res.ok) {
            const urlOut =
              pickUrl(data) ||
              pickUrl(data?.data as Record<string, unknown> | null) ||
              pickUrl(data?.media as Record<string, unknown> | null);
            if (urlOut) return { ok: true, url: urlOut };
            lastErr = "upload_ok_but_no_url";
          } else {
            lastErr = `upload_${res.status}`;
            logger.warn("zernio_media_upload_failed", {
              status: res.status,
              endpoint: url,
            });
          }
        }
        return { ok: false, error: lastErr };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "upload_unreachable",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function pickUrl(obj: Record<string, unknown> | null | undefined): string | null {
  if (!obj) return null;
  for (const k of ["url", "publicUrl", "public_url", "downloadUrl", "href"]) {
    const v = obj[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}
