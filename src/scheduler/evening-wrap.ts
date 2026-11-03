/**
 * Encerramento do dia: horário configurável + lista fez / não fez.
 */
import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import {
  conversations,
  messages,
  reminders,
  users,
  workspaces,
} from "@/db/schema";
import {
  claimSendOnce,
  isConfirmedDelivery,
  releaseSendClaim,
  shouldReleaseSendClaim,
} from "@/domain/send-once";
import { logger } from "@/lib/logger";
import { dayRange } from "@/lib/datetime";
import {
  isInternalTestReminder,
  emojiForReminder,
  type ReminderPayload,
} from "@/lib/reminder-copy";
import type { DayReminderRow } from "@/domain/reminder-baixa";

function dayKey(d: DateTime = DateTime.now().setZone("America/Sao_Paulo")) {
  return d.toFormat("yyyyLLdd");
}

async function loadTodayAllReminders(
  db: Db,
  workspaceId: string,
  timezone: string
): Promise<DayReminderRow[]> {
  const day = DateTime.now().setZone(timezone);
  const { start, end } = dayRange(day);
  const rows = await db.query.reminders.findMany({
    where: and(eq(reminders.workspaceId, workspaceId), isNull(reminders.deletedAt)),
  });
  return rows
    .filter((r) => {
      if (isInternalTestReminder(r.title, r.payload)) return false;
      return r.fireAt >= start && r.fireAt <= end;
    })
    .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
    .map((r) => ({
      id: r.id,
      title: r.title,
      fireAt: r.fireAt,
      timezone: r.timezone || timezone,
      status: r.status,
      recurrenceRule: r.recurrenceRule,
      payload: r.payload,
    }));
}

function lineFor(r: DayReminderRow, timezone: string, idx?: number): string {
  const t = DateTime.fromJSDate(r.fireAt)
    .setZone(r.timezone || timezone)
    .toFormat("HH:mm");
  const em = emojiForReminder((r.payload || {}) as ReminderPayload, r.title);
  const prefix = idx != null ? `*${idx}.* ` : "• ";
  return `${prefix}${em} ${t} — ${r.title}`;
}

export async function buildEveningWrapText(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    timezone: string;
    userName?: string | null;
  }
): Promise<string | null> {
  const rows = await loadTodayAllReminders(
    db,
    input.workspaceId,
    input.timezone
  );
  const done = rows.filter((r) => r.status === "cancelled");
  const open = rows.filter(
    (r) =>
      r.status === "scheduled" ||
      r.status === "queued" ||
      r.status === "sent"
  );
  const name = input.userName ? String(input.userName).split(" ")[0] : null;
  const hello = name ? `Boa noite, ${name}` : "Boa noite";

  if (!done.length && !open.length) {
    return [
      `🌙 *${hello}*`,
      "",
      "Hoje não tinha itens na agenda — ou já está tudo limpo ✅",
      "Amanhã te acho no resumo da manhã.",
    ].join("\n");
  }

  const lines = [`🌙 *${hello} · encerramento*`, "────────────"];

  if (done.length) {
    lines.push(`✅ *Fez (${done.length})*`);
    for (const r of done.slice(0, 10)) {
      lines.push(lineFor(r, input.timezone));
    }
    lines.push("");
  } else {
    lines.push("✅ *Fez:* nenhum com baixa ainda");
    lines.push("");
  }

  if (open.length) {
    lines.push(`⏳ *Não fez / ainda aberto (${open.length})*`);
    open.slice(0, 12).forEach((r, i) => {
      lines.push(lineFor(r, input.timezone, i + 1));
    });
    lines.push("");
    lines.push("Dar baixa:");
    lines.push("• *baixa 1* · *baixa 1 e 3*");
    lines.push("• *concluí o que já passou*");
  } else {
    lines.push("⏳ *Não fez:* nada aberto — dia fechado 🎉");
  }

  lines.push("");
  lines.push("_Horário: diga *encerra o dia às 20h* · *desliga encerramento*_");
  return lines.join("\n");
}

/** Janela de 15 min a partir do horário escolhido (default 21:00). */
export function eveningWrapDueNow(
  prefs: { evening_wrap: boolean; evening_wrap_hour: number; evening_wrap_minute: number },
  now: DateTime = DateTime.now().setZone("America/Sao_Paulo")
): boolean {
  if (!prefs.evening_wrap) return false;
  if (now.hour !== prefs.evening_wrap_hour) return false;
  const min = prefs.evening_wrap_minute || 0;
  return now.minute >= min && now.minute < min + 15;
}

/**
 * 1x/dia por workspace no horário preferido do usuário.
 */
export async function runEveningWraps(
  db: Db,
  opts?: { force?: boolean; onlyWorkspaceId?: string }
) {
  const spNow = DateTime.now().setZone("America/Sao_Paulo");
  const key = `ew${dayKey(spNow)}`;
  const allWs = await db.query.workspaces.findMany({});
  const wsRows = opts?.onlyWorkspaceId
    ? allWs.filter((w) => w.id === opts.onlyWorkspaceId)
    : allWs.slice(0, 500);

  const gathered: Array<{
    workspaceId: string;
    conversationId: string;
    externalConversationId: string;
    text: string;
    score: number;
    hour: number;
    personal: boolean;
  }> = [];
  for (const ws of wsRows) {
    const owner = await db.query.users.findFirst({
      where: eq(users.id, ws.ownerUserId),
    });
    if (
      !owner ||
      owner.accountStatus === "suspended" ||
      owner.accountStatus === "cancelled"
    ) {
      continue;
    }

    const { getNotificationPrefs } = await import("@/domain/user-preferences");
    const prefs = await getNotificationPrefs(db, owner.id);
    if (!opts?.force && !eveningWrapDueNow(prefs, spNow)) continue;

    const tz = owner.timezone || "America/Sao_Paulo";
    const conv = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.workspaceId, ws.id),
        eq(conversations.userId, owner.id),
        isNull(conversations.deletedAt)
      ),
      orderBy: (c, { desc }) => [desc(c.lastMessageAt)],
    });
    if (!conv?.externalConversationId) continue;

    const text = await buildEveningWrapText(db, {
      workspaceId: ws.id,
      userId: owner.id,
      timezone: tz,
      userName: owner.fullName || null,
    });
    if (!text) continue;
    gathered.push({
      workspaceId: ws.id,
      conversationId: conv.id,
      externalConversationId: conv.externalConversationId,
      text,
      score: (text.match(/^\*\d+\./m) ? 3 : 0) + (text.includes("tudo limpo") ? 0 : 2),
      hour: prefs.evening_wrap_hour,
      personal: ws.type === "personal",
    });
  }

  const { pickRichestByConversation, alreadySentDigestOnChat } = await import(
    "@/domain/digest-once"
  );
  const chosen = pickRichestByConversation(gathered);
  let sent = 0;
  for (const pick of chosen) {
    if (await alreadySentDigestOnChat(db, pick.externalConversationId, `evening_wrap:${key}`)) {
      continue;
    }

    const lastIn = await db.query.messages.findFirst({
      where: and(
        eq(messages.conversationId, pick.conversationId),
        eq(messages.direction, "inbound")
      ),
      orderBy: (m, { desc }) => [desc(m.createdAt)],
    });
    const withinWindow = lastIn?.createdAt
      ? Date.now() - lastIn.createdAt.getTime() < 23 * 60 * 60 * 1000
      : false;

    const claimed = await claimSendOnce(db, {
      workspaceId: pick.workspaceId,
      periodKey: key,
      metric: "evening_wrap",
      force: opts?.force,
    });
    if (!claimed) continue;

    const { sendGuardedMessage } = await import("@/domain/outbound-guard");
    const send = await sendGuardedMessage(db, {
      conversationId: pick.externalConversationId,
      message: pick.text,
      idempotencyKey: `evening_wrap:${pick.externalConversationId}:${key}`,
      allowDuplicate: Boolean(opts?.force),
      withinCustomerCareWindow: withinWindow,
      forceTemplate: !withinWindow,
      logicalTemplate: "daily_brief",
    });

    await db.insert(messages).values({
      conversationId: pick.conversationId,
      workspaceId: pick.workspaceId,
      direction: "outbound",
      status: isConfirmedDelivery(send) ? "sent" : "failed",
      bodyText: pick.text,
      contentType: "text",
      correlationId: `evening_wrap:${key}`,
      rawPayload: {
        kind: "evening_wrap",
        ok: isConfirmedDelivery(send),
        error: send.error || null,
      },
      sentAt: isConfirmedDelivery(send) ? new Date() : null,
    });

    if (isConfirmedDelivery(send)) {
      sent += 1;
      logger.info("evening_wrap_sent", {
        workspace_id: pick.workspaceId,
        hour: pick.hour,
      });
    } else {
      if (shouldReleaseSendClaim(send)) {
        await releaseSendClaim(db, {
          workspaceId: pick.workspaceId,
          periodKey: key,
          metric: "evening_wrap",
        });
      }
      logger.warn("evening_wrap_send_failed", {
        workspace_id: pick.workspaceId,
        error: send.error,
      });
    }
  }

  return { ran: true, sent };
}
