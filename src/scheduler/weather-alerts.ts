import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import {
  conversations,
  messages,
  users,
  workspaces,
} from "@/db/schema";
import {
  claimSendOnce,
  isConfirmedDelivery,
  releaseSendClaim,
  shouldReleaseSendClaim,
} from "@/domain/send-once";
import {
  getWeatherPrefs,
  weatherAlertDueNow,
} from "@/domain/weather-prefs";
import {
  fetchForecast,
  formatWeatherCard,
} from "@/domain/weather";
import { logger } from "@/lib/logger";

/**
 * Aviso dedicado de tempo no horário escolhido pelo usuário.
 * Independente do bom-dia; 1x/dia via usage_counters.
 */
export async function runWeatherAlerts(
  db: Db,
  opts?: { force?: boolean; onlyWorkspaceId?: string }
) {
  const spNow = DateTime.now().setZone("America/Sao_Paulo");
  const key = `wa${spNow.toFormat("yyyyLLdd")}`;

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

    const prefs = await getWeatherPrefs(db, owner.id);
    if (
      !opts?.force &&
      !weatherAlertDueNow(prefs, spNow.hour, spNow.minute)
    ) {
      continue;
    }
    if (!prefs.place) continue;

    const conv = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.workspaceId, ws.id),
        eq(conversations.userId, owner.id),
        isNull(conversations.deletedAt)
      ),
      orderBy: (c, { desc }) => [desc(c.lastMessageAt)],
    });
    if (!conv?.externalConversationId) continue;

    const bundle = await fetchForecast(prefs.place);
    if (!bundle) continue;

    const name = (owner.fullName || owner.name || "").split(" ")[0];
    const hello = name ? `Bom dia, ${name}!` : "Bom dia!";
    // Fora da manhã, cumprimenta conforme hora
    const greet =
      spNow.hour < 12
        ? hello
        : spNow.hour < 18
          ? name
            ? `Oi, ${name}!`
            : "Oi!"
          : name
            ? `Boa noite, ${name}!`
            : "Boa noite!";

    const text = [
      greet,
      "",
      formatWeatherCard(bundle, {
        focus: "today",
        footer: "_Peça “tempo amanhã” ou “tempo da semana” quando quiser._",
      }),
    ].join("\n");

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
      metric: "weather_alert",
      force: opts?.force,
    });
    if (!claimed) continue;

    const { sendGuardedMessage } = await import("@/domain/outbound-guard");
    const send = await sendGuardedMessage(db, {
      conversationId: conv.externalConversationId,
      message: text,
      idempotencyKey: `weather_alert:${ws.id}:${key}`,
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
      correlationId: `weather_alert:${key}`,
      rawPayload: {
        kind: "weather_alert",
        ok: isConfirmedDelivery(send),
        error: send.error || null,
      },
      sentAt: isConfirmedDelivery(send) ? new Date() : null,
    });

    if (isConfirmedDelivery(send)) {
      sent += 1;
      logger.info("weather_alert_sent", { workspace_id: ws.id });
    } else {
      if (shouldReleaseSendClaim(send)) {
        await releaseSendClaim(db, {
          workspaceId: ws.id,
          periodKey: key,
          metric: "weather_alert",
        });
      }
      logger.warn("weather_alert_send_failed", {
        workspace_id: ws.id,
        error: send.error,
      });
    }
  }

  return { ran: true, sent };
}
