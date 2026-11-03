import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { conversations, messages, users, workspaces } from "@/db/schema";
import {
  claimSendOnce,
  isConfirmedDelivery,
  releaseSendClaim,
  shouldReleaseSendClaim,
} from "@/domain/send-once";
import { formatHoroscope } from "@/domain/horoscope";
import { getHoroscopePrefs, horoscopeDueNow } from "@/domain/horoscope-prefs";
import { logger } from "@/lib/logger";

/**
 * Horóscopo só para quem ligou e escolheu horário.
 * Desligado por padrão. Não entra no bom-dia.
 */
export async function runHoroscopeAlerts(
  db: Db,
  opts?: { force?: boolean; onlyWorkspaceId?: string }
) {
  const spNow = DateTime.now().setZone("America/Sao_Paulo");
  const key = `ho${spNow.toFormat("yyyyLLdd")}`;
  const allWs = await db.query.workspaces.findMany({});
  const wsRows = opts?.onlyWorkspaceId
    ? allWs.filter((w) => w.id === opts.onlyWorkspaceId)
    : allWs.slice(0, 500);

  let sent = 0;
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
    const prefs = await getHoroscopePrefs(db, owner.id);
    if (!opts?.force && !horoscopeDueNow(prefs, spNow.hour, spNow.minute)) {
      continue;
    }
    if (!prefs.sign) continue;

    const conv = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.workspaceId, ws.id),
        eq(conversations.userId, owner.id),
        isNull(conversations.deletedAt)
      ),
      orderBy: (c, { desc }) => [desc(c.lastMessageAt)],
    });
    if (!conv?.externalConversationId) continue;

    const text = formatHoroscope(prefs.sign, spNow);
    const lastIn = await db.query.messages.findFirst({
      where: and(
        eq(messages.conversationId, conv.id),
        eq(messages.direction, "inbound")
      ),
      orderBy: (m, { desc }) => [desc(m.createdAt)],
    });
    const withinWindow = lastIn?.createdAt
      ? Date.now() - lastIn.createdAt.getTime() < 23 * 60 * 60 * 1000
      : false;

    const claimed = await claimSendOnce(db, {
      workspaceId: ws.id,
      periodKey: key,
      metric: "horoscope_alert",
      force: opts?.force,
    });
    if (!claimed) continue;

    const { sendGuardedMessage } = await import("@/domain/outbound-guard");
    const send = await sendGuardedMessage(db, {
      conversationId: conv.externalConversationId,
      message: text,
      idempotencyKey: `horoscope_alert:${ws.id}:${key}`,
      allowDuplicate: Boolean(opts?.force),
      withinCustomerCareWindow: withinWindow,
      forceTemplate: !withinWindow,
      logicalTemplate: "daily_brief",
    });

    await db.insert(messages).values({
      conversationId: conv.id,
      workspaceId: ws.id,
      direction: "outbound",
      status: isConfirmedDelivery(send) ? "sent" : "failed",
      bodyText: text,
      contentType: "text",
      correlationId: `horoscope_alert:${key}`,
      rawPayload: {
        kind: "horoscope_alert",
        ok: isConfirmedDelivery(send),
        error: send.error || null,
      },
      sentAt: isConfirmedDelivery(send) ? new Date() : null,
    });

    if (isConfirmedDelivery(send)) sent += 1;
    else {
      if (shouldReleaseSendClaim(send)) {
        await releaseSendClaim(db, {
          workspaceId: ws.id,
          periodKey: key,
          metric: "horoscope_alert",
        });
      }
      logger.warn("horoscope_alert_failed", { workspace_id: ws.id, error: send.error });
    }
  }
  return { sent };
}
