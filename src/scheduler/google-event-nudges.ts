/**
 * Avisa quando entra algo na Agenda Google ligada
 * e de novo ~30 min antes (eventos que o Assessor não criou).
 */
import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import {
  conversations,
  integrationConnections,
  messages,
  users,
  workspaces,
} from "@/db/schema";
import {
  listGoogleHorizonEvents,
  type GoogleDayEvent,
} from "@/integrations/google/pull";
import { isConfirmedDelivery } from "@/domain/send-once";
import { logger } from "@/lib/logger";
import { getNotificationPrefs } from "@/domain/user-preferences";

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(-400);
}

function remember(current: string[], add: string[]): string[] {
  const next = [...current];
  for (const id of add) {
    if (!next.includes(id)) next.push(id);
  }
  return next.slice(-400);
}

function whenLabel(ev: GoogleDayEvent, tz: string): string {
  const start = DateTime.fromJSDate(ev.start).setZone(tz).setLocale("pt-BR");
  const end = ev.end
    ? DateTime.fromJSDate(ev.end).setZone(tz).setLocale("pt-BR")
    : null;
  const day = start.toFormat("ccc dd/LL");
  if (ev.end && end?.isValid && end.hasSame(start, "day")) {
    return `${day} · ${start.toFormat("HH:mm")}–${end.toFormat("HH:mm")}`;
  }
  if (!ev.end) return `${day} · ${start.toFormat("HH:mm")}`;
  return day;
}

function formatArrival(events: GoogleDayEvent[], tz: string): string {
  const freshCut = Date.now() - 6 * 60 * 60 * 1000;
  const fresh = events.some(
    (ev) => ev.created && ev.created.getTime() >= freshCut
  );
  if (events.length === 1) {
    const ev = events[0]!;
    const who = ev.organizerSelf
      ? "Está na agenda ligada ao Assessor."
      : ev.organizer
        ? `*${ev.organizer}* marcou com você.`
        : "Entrou na agenda ligada ao Assessor.";
    const lines = [
      fresh
        ? "📅 *Novo na sua Agenda Google*"
        : "📅 *Na sua Agenda Google*",
      `*${ev.summary}*`,
      `🗓️ ${whenLabel(ev, tz)}`,
      who,
    ];
    if (ev.meetUrl) lines.push(`🎥 ${ev.meetUrl}`);
    if (ev.pendingRsvp) {
      lines.push("Responda *sim*, *não* ou *talvez*. Eu marco no Google, sem abrir o e-mail.");
    }
    return lines.join("\n");
  }
  const lines = events.slice(0, 8).map((ev) => {
    const start = DateTime.fromJSDate(ev.start).setZone(tz).setLocale("pt-BR");
    const who =
      !ev.organizerSelf && ev.organizer ? ` · ${ev.organizer}` : "";
    return `• ${start.toFormat("ccc dd/LL HH:mm")} · ${ev.summary}${who}`;
  });
  const extra = events.length > 8 ? `\n_+${events.length - 8} na sequência._` : "";
  return [
    fresh
      ? `📅 *Novos na sua Agenda Google* (${events.length})`
      : `📅 *Sua Agenda Google* (${events.length})`,
    ...lines,
    extra,
    events.some((ev) => ev.pendingRsvp)
      ? "Responda *sim 1*, *não 2* ou *talvez 1*. Eu marco no Google, sem abrir o e-mail."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runGoogleEventNudges(db: Db): Promise<{
  ran: boolean;
  sent: number;
}> {
  const conns = await db.query.integrationConnections.findMany({
    where: and(
      eq(integrationConnections.provider, "google_calendar"),
      eq(integrationConnections.status, "connected"),
      isNull(integrationConnections.deletedAt)
    ),
    limit: 80,
  });

  let sent = 0;
  for (const conn of conns) {
    const meta = (conn.metadata || {}) as Record<string, unknown>;
    if (meta.mock || meta.connected_via === "dev_mock") continue;

    const ws = await db.query.workspaces.findFirst({
      where: and(
        eq(workspaces.id, conn.workspaceId),
        isNull(workspaces.deletedAt)
      ),
    });
    if (!ws) continue;

    if (!ws?.ownerUserId) continue;

    const owner = await db.query.users.findFirst({
      where: and(eq(users.id, ws.ownerUserId), isNull(users.deletedAt)),
    });
    if (!owner) continue;

    // Modo viagem: silencia avisos locais/Google
    const profile = (owner.profileJson || {}) as Record<string, unknown>;
    if (profile.travel_mode === true) continue;

    const prefs = await getNotificationPrefs(db, owner.id);
    if (!prefs.daily_brief && prefs.bill_alerts === false) {
      /* ainda manda nudge de agenda — leve */
    }

    const tz = owner.timezone || "America/Sao_Paulo";
    const events = await listGoogleHorizonEvents(db, {
      workspaceId: ws.id,
      timezone: tz,
      days: 7,
    });
    if (!events.length) {
      logger.info("google_horizon_empty", { workspace_id: ws.id });
      continue;
    }

    const conv = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.userId, owner.id),
        eq(conversations.workspaceId, ws.id),
        isNull(conversations.deletedAt)
      ),
      orderBy: (c, { desc }) => [desc(c.lastMessageAt)],
    });
    if (!conv?.externalConversationId) continue;

    const seen = idList(meta.google_seen_ids);
    const soonTold = idList(meta.google_soon_ids);
    const now = DateTime.now().setZone(tz);
    const freshCut = now.minus({ hours: 48 });
    const incoming = events.filter((ev) => {
      if (ev.fromAssessor || ev.declined || seen.includes(ev.id)) return false;
      const start = DateTime.fromJSDate(ev.start).setZone(tz);
      if (start.diff(now, "minutes").minutes < -15) return false;
      if (!ev.created) return true;
      return DateTime.fromJSDate(ev.created).setZone(tz) >= freshCut;
    });

    let seenNext = seen;
    let soonNext = soonTold;

    if (incoming.length) {
      const batch = incoming.slice(0, 8);
      const stamp = batch.map((ev) => ev.id).sort().join("|").slice(0, 80);
      const { sendGuardedMessage } = await import("@/domain/outbound-guard");
      const body = formatArrival(batch, tz);
      const send = await sendGuardedMessage(db, {
        conversationId: conv.externalConversationId,
        message: body,
        idempotencyKey: `gcal-new:${ws.id}:${stamp}`,
        withinCustomerCareWindow: true,
        logicalTemplate: "notification",
      });
      await db.insert(messages).values({
        conversationId: conv.id,
        workspaceId: ws.id,
        direction: "outbound",
        status: isConfirmedDelivery(send) ? "sent" : "failed",
        bodyText: body,
        contentType: "text",
        correlationId: `gcal-new:${stamp}`.slice(0, 64),
        rawPayload: { kind: "gcal-new", ok: isConfirmedDelivery(send) },
        sentAt: isConfirmedDelivery(send) ? new Date() : null,
      });
      if (isConfirmedDelivery(send)) {
        sent += 1;
        seenNext = remember(seen, batch.map((ev) => ev.id));
        if (batch.some((ev) => ev.pendingRsvp)) {
          meta.google_rsvp_prompted_at = new Date().toISOString();
        }
        logger.info("google_calendar_announced", {
          workspace_id: ws.id,
          count: batch.length,
        });
      } else {
        logger.warn("google_calendar_announce_failed", {
          workspace_id: ws.id,
          error: String(send.error || "send_failed").slice(0, 160),
        });
      }
    } else {
      logger.info("google_horizon_quiet", {
        workspace_id: ws.id,
        events: events.length,
      });
    }

    for (const ev of events) {
      if (ev.fromAssessor || ev.declined || soonNext.includes(ev.id)) continue;
      const start = DateTime.fromJSDate(ev.start).setZone(tz);
      const mins = Math.round(start.diff(now, "minutes").minutes);
      if (mins < 5 || mins > 35) continue;

      const text = [
        `📅 *Daqui a ~${mins} min* (Google Agenda)`,
        `*${ev.summary}*`,
        `🗓️ ${start.toFormat("HH:mm")}`,
        ev.meetUrl ? `🎥 ${ev.meetUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const { sendGuardedMessage } = await import("@/domain/outbound-guard");
      const send = await sendGuardedMessage(db, {
        conversationId: conv.externalConversationId,
        message: text,
        idempotencyKey: `gcal-nudge:${ws.id}:${ev.id.slice(0, 48)}:${start.toFormat("yyyyLLddHHmm")}`,
        withinCustomerCareWindow: true,
        logicalTemplate: "notification",
      });
      await db.insert(messages).values({
        conversationId: conv.id,
        workspaceId: ws.id,
        direction: "outbound",
        status: isConfirmedDelivery(send) ? "sent" : "failed",
        bodyText: text,
        contentType: "text",
        correlationId: `gcal-nudge:${ev.id.slice(0, 40)}`.slice(0, 64),
        rawPayload: { kind: "gcal-nudge", ok: isConfirmedDelivery(send) },
        sentAt: isConfirmedDelivery(send) ? new Date() : null,
      });
      if (isConfirmedDelivery(send)) {
        sent += 1;
        soonNext = remember(soonNext, [ev.id]);
        logger.info("google_event_nudge_sent", {
          workspace_id: ws.id,
          event_id: ev.id,
        });
      }
    }

    if (seenNext !== seen || soonNext !== soonTold) {
      await db
        .update(integrationConnections)
        .set({
          metadata: {
            ...meta,
            google_seen_ids: seenNext,
            google_soon_ids: soonNext,
          },
          updatedAt: new Date(),
        })
        .where(eq(integrationConnections.id, conn.id));
    }
  }

  return { ran: true, sent };
}
