import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import {
  appointments,
  conversations,
  memories,
  messages,
  reminders,
  tasks,
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
import {
  emojiForReminder,
  isInternalTestReminder,
} from "@/lib/reminder-copy";
import { reminderShadowsAppointment } from "@/domain/digest-once";

function moneyBr(n: number) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dayKey(d: DateTime = DateTime.now().setZone("America/Sao_Paulo")) {
  return d.toFormat("yyyyLLdd");
}

/**
 * Envia resumo matinal (07:00–09:59 America/Sao_Paulo), 1x por dia por workspace.
 * Inclui agenda de hoje + tarefas abertas + pendências enviadas ontem (ainda relevantes).
 */
export async function runDailyBriefs(
  db: Db,
  opts?: { force?: boolean; onlyWorkspaceId?: string }
) {
  const spNow = DateTime.now().setZone("America/Sao_Paulo");
  if (!opts?.force && (spNow.hour < 7 || spNow.hour >= 10)) {
    return { ran: false, reason: "outside_window", sent: 0 };
  }

  const key = `db${dayKey(spNow)}`;
  const allWs = await db.query.workspaces.findMany({});
  const wsRows = opts?.onlyWorkspaceId
    ? allWs.filter((w) => w.id === opts.onlyWorkspaceId)
    : allWs.slice(0, 500);

  type BriefCandidate = {
    workspaceId: string;
    ownerId: string;
    conversationId: string;
    externalConversationId: string;
    text: string;
    score: number;
    timezone: string;
    personal: boolean;
  };
  const gathered: BriefCandidate[] = [];
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
    if (!prefs.daily_brief) continue;
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

    const text = await buildDailyBriefText(db, {
      workspaceId: ws.id,
      timezone: tz,
      userName: owner.name || owner.fullName || null,
      userId: owner.id,
    });
    if (!text) continue;
    const score = (text.match(/^• /gm) || []).length + (text.includes("Agenda livre") ? 0 : 2);
    gathered.push({
      workspaceId: ws.id,
      ownerId: owner.id,
      conversationId: conv.id,
      externalConversationId: conv.externalConversationId,
      text,
      score,
      timezone: tz,
      personal: ws.type === "personal",
    });
  }

  const { pickRichestByConversation, alreadySentDigestOnChat } = await import(
    "@/domain/digest-once"
  );
  const chosen = pickRichestByConversation(gathered);

  let sent = 0;
  for (const pick of chosen) {
    if (await alreadySentDigestOnChat(db, pick.externalConversationId, `daily_brief:${key}`)) {
      continue;
    }

    // Janela 24h WhatsApp: se último inbound > 23h, força template
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
      metric: "daily_brief",
      force: opts?.force,
    });
    if (!claimed) continue;

    const { sendGuardedMessage } = await import("@/domain/outbound-guard");
    const send = await sendGuardedMessage(db, {
      conversationId: pick.externalConversationId,
      message: pick.text,
      idempotencyKey: `daily_brief:${pick.externalConversationId}:${key}`,
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
      correlationId: `daily_brief:${key}`,
      rawPayload: {
        kind: "daily_brief",
        ok: isConfirmedDelivery(send),
        error: send.error || null,
        mode: send.mode,
      },
      sentAt: isConfirmedDelivery(send) ? new Date() : null,
    });

    if (isConfirmedDelivery(send)) {
      sent += 1;
      logger.info("daily_brief_sent", {
        workspace_id: pick.workspaceId,
        within_window: withinWindow,
      });
    } else {
      if (shouldReleaseSendClaim(send)) {
        await releaseSendClaim(db, {
          workspaceId: pick.workspaceId,
          periodKey: key,
          metric: "daily_brief",
        });
      }
      logger.warn("daily_brief_send_failed", {
        workspace_id: pick.workspaceId,
        error: send.error,
        error_code: send.errorCode,
        within_window: withinWindow,
      });
    }
  }

  return { ran: true, reason: "ok", sent };
}

function uniqueTaskTitles(rows: Array<{ title: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const title = String(row.title || "").replace(/\s+/g, " ").trim();
    const key = title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    if (!title || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

export async function buildDailyBriefText(
  db: Db,
  input: {
    workspaceId: string;
    timezone: string;
    userName?: string | null;
    userId?: string | null;
  }
) {
  const tz = input.timezone || "America/Sao_Paulo";
  const now = DateTime.now().setZone(tz);
  const dayStart = now.startOf("day");
  const dayEnd = now.endOf("day");
  const yStart = dayStart.minus({ days: 1 });
  const yEnd = dayStart.minus({ milliseconds: 1 });

  const remRows = await db.query.reminders.findMany({
    where: and(
      eq(reminders.workspaceId, input.workspaceId),
      eq(reminders.status, "scheduled"),
      isNull(reminders.deletedAt),
      gte(reminders.fireAt, dayStart.toJSDate()),
      lte(reminders.fireAt, dayEnd.toJSDate())
    ),
    limit: 20,
  });

  // Pendências de ontem: lembretes que dispararam ontem (ainda relevantes de manhã)
  const yesterdaySent = await db.query.reminders.findMany({
    where: and(
      eq(reminders.workspaceId, input.workspaceId),
      eq(reminders.status, "sent"),
      isNull(reminders.deletedAt),
      gte(reminders.fireAt, yStart.toJSDate()),
      lte(reminders.fireAt, yEnd.toJSDate())
    ),
    limit: 15,
  });

  // Recorrentes ativos (próximos 7 dias) — garante visibilidade
  const recurSoon = await db.query.reminders.findMany({
    where: and(
      eq(reminders.workspaceId, input.workspaceId),
      eq(reminders.status, "scheduled"),
      isNull(reminders.deletedAt),
      gte(reminders.fireAt, dayStart.toJSDate()),
      lte(reminders.fireAt, dayStart.plus({ days: 7 }).toJSDate()),
      sql`${reminders.recurrenceRule} IS NOT NULL AND ${reminders.recurrenceRule} <> ''`
    ),
    limit: 10,
  });

  const apptRows = await db.query.appointments.findMany({
    where: and(
      eq(appointments.workspaceId, input.workspaceId),
      eq(appointments.status, "scheduled"),
      isNull(appointments.deletedAt),
      gte(appointments.startsAt, dayStart.toJSDate()),
      lte(appointments.startsAt, dayEnd.toJSDate())
    ),
    limit: 12,
  });
  const taskRows = await db.query.tasks.findMany({
    where: and(
      eq(tasks.workspaceId, input.workspaceId),
      eq(tasks.status, "open"),
      isNull(tasks.deletedAt)
    ),
    limit: 12,
  });

  const expenseRows = await db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, input.workspaceId),
      eq(memories.status, "active"),
      eq(memories.sourceType, "expense"),
      isNull(memories.deletedAt)
    ),
    limit: 80,
  });
  const dueToday: string[] = [];
  const todayStr = now.toFormat("dd/MM/yyyy");
  const todayIso = now.toFormat("yyyy-MM-dd");
  for (const r of expenseRows) {
    const meta = (r.metadata || {}) as Record<string, unknown>;
    const d = String(meta.date || "");
    if (d === todayStr || d === todayIso || d.includes(todayIso)) {
      const amount = Number(meta.amount);
      dueToday.push(
        `• 💸 ${meta.category || "conta"}${
          Number.isFinite(amount) ? ` · ${moneyBr(amount)}` : ""
        }${meta.merchant ? ` · ${meta.merchant}` : ""}`
      );
    }
  }

  // Contas pendentes (boletos) com vencimento hoje
  const pendingBills = await db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, input.workspaceId),
      eq(memories.status, "active"),
      eq(memories.sourceType, "pending_bill"),
      isNull(memories.deletedAt)
    ),
    limit: 40,
  });
  for (const r of pendingBills) {
    const meta = (r.metadata || {}) as Record<string, unknown>;
    const d = String(meta.due_date || "");
    if (d === todayStr || d === todayIso || d.includes(todayIso)) {
      const amount = Number(meta.amount);
      dueToday.push(
        `• 🧾 ${meta.merchant || meta.category || "conta"}${
          Number.isFinite(amount) ? ` · ${moneyBr(amount)}` : ""
        } (boleto)`
      );
    }
  }

  const agenda = [
    ...apptRows
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((a) => {
        const at = DateTime.fromJSDate(a.startsAt).setZone(a.timezone || tz);
        return `• 📅 ${at.toFormat("HH:mm")} — ${a.title}`;
      }),
    ...remRows
      .filter((r) => !isInternalTestReminder(r.title, r.payload))
      .filter((r) => {
        const ids = new Set(apptRows.map((a) => a.id));
        const titles = new Set(
          apptRows.map((a) =>
            String(a.title || "")
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
          )
        );
        return !reminderShadowsAppointment(r, ids, titles);
      })
      .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
      .map((r) => {
        const p = (r.payload || {}) as ReminderPayload;
        const money =
          typeof p.amount === "number" && p.amount > 0
            ? ` · ${moneyBr(p.amount)}`
            : "";
        const recur = r.recurrenceRule ? " 🔁" : "";
        const at = DateTime.fromJSDate(r.fireAt).setZone(r.timezone || tz);
        const emoji = emojiForReminder(p, r.title);
        return `• ${emoji} ${at.toFormat("HH:mm")} — ${r.title}${money}${recur}`;
      }),
  ];

  const seenYesterday = new Set<string>();
  const yesterdayLines = yesterdaySent
    .filter((r) => {
      const payload = (r.payload || {}) as Record<string, unknown>;
      if (payload.baixado === true) return false;
      if (/^\[fam[ií]lia→/i.test(r.title)) return false;
      if (/^\d{1,3}\s*minutos?\s+antes$/i.test(r.title.trim())) return false;
      const key = r.title
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!key || seenYesterday.has(key)) return false;
      seenYesterday.add(key);
      return true;
    })
    .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
    .slice(0, 8)
    .map((r) => `• 📌 ${r.title}`);

  const recurExtra = recurSoon
    .filter((r) => !remRows.some((t) => t.id === r.id))
    .slice(0, 5)
    .map((r) => {
      const at = DateTime.fromJSDate(r.fireAt).setZone(r.timezone || tz);
      return `• 🔁 ${at.toFormat("ccc HH:mm", { locale: "pt-BR" })} — ${r.title}`;
    });

  const hasContent =
    agenda.length > 0 ||
    taskRows.length > 0 ||
    dueToday.length > 0 ||
    yesterdayLines.length > 0 ||
    recurExtra.length > 0;

  const hello = input.userName
    ? `Bom dia, ${input.userName.split(" ")[0]}!`
    : "Bom dia!";

  let weatherLine: string | null = null;
  if (input.userId) {
    const { weatherLineForBrief } = await import("@/domain/weather-prefs");
    weatherLine = await weatherLineForBrief(db, input.userId);
  }

  if (!hasContent) {
    // Nunca silenciar de manhã — nudge útil (retenção)
    return [
      `☀️ *Resumo do dia* · ${now.toFormat("ccc dd/LL", { locale: "pt-BR" })}`,
      hello,
      weatherLine ? `\n${weatherLine}` : null,
      "",
      "Agenda livre por enquanto.",
    ]
      .filter((l) => l !== null)
      .join("\n");
  }

  const lines = [
    `☀️ *Resumo do dia* · ${now.toFormat("ccc dd/LL", { locale: "pt-BR" })}`,
    hello,
    weatherLine ? `\n${weatherLine}` : null,
    "",
    agenda.length
      ? `*Agenda de hoje:*\n${agenda.join("\n")}`
      : "*Agenda de hoje:* livre por enquanto",
    yesterdayLines.length
      ? `\n*Ainda de ontem:*\n${yesterdayLines.join("\n")}`
      : null,
    recurExtra.length
      ? `\n*Recorrentes próximos:*\n${recurExtra.join("\n")}`
      : null,
    dueToday.length
      ? `\n*Vence hoje:*\n${dueToday.slice(0, 5).join("\n")}`
      : null,
    taskRows.length
      ? `\n*Tarefas abertas* (${uniqueTaskTitles(taskRows).length}):\n${uniqueTaskTitles(taskRows)
          .slice(0, 8)
          .map((title) => `• ${title}`)
          .join("\n")}`
      : null,
  ].filter((l) => l !== null);

  return lines.join("\n");
}
