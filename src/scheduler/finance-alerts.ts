import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import {
  conversations,
  memories,
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
  checkSpendingLimitAlert,
} from "@/agent/tools/goals";
import { getNotificationPrefs } from "@/domain/user-preferences";
import { logger } from "@/lib/logger";

function moneyBr(n: number) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function matchesDay(due: string, day: DateTime): boolean {
  const iso = day.toFormat("yyyy-MM-dd");
  const br = day.toFormat("dd/MM/yyyy");
  return due === iso || due === br || due.includes(iso);
}

/**
 * Alertas proativos de meta (≥80%/estouro) e contas a vencer (hoje/amanhã).
 * Idempotente por workspace+dia via usage_counters.
 */
export async function runFinanceAlerts(
  db: Db,
  opts?: { force?: boolean; onlyWorkspaceId?: string }
) {
  const spNow = DateTime.now().setZone("America/Sao_Paulo");
  // Evita spam: roda janela útil 8h–21h
  if (!opts?.force && (spNow.hour < 8 || spNow.hour >= 21)) {
    return { ran: false, reason: "outside_window", goal: 0, bill: 0 };
  }

  const dayKey = spNow.toFormat("yyyyLLdd");
  const allWs = await db.query.workspaces.findMany({});
  const wsRows = opts?.onlyWorkspaceId
    ? allWs.filter((w) => w.id === opts.onlyWorkspaceId)
    : allWs.slice(0, 400);

  let goalSent = 0;
  let billSent = 0;

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

    const prefs = await getNotificationPrefs(db, owner.id);
    const conv = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.workspaceId, ws.id),
        eq(conversations.userId, owner.id),
        isNull(conversations.deletedAt)
      ),
      orderBy: (c, { desc }) => [desc(c.lastMessageAt)],
    });
    if (!conv?.externalConversationId) continue;

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

    const toolCtx = {
      db,
      workspaceId: ws.id,
      userId: owner.id,
      conversationId: conv.id,
      agentRunId: `finance-alert:${ws.id}`,
      timezone: owner.timezone || "America/Sao_Paulo",
      relatedDocumentId: null as string | null,
    };

    // —— Meta de gastos ——
    if (prefs.goal_alerts) {
      const alert = await checkSpendingLimitAlert(toolCtx);
      if (alert) {
        const level = alert.includes("estourada") ? "over" : "warn80";
        const periodKey = `ga${dayKey}:${level}`;
        const claimed = await claimSendOnce(db, {
          workspaceId: ws.id,
          periodKey,
          metric: "goal_alert",
          force: opts?.force,
        });
        if (claimed) {
          const text = [
            "💸 *Alerta de meta*",
            alert,
            "",
            `_Dica:_ “como estou na meta?” · “preferências”_`,
          ].join("\n");
          const { sendGuardedMessage } = await import("@/domain/outbound-guard");
          const send = await sendGuardedMessage(db, {
            conversationId: conv.externalConversationId,
            message: text,
            idempotencyKey: `goal_alert:${ws.id}:${periodKey}`,
            allowDuplicate: Boolean(opts?.force),
            withinCustomerCareWindow: withinWindow,
            forceTemplate: !withinWindow,
            logicalTemplate: "goal_alert",
          });
          const delivered = isConfirmedDelivery(send);
          await db.insert(messages).values({
            conversationId: conv.id,
            workspaceId: ws.id,
            direction: "outbound",
            status: delivered ? "sent" : "failed",
            bodyText: text,
            contentType: "text",
            correlationId: `goal_alert:${periodKey}`,
            rawPayload: {
              kind: "goal_alert",
              ok: delivered,
              error: send.error || null,
            },
            sentAt: delivered ? new Date() : null,
          });
          if (delivered) {
            goalSent += 1;
            logger.info("goal_alert_sent", { workspace_id: ws.id, level });
          } else if (shouldReleaseSendClaim(send)) {
            await releaseSendClaim(db, {
              workspaceId: ws.id,
              periodKey,
              metric: "goal_alert",
            });
          }
        }
      }
    }

    // —— Contas a vencer (hoje / amanhã) ——
    if (prefs.bill_alerts) {
      const tz = owner.timezone || "America/Sao_Paulo";
      const today = DateTime.now().setZone(tz).startOf("day");
      const tomorrow = today.plus({ days: 1 });
      const pending = await db.query.memories.findMany({
        where: and(
          eq(memories.workspaceId, ws.id),
          eq(memories.status, "active"),
          eq(memories.sourceType, "pending_bill"),
          isNull(memories.deletedAt)
        ),
        limit: 40,
      });
      const dueLines: string[] = [];
      for (const p of pending) {
        const meta = (p.metadata || {}) as Record<string, unknown>;
        const due = String(meta.due_date || "");
        if (!due) continue;
        const when = matchesDay(due, today)
          ? "hoje"
          : matchesDay(due, tomorrow)
            ? "amanhã"
            : null;
        if (!when) continue;
        const amount = Number(meta.amount);
        dueLines.push(
          `• ${when === "hoje" ? "🔴" : "🟡"} Vence *${when}*: ${
            meta.merchant || meta.category || "conta"
          }${Number.isFinite(amount) ? ` · ${moneyBr(amount)}` : ""}`
        );
      }
      // Também expenses com date = hoje/amanhã (contas lançadas)
      const expenses = await db.query.memories.findMany({
        where: and(
          eq(memories.workspaceId, ws.id),
          eq(memories.status, "active"),
          eq(memories.sourceType, "expense"),
          isNull(memories.deletedAt)
        ),
        limit: 80,
      });
      for (const e of expenses) {
        const meta = (e.metadata || {}) as Record<string, unknown>;
        const due = String(meta.date || "");
        if (!due) continue;
        const when = matchesDay(due, today)
          ? "hoje"
          : matchesDay(due, tomorrow)
            ? "amanhã"
            : null;
        if (!when) continue;
        const amount = Number(meta.amount);
        dueLines.push(
          `• ${when === "hoje" ? "🔴" : "🟡"} ${
            meta.merchant || meta.category || "gasto"
          }${Number.isFinite(amount) ? ` · ${moneyBr(amount)}` : ""} (*${when}*)`
        );
      }

      if (dueLines.length) {
        const periodKey = `bd${dayKey}`;
        const claimed = await claimSendOnce(db, {
          workspaceId: ws.id,
          periodKey,
          metric: "bill_due_alert",
          force: opts?.force,
        });
        if (claimed) {
          const text = [
            "📅 *Contas a vencer*",
            ...dueLines.slice(0, 8),
            "",
            `_Dica:_ mande o boleto em foto ou diga “paguei a conta”_`,
          ].join("\n");
          const { sendGuardedMessage } = await import("@/domain/outbound-guard");
          const send = await sendGuardedMessage(db, {
            conversationId: conv.externalConversationId,
            message: text,
            idempotencyKey: `bill_due:${ws.id}:${periodKey}`,
            allowDuplicate: Boolean(opts?.force),
            withinCustomerCareWindow: withinWindow,
            forceTemplate: !withinWindow,
            logicalTemplate: "bill_due",
          });
          const delivered = isConfirmedDelivery(send);
          await db.insert(messages).values({
            conversationId: conv.id,
            workspaceId: ws.id,
            direction: "outbound",
            status: delivered ? "sent" : "failed",
            bodyText: text,
            contentType: "text",
            correlationId: `bill_due:${periodKey}`,
            rawPayload: {
              kind: "bill_due",
              ok: delivered,
              error: send.error || null,
            },
            sentAt: delivered ? new Date() : null,
          });
          if (delivered) {
            billSent += 1;
            logger.info("bill_due_alert_sent", {
              workspace_id: ws.id,
              n: dueLines.length,
            });
          } else if (shouldReleaseSendClaim(send)) {
            await releaseSendClaim(db, {
              workspaceId: ws.id,
              periodKey,
              metric: "bill_due_alert",
            });
          }
        }
      }
    }
  }

  return { ran: true, reason: "ok", goal: goalSent, bill: billSent };
}
