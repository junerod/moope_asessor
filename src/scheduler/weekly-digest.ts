import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import {
  appointments,
  conversations,
  memories,
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
import type { ReminderPayload } from "@/lib/reminder-copy";

function moneyBr(n: number) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function weekKey(d: DateTime = DateTime.utc()) {
  const safe = d.isValid ? d : DateTime.utc();
  // period_key coluna varchar(16) — manter curto
  return `${safe.weekYear}W${String(safe.weekNumber).padStart(2, "0")}`;
}

/**
 * Domingos (America/Sao_Paulo): envia resumo semanal para workspaces ativos.
 * Idempotente por workspace+semana via usage_counters.
 */
export async function runWeeklyDigests(
  db: Db,
  opts?: { force?: boolean; onlyWorkspaceId?: string }
) {
  const spNow = DateTime.now().setZone("America/Sao_Paulo");
  // Domingo = 7 no Luxon
  if (!opts?.force && spNow.weekday !== 7) {
    return { ran: false, reason: "not_sunday", sent: 0 };
  }
  // Só entre 09:00 e 11:59 pra não spammar o dia todo
  if (!opts?.force && (spNow.hour < 9 || spNow.hour >= 12)) {
    return { ran: false, reason: "outside_window", sent: 0 };
  }

  const key = weekKey(spNow);
  const allWs = await db.query.workspaces.findMany({});
  const wsRows = opts?.onlyWorkspaceId
    ? allWs.filter((w) => w.id === opts.onlyWorkspaceId)
    : allWs.slice(0, 200);

  let sent = 0;
  for (const ws of wsRows) {
    const owner = await db.query.users.findFirst({
      where: eq(users.id, ws.ownerUserId),
    });
    if (!owner || owner.accountStatus === "suspended" || owner.accountStatus === "cancelled") {
      continue;
    }
    const { getNotificationPrefs } = await import("@/domain/user-preferences");
    const prefs = await getNotificationPrefs(db, owner.id);
    if (!prefs.weekly_digest) continue;
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

    const text = await buildWeeklyDigestText(db, {
      workspaceId: ws.id,
      timezone: tz,
      userName: owner.fullName || owner.name || null,
    });
    if (!text) continue;

    // Mesma lógica do daily brief: fora da janela 24h → template
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
      metric: "weekly_digest",
      force: opts?.force,
    });
    if (!claimed) continue;

    const { sendGuardedMessage } = await import("@/domain/outbound-guard");
    const send = await sendGuardedMessage(db, {
      conversationId: conv.externalConversationId,
      message: text,
      idempotencyKey: `weekly_digest:${ws.id}:${key}`,
      allowDuplicate: Boolean(opts?.force),
      withinCustomerCareWindow: withinWindow,
      forceTemplate: !withinWindow,
      logicalTemplate: "weekly_digest",
    });

    await db.insert(messages).values({
      conversationId: conv.id,
      workspaceId: ws.id,
      direction: "outbound",
      status: isConfirmedDelivery(send) ? "sent" : "failed",
      bodyText: text,
      contentType: "text",
      correlationId: `weekly_digest:${key}`,
      rawPayload: {
        kind: "weekly_digest",
        ok: isConfirmedDelivery(send),
        error: send.error || null,
        mode: send.mode,
      },
      sentAt: isConfirmedDelivery(send) ? new Date() : null,
    });

    if (isConfirmedDelivery(send)) {
      sent += 1;
      logger.info("weekly_digest_sent", { workspace_id: ws.id });
    } else {
      if (shouldReleaseSendClaim(send)) {
        await releaseSendClaim(db, {
          workspaceId: ws.id,
          periodKey: key,
          metric: "weekly_digest",
        });
      }
      logger.warn("weekly_digest_send_failed", {
        workspace_id: ws.id,
        error: send.error,
      });
    }
  }

  return { ran: true, reason: "ok", sent };
}

export async function buildWeeklyDigestText(
  db: Db,
  input: { workspaceId: string; timezone: string; userName?: string | null }
) {
  const tz = input.timezone || "America/Sao_Paulo";
  const now = DateTime.now().setZone(tz);
  const weekStart = now.minus({ days: 6 }).startOf("day");
  const weekEnd = now.endOf("day");
  const nextEnd = now.plus({ days: 7 }).endOf("day");

  const expenseRows = await db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, input.workspaceId),
      eq(memories.status, "active"),
      eq(memories.sourceType, "expense"),
      isNull(memories.deletedAt)
    ),
    limit: 300,
  });

  let spent = 0;
  let count = 0;
  const byCat: Record<string, number> = {};
  for (const r of expenseRows) {
    const meta = (r.metadata || {}) as Record<string, unknown>;
    let when = DateTime.fromJSDate(r.createdAt).setZone(tz);
    if (typeof meta.date === "string" && meta.date) {
      const iso = DateTime.fromISO(meta.date, { zone: tz });
      const br = DateTime.fromFormat(meta.date, "dd/MM/yyyy", { zone: tz });
      if (iso.isValid) when = iso;
      else if (br.isValid) when = br;
    }
    if (when < weekStart || when > weekEnd) continue;
    const amount = Number(meta.amount);
    if (!Number.isFinite(amount)) continue;
    spent += amount;
    count += 1;
    const cat = String(meta.category || "outro");
    byCat[cat] = (byCat[cat] || 0) + amount;
  }

  const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];

  const remRows = await db.query.reminders.findMany({
    where: and(
      eq(reminders.workspaceId, input.workspaceId),
      eq(reminders.status, "scheduled"),
      isNull(reminders.deletedAt),
      gte(reminders.fireAt, now.toJSDate()),
      lte(reminders.fireAt, nextEnd.toJSDate())
    ),
    limit: 8,
  });
  const apptRows = await db.query.appointments.findMany({
    where: and(
      eq(appointments.workspaceId, input.workspaceId),
      eq(appointments.status, "scheduled"),
      isNull(appointments.deletedAt),
      gte(appointments.startsAt, now.toJSDate()),
      lte(appointments.startsAt, nextEnd.toJSDate())
    ),
    limit: 8,
  });

  const upcoming = [
    ...remRows.map((r) => {
      const p = (r.payload || {}) as ReminderPayload;
      const money =
        typeof p.amount === "number" && p.amount > 0
          ? ` · ${moneyBr(p.amount)}`
          : "";
      const at = DateTime.fromJSDate(r.fireAt).setZone(r.timezone || tz);
      return `• 🔔 ${at.toFormat("ccc dd/LL HH:mm", { locale: "pt-BR" })} — ${r.title}${money}`;
    }),
    ...apptRows.map((a) => {
      const at = DateTime.fromJSDate(a.startsAt).setZone(a.timezone || tz);
      return `• 📅 ${at.toFormat("ccc dd/LL HH:mm", { locale: "pt-BR" })} — ${a.title}`;
    }),
  ].slice(0, 8);

  const hello = input.userName ? `Oi, ${input.userName.split(" ")[0]}!` : "Oi!";
  const lines = [
    `📬 *Resumo semanal*`,
    hello,
    "",
    `💸 Últimos 7 dias: *${moneyBr(spent)}* em ${count} gasto(s)`,
    topCat ? `Maior categoria: *${topCat[0]}* (${moneyBr(topCat[1])})` : null,
    "",
    upcoming.length
      ? `🗓️ Próximos 7 dias:\n${upcoming.join("\n")}`
      : "🗓️ Próximos 7 dias: agenda livre",
    "",
    `_Dicas:_ “me manda a planilha” · “conectar google” · “como estou na meta?”`,
  ].filter(Boolean);

  // Semana quieta: ainda envia nudge (retenção) em vez de silêncio
  if (count === 0 && upcoming.length === 0) {
    return [
      `📬 *Resumo semanal*`,
      hello,
      "",
      "Semana leve por aqui — que tal começar?",
      "",
      "*Ideias*",
      "• “gastei R$ …” pra ir montando o mês",
      "• “me lembre …” pra não esquecer nada",
      "• “quero gastar no máximo R$ …” pra meta",
      "",
      `_Preferências:_ diga *preferências*_`,
    ].join("\n");
  }
  return lines.join("\n");
}
