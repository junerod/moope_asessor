import { and, eq, isNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { getEnv } from "@/config/env";
import { messages, reminders } from "@/db/schema";
import { isWorkspaceWhitelisted } from "@/domain/access-whitelist";
import {
  formatMoopeContactCta,
  getMoopeContact,
} from "@/domain/moope-contact";
import { logger } from "@/lib/logger";

export type RateLimitDecision =
  | { ok: true; truncatedText?: string }
  | { ok: false; reason: string; userMessage: string };

/**
 * Anti-abuso operacional (minuto / dia).
 * Whitelist = sem limite.
 * Demais = trial/avaliação com teto diário menor.
 * Nunca deve derrubar o job: em erro de infra, falha aberta (permite).
 */
export async function checkInboundRateLimit(
  db: Db,
  input: {
    workspaceId: string;
    conversationId: string;
    userText: string;
  }
): Promise<RateLimitDecision> {
  try {
    return await checkInboundRateLimitInner(db, input);
  } catch (err) {
    logger.error("rate_limit_check_failed_fail_open", {
      workspace_id: input.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: true };
  }
}

async function checkInboundRateLimitInner(
  db: Db,
  input: {
    workspaceId: string;
    conversationId: string;
    userText: string;
  }
): Promise<RateLimitDecision> {
  const env = getEnv();
  const maxChars = env.RATE_LIMIT_MAX_MESSAGE_CHARS;
  const perMin = env.RATE_LIMIT_MESSAGES_PER_MINUTE;

  let text = input.userText || "";
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }

  if (await isWorkspaceWhitelisted(db, input.workspaceId)) {
    return {
      ok: true,
      truncatedText: truncated ? text : undefined,
    };
  }

  const perDay = env.RATE_LIMIT_TRIAL_MESSAGES_PER_DAY;
  const tokenDay = env.RATE_LIMIT_TRIAL_INPUT_TOKENS_PER_DAY;
  const contact = await getMoopeContact(db);
  const unlockCta = formatMoopeContactCta(contact);

  const sinceMinute = DateTime.utc().minus({ minutes: 1 }).toJSDate();
  const recent = await db.query.messages.findMany({
    where: and(
      eq(messages.conversationId, input.conversationId),
      eq(messages.direction, "inbound")
    ),
    orderBy: (m, { desc }) => [desc(m.createdAt)],
    limit: perMin + 5,
  });
  const inLastMinute = recent.filter((m) => m.createdAt >= sinceMinute).length;
  if (inLastMinute >= perMin) {
    logger.warn("rate_limit_per_minute", {
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      count: inLastMinute,
    });
    return {
      ok: false,
      reason: "per_minute",
      userMessage:
        "⏳ Calma um segundo — você mandou várias mensagens seguidas. Me dá ~1 min e tenta de novo?",
    };
  }

  // ISO string — Date cru no postgres.js/drizzle vira toString() inválido no PG
  const dayStartIso = DateTime.now()
    .setZone("America/Sao_Paulo")
    .startOf("day")
    .toUTC()
    .toISO();
  if (!dayStartIso) {
    return { ok: true, truncatedText: truncated ? text : undefined };
  }

  const msgCountRows = await db.execute(sql`
    SELECT COUNT(*)::int AS c
    FROM messages m
    INNER JOIN conversations c ON c.id = m.conversation_id
    WHERE c.workspace_id = ${input.workspaceId}
      AND m.direction = 'inbound'
      AND m.created_at >= ${dayStartIso}::timestamptz
  `);
  const msgRow = (
    Array.isArray(msgCountRows)
      ? msgCountRows[0]
      : (msgCountRows as { rows?: unknown[] })?.rows?.[0]
  ) as { c?: number } | undefined;
  const msgsToday = Number(msgRow?.c || 0);
  if (msgsToday >= perDay) {
    logger.warn("rate_limit_per_day", {
      workspace_id: input.workspaceId,
      messages: msgsToday,
      trial_cap: perDay,
    });
    return {
      ok: false,
      reason: "per_day",
      userMessage: [
        `🚫 Você atingiu o limite diário da avaliação (${perDay} mensagens).`,
        "Amanhã o contador zera.",
        "",
        unlockCta,
      ].join("\n"),
    };
  }

  const tokenRows = await db.execute(sql`
    SELECT COALESCE(SUM(COALESCE(input_tokens, 0)), 0)::bigint AS t
    FROM agent_runs
    WHERE workspace_id = ${input.workspaceId}
      AND created_at >= ${dayStartIso}::timestamptz
  `);
  const tokenRow = (
    Array.isArray(tokenRows)
      ? tokenRows[0]
      : (tokenRows as { rows?: unknown[] })?.rows?.[0]
  ) as { t?: string | number } | undefined;
  const tokensToday = Number(tokenRow?.t || 0);
  if (tokensToday >= tokenDay) {
    logger.warn("rate_limit_tokens_day", {
      workspace_id: input.workspaceId,
      tokens: tokensToday,
      trial_cap: tokenDay,
    });
    return {
      ok: false,
      reason: "tokens_day",
      userMessage: [
        "🧠 Hoje o limite de processamento da avaliação acabou. Amanhã reseto.",
        "",
        unlockCta,
      ].join("\n"),
    };
  }

  return {
    ok: true,
    truncatedText: truncated ? text : undefined,
  };
}

export async function countScheduledReminders(db: Db, workspaceId: string) {
  const rows = await db.query.reminders.findMany({
    where: and(
      eq(reminders.workspaceId, workspaceId),
      eq(reminders.status, "scheduled"),
      isNull(reminders.deletedAt)
    ),
    limit: 500,
  });
  return rows.length;
}
