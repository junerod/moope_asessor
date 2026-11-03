import postgres from "postgres";
import { createDb, type Db } from "@/db/client";
import { resetEnvCache } from "@/config/env";
import { computeZernioSignature, resetZernioMock } from "@/channels/zernio";

const TABLES = [
  "tool_calls",
  "agent_runs",
  "agent_jobs",
  "admin_audit_logs",
  "audit_logs",
  "consent_acceptances",
  "integration_connections",
  "webhook_events",
  "alert_outbox",
  "reminders",
  "appointments",
  "tasks",
  "document_chunks",
  "documents",
  "memories",
  "messages",
  "conversations",
  "whatsapp_business_context",
  "whatsapp_identities",
  "whatsapp_channels",
  "whatsapp_templates",
  "client_access_whitelist",
  "client_access_blacklist",
  "workspace_members",
  "subscriptions",
  "usage_counters",
  "plans",
  "workspaces",
  "platform_admins",
  "provider_configs",
  "encrypted_secrets",
  "platform_settings",
  "process_heartbeats",
  "users",
];

export async function createTestDb(): Promise<{
  db: Db;
  sql: ReturnType<typeof postgres>;
}> {
  resetEnvCache();
  resetZernioMock();
  const url =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgres://assessor:assessor@127.0.0.1:54329/moope_assessor_test";
  if (!url.includes("moope_assessor_test") && !process.env.ALLOW_TEST_ON_APP_DB) {
    throw new Error(
      `Refusing to run tests against non-test DB (${url}). Use moope_assessor_test.`
    );
  }
  const sql = postgres(url, { max: 5, prepare: false });
  const db = createDb(url);
  return { db, sql };
}

export async function truncateAll(sql: ReturnType<typeof postgres>) {
  await sql.unsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`
  );
}

export function signedBody(payload: unknown, secret?: string) {
  const rawBody = JSON.stringify(payload);
  const signature = computeZernioSignature(
    secret || process.env.ZERNIO_WEBHOOK_SECRET || "test-zernio-webhook-secret",
    rawBody
  );
  return { rawBody, signature };
}

export function inboundPayload(overrides?: {
  eventId?: string;
  phone?: string | null;
  bsuid?: string | null;
  text?: string;
  conversationId?: string;
  messageId?: string;
  name?: string;
}) {
  const contact: Record<string, string> = {
    name: overrides?.name || "Test User",
  };
  if (overrides?.phone !== null) {
    contact.phone = overrides?.phone || "+5561999990001";
  }
  if (overrides?.bsuid) {
    contact.bsuid = overrides.bsuid;
  }

  return {
    id: overrides?.eventId || `evt_${Math.random().toString(16).slice(2)}`,
    event: "message.received",
    timestamp: new Date().toISOString(),
    data: {
      account: { id: "acct_test" },
      conversation: {
        id:
          overrides?.conversationId ||
          `conv_${Math.random().toString(16).slice(2)}`,
      },
      contact,
      message: {
        id:
          overrides?.messageId || `msg_${Math.random().toString(16).slice(2)}`,
        text: overrides?.text || "Oi",
        type: "text",
      },
    },
  };
}
