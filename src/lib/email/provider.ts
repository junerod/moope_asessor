import { createConnection } from "net";
import { getEnv, isProductionEnv } from "@/config/env";
import type { Db } from "@/db/client";
import {
  resolveProviderSecret,
  getProviderConfig,
} from "@/domain/providers";

export type EmailSendInput = {
  to: string;
  subject: string;
  body: string;
};

export type EmailProvider = {
  name: string;
  send(
    input: EmailSendInput
  ): Promise<{ ok: boolean; mocked: boolean; id: string; via?: string }>;
};

type MockStore = {
  sent: Array<EmailSendInput & { id: string; at: string }>;
};

const g = globalThis as unknown as { __emailMock?: MockStore };

function store(): MockStore {
  if (!g.__emailMock) g.__emailMock = { sent: [] };
  return g.__emailMock;
}

export function resetEmailMock() {
  g.__emailMock = { sent: [] };
}

export function getMockEmails() {
  return [...store().sent];
}

export function createMockEmailProvider(): EmailProvider {
  return {
    name: "mock",
    async send(input) {
      const id = `email_${store().sent.length + 1}`;
      store().sent.push({ ...input, id, at: new Date().toISOString() });
      return { ok: true, mocked: true, id, via: "mock" };
    },
  };
}

/**
 * MOOPE mailserver proxy — mesmo contrato do moope-assinaturas.
 * POST {url}/enviar-email  header x-api-key  body { subject, body, from, to }
 */
export function createMailserverEmailProvider(cfg: {
  baseUrl: string;
  apiKey: string;
  fromAddress: string;
}): EmailProvider {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const sendUrl = /enviar-email$/i.test(base) ? base : `${base}/enviar-email`;
  const from = cfg.fromAddress.includes("@")
    ? cfg.fromAddress
    : "info@info.moope.com.br";

  return {
    name: "mailserver",
    async send(input) {
      const res = await fetch(sendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
        },
        body: JSON.stringify({
          subject: String(input.subject || "MOOPE").slice(0, 180),
          body: input.body,
          from,
          to: String(input.to).trim(),
        }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        throw new Error(`mail_http_${res.status}:${text.slice(0, 180)}`);
      }
      let id = `mail_${Date.now()}`;
      try {
        const data = text ? JSON.parse(text) : null;
        if (data?.location) id = String(data.location);
      } catch {
        /* ignore */
      }
      return { ok: true, mocked: false, id, via: "mailserver" };
    },
  };
}

export function createSmtpEmailProvider(cfg: {
  host: string;
  port: number;
  username?: string;
  password?: string;
  fromName: string;
  fromAddress: string;
}): EmailProvider {
  return {
    name: "smtp",
    async send(input) {
      const from = `${cfg.fromName} <${cfg.fromAddress}>`;
      const lines = [
        `From: ${from}`,
        `To: ${input.to}`,
        `Subject: ${input.subject}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        input.body,
        ".",
      ];
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: cfg.host, port: cfg.port }, () => {
          socket.write(`EHLO moope\r\n`);
          socket.write(`MAIL FROM:<${cfg.fromAddress}>\r\n`);
          socket.write(`RCPT TO:<${input.to}>\r\n`);
          socket.write(`DATA\r\n`);
          socket.write(lines.join("\r\n") + "\r\n");
          socket.write(`QUIT\r\n`);
          setTimeout(() => {
            socket.end();
            resolve();
          }, 500);
        });
        socket.on("error", reject);
      });
      return { ok: true, mocked: false, id: `smtp_${Date.now()}`, via: "smtp" };
    },
  };
}

export function getEmailProvider(): EmailProvider {
  const env = getEnv();
  if (env.APP_ENV === "test" || env.EMAIL_PROVIDER === "mock") {
    return createMockEmailProvider();
  }
  if (env.MAILSERVER_URL && env.MAILSERVER_API_KEY) {
    return createMailserverEmailProvider({
      baseUrl: env.MAILSERVER_URL,
      apiKey: env.MAILSERVER_API_KEY,
      fromAddress: env.MAILSERVER_FROM || "info@info.moope.com.br",
    });
  }
  return createMockEmailProvider();
}

export async function resolveEmailProvider(db: Db): Promise<EmailProvider> {
  const env = getEnv();
  // Tests always use mock — never hit real mailserver
  if (env.APP_ENV === "test" || env.EMAIL_PROVIDER === "mock") {
    return createMockEmailProvider();
  }

  const row = await getProviderConfig(db, "email");
  const config = (row?.configJson || {}) as Record<string, unknown>;
  const apiKey =
    (await resolveProviderSecret(db, "email", "api_key")) ||
    env.MAILSERVER_API_KEY ||
    "";
  const baseUrl = String(
    config.base_url || env.MAILSERVER_URL || ""
  ).trim();
  const fromAddress = String(
    config.from_address || env.MAILSERVER_FROM || "info@info.moope.com.br"
  );
  const providerName = String(
    row?.providerName || config.provider || "mailserver"
  );
  const enabled = row?.enabled ?? Boolean(baseUrl && apiKey);

  if (enabled && providerName === "mailserver" && baseUrl && apiKey) {
    return createMailserverEmailProvider({ baseUrl, apiKey, fromAddress });
  }

  if (enabled && providerName === "smtp" && config.host) {
    return createSmtpEmailProvider({
      host: String(config.host),
      port: Number(config.port || 587),
      username: String(config.username || ""),
      password:
        (await resolveProviderSecret(db, "email", "password")) || undefined,
      fromName: String(config.from_name || "MOOPE Assessor"),
      fromAddress,
    });
  }

  if (env.MAILSERVER_URL && env.MAILSERVER_API_KEY) {
    return createMailserverEmailProvider({
      baseUrl: env.MAILSERVER_URL,
      apiKey: env.MAILSERVER_API_KEY,
      fromAddress: env.MAILSERVER_FROM || fromAddress,
    });
  }

  if (isProductionEnv()) {
    throw new Error("EMAIL_PROVIDER_UNAVAILABLE");
  }
  return createMockEmailProvider();
}

export async function testEmailSend(
  db: Db,
  to: string
): Promise<{ status: string; via?: string }> {
  if (!to || !to.includes("@")) {
    return { status: "invalid_recipient" };
  }
  try {
    const provider = await resolveEmailProvider(db);
    const result = await provider.send({
      to,
      subject: "MOOPE Assessor — teste de e-mail",
      body: "Este é um e-mail de teste administrativo. Se você recebeu, o mailserver está operacional.",
    });
    const { setProviderTestResultPublic } = await import("@/domain/providers");
    await setProviderTestResultPublic(
      db,
      "email",
      result.ok ? "connected" : "provider_error",
      result.ok ? null : "send_failed"
    );
    return {
      status: result.ok ? "connected" : "provider_error",
      via: result.via,
    };
  } catch (err) {
    const { setProviderTestResultPublic } = await import("@/domain/providers");
    await setProviderTestResultPublic(db, "email", "provider_error", "send_failed");
    return {
      status: "provider_error",
      via: err instanceof Error ? err.message.slice(0, 80) : "error",
    };
  }
}
