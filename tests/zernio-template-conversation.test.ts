import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppTemplateConversation } from "@/channels/zernio/templates-api";
import { resetEnvCache } from "@/config/env";

describe("Zernio template conversation", () => {
  const originalEnv = {
    ZERNIO_MOCK: process.env.ZERNIO_MOCK,
    ZERNIO_API_KEY: process.env.ZERNIO_API_KEY,
    ZERNIO_ACCOUNT_ID: process.env.ZERNIO_ACCOUNT_ID,
  };

  beforeEach(() => {
    process.env.ZERNIO_MOCK = "false";
    process.env.ZERNIO_API_KEY = "test-api-key";
    process.env.ZERNIO_ACCOUNT_ID = "0123456789abcdef01234567";
    resetEnvCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCache();
  });

  it("opens a WhatsApp conversation with the recipient and approved template", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          success: true,
          data: {
            conversationId: "conv-created",
            messageId: "message-created",
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createWhatsAppTemplateConversation({
      phoneE164: "+55 (61) 99671-5985",
      templateName: "assessor_reminder",
      templateLanguage: "pt_BR",
      templateParams: ["Reunião · 28/09 · 09:00"],
      idempotencyKey: "team-reminder:123:contact-1",
    });

    expect(result).toMatchObject({
      ok: true,
      conversationId: "conv-created",
      externalMessageId: "message-created",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://zernio.com/api/v1/inbox/conversations");
    expect(request.headers).toMatchObject({
      "Idempotency-Key": "team-reminder:123:contact-1",
    });
    expect(JSON.parse(String(request.body))).toMatchObject({
      participantId: "5561996715985",
      templateName: "assessor_reminder",
      templateLanguage: "pt_BR",
      templateParams: ["Reunião · 28/09 · 09:00"],
    });
  });

  it("fails closed on provider rejection and invalid recipients", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "TEMPLATE_REQUIRED" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const rejected = await createWhatsAppTemplateConversation({
      phoneE164: "+5561996715985",
      templateName: "assessor_reminder",
      templateLanguage: "pt_BR",
      templateParams: ["Reunião · 28/09 · 09:00"],
      idempotencyKey: "team-reminder:123:contact-1",
    });
    const invalid = await createWhatsAppTemplateConversation({
      phoneE164: "not-a-phone",
      templateName: "assessor_reminder",
      templateLanguage: "pt_BR",
      templateParams: [],
      idempotencyKey: "team-reminder:123:contact-2",
    });

    expect(rejected).toMatchObject({ ok: false, status: 400 });
    expect(invalid).toMatchObject({ ok: false, error: "invalid_recipient_phone" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
