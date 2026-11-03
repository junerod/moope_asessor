import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";

/** drizzle/postgres-js às vezes devolve array, às vezes `{ rows }`. */
export function executeRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

/** Linhas afetadas no INSERT. 1 = ganhamos o slot; 0 = já existia. */
export function insertedRowCount(result: unknown): number {
  if (result && typeof result === "object") {
    const o = result as { count?: unknown; rowCount?: unknown };
    if (typeof o.count === "number") return o.count;
    if (typeof o.rowCount === "number") return o.rowCount;
  }
  return executeRows(result).length;
}

export function isUncertainSendFailure(input: {
  error?: string;
  errorCode?: string;
  status?: number;
}): boolean {
  const blob = `${input.errorCode || ""} ${input.error || ""}`.toLowerCase();
  if (/timeout|abort|unreachable|econnreset|network|uncertain|socket|hang up/.test(blob)) {
    return true;
  }
  const status = input.status;
  if (status === 408 || status === 429 || (typeof status === "number" && status >= 500)) {
    return true;
  }
  if (status === 0 && !blob.trim()) return true;
  return false;
}

/** 4xx (exceto 408/429): o Zap não saiu. Pode tentar o outro canal. */
export function isClearReject(input: { status?: number }): boolean {
  const status = input.status;
  if (typeof status !== "number") return false;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * Só libera o slot quando dá pra afirmar que o Zap não saiu.
 * Timeout/5xx e claim preso mantêm a chave — retry imediato duplicaria.
 */
export function shouldReleaseSendClaim(send: {
  ok: boolean;
  error?: string;
  errorCode?: string;
}): boolean {
  if (send.ok) return false;
  if (send.errorCode === "ALREADY_SENT") return false;
  if (send.errorCode === "CLAIM_HELD") return false;
  if (isUncertainSendFailure(send)) return false;
  const code = String(send.errorCode || "");
  const err = String(send.error || "").toLowerCase();
  if (code === "TEMPLATE_NOT_CONFIGURED") return true;
  if (code === "TEMPLATE_NOT_CONFIGURED_FALLBACK") return true;
  return /credential|zernio_credentials_missing|invalid_recipient|zernio_send_failed/.test(
    `${code} ${err}`
  );
}

/** Entrega de verdade: ok sem incerteza e sem claim preso. */
export function isConfirmedDelivery(send: {
  ok: boolean;
  errorCode?: string;
}): boolean {
  if (!send.ok) return false;
  const code = String(send.errorCode || "");
  if (code === "SEND_UNCERTAIN" || code === "CLAIM_HELD") return false;
  return true;
}

export function looksLikeScheduledSend(idempotencyKey: string): boolean {
  return /^(daily_brief|weekly_digest|evening_wrap|weather_alert|horoscope_alert|goal_alert|bill_due|crm-new|crm-reply|crm-down|gcal-)/.test(
    idempotencyKey
  );
}

let outboundTableReady = false;

export async function ensureOutboundSendKeys(db: Db): Promise<void> {
  if (outboundTableReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS outbound_send_keys (
      idempotency_key varchar(191) PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  outboundTableReady = true;
}

export function resetOutboundTableFlag() {
  outboundTableReady = false;
}

export async function claimOutboundKey(
  db: Db,
  idempotencyKey: string
): Promise<boolean> {
  const key = String(idempotencyKey || "").trim();
  if (!key) return true;
  await ensureOutboundSendKeys(db);
  const result = await db.execute(sql`
    INSERT INTO outbound_send_keys (idempotency_key)
    VALUES (${key})
    ON CONFLICT (idempotency_key) DO NOTHING
  `);
  return insertedRowCount(result) === 1;
}

export async function releaseOutboundKey(
  db: Db,
  idempotencyKey: string
): Promise<void> {
  const key = String(idempotencyKey || "").trim();
  if (!key) return;
  await ensureOutboundSendKeys(db);
  await db.execute(sql`
    DELETE FROM outbound_send_keys WHERE idempotency_key = ${key}
  `);
}

export async function alreadySentSameBody(
  db: Db,
  input: { conversationId: string; message: string }
): Promise<boolean> {
  const body = String(input.message || "").trim();
  const conv = String(input.conversationId || "").trim();
  if (!body || !conv) return false;
  const result = await db.execute(sql`
    SELECT 1
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.external_conversation_id = ${conv}
      AND m.direction = 'outbound'
      AND m.status = 'sent'
      AND m.body_text = ${body}
      AND m.created_at > NOW() - INTERVAL '6 hours'
    LIMIT 1
  `);
  return executeRows(result).length > 0;
}

export async function claimSendOnce(
  db: Db,
  input: {
    workspaceId: string;
    periodKey: string;
    metric: string;
    force?: boolean;
  }
): Promise<boolean> {
  if (input.force) return true;
  const result = await db.execute(sql`
    INSERT INTO usage_counters (workspace_id, period_key, metric, value, updated_at)
    VALUES (${input.workspaceId}, ${input.periodKey}, ${input.metric}, 1, NOW())
    ON CONFLICT (workspace_id, period_key, metric) DO NOTHING
  `);
  return insertedRowCount(result) === 1;
}

export async function releaseSendClaim(
  db: Db,
  input: { workspaceId: string; periodKey: string; metric: string }
): Promise<void> {
  await db.execute(sql`
    DELETE FROM usage_counters
    WHERE workspace_id = ${input.workspaceId}
      AND period_key = ${input.periodKey}
      AND metric = ${input.metric}
  `);
}
