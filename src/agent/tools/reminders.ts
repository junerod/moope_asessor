import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { reminders, tasks, users } from "@/db/schema";
import { dayRange, resolveReminderFireAt } from "@/lib/datetime";
import {
  formatReminderConfirm,
  formatReminderListItem,
  isInternalTestReminder,
  type ReminderPayload,
} from "@/lib/reminder-copy";
import { parseRecurrenceFromText, describeRecurrence } from "@/lib/recurrence";
import { countScheduledReminders } from "@/domain/rate-limit";
import { getEnv } from "@/config/env";
import { RECEIPT_WINDOW_MS, withinReceiptWindow } from "@/domain/receipt-undo";
import { registerTool } from "./registry";

async function buildUnifiedDay(
  ctx: { db: import("@/db/client").Db; workspaceId: string },
  dateIso: string,
  timezone: string
): Promise<string> {
  const { formatDayAgenda, loadDayAgenda } = await import("@/domain/day-agenda");
  const items = await loadDayAgenda(ctx.db, ctx.workspaceId, timezone, dateIso);
  return formatDayAgenda(items, timezone, dateIso);
}

registerTool({
  name: "create_reminder",
  description:
    "Cria um lembrete. fire_at_iso = PRÓXIMA ocorrência FUTURA. " +
    "Inclua amount (R$) e kind (conta|compromisso|remedio|geral) quando souber. " +
    "Para recorrência use recurrence_rule: daily, weekly, monthly (ou daily@20:00). " +
    "Se o usuário disser todo dia / toda semana / todo mês, SEMPRE passe recurrence_rule. " +
    "Só chame se o usuário deu horário OU for conta com alerta relativo (dias antes / dia X). " +
    "Se faltar horário em 'amanhã/hoje/terça', NÃO chame — pergunte com sugestão. " +
    "Se pedir para avisar um grupo (“avisa o grupo Trabalho”), crie o lembrete pessoal normalmente; o Assessor abrirá seleção numerada e confirmação antes de agendar destinatários. Nunca diga que a equipe foi avisada antes da confirmação. " +
    "Se disser “avisa a Ju também”, passe also_notify: [\"Ju\"] (contato salvo). Não trate cadastro como opt-in; equipe exige autorização individual.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      fire_at_iso: { type: "string" },
      timezone: { type: "string" },
      recurrence_rule: { type: "string" },
      amount: { type: "number" },
      note: { type: "string" },
      kind: {
        type: "string",
        enum: ["conta", "compromisso", "remedio", "geral"],
      },
      also_task: {
        type: "boolean",
        description: "Se true, também cria tarefa aberta (útil em listas do dia).",
      },
      also_notify: {
        type: "array",
        items: { type: "string" },
        description:
          "Nomes da família pra avisar também (ex.: [\"Ju\"]). Use se o usuário disser “avisa a Ju também”.",
      },
    },
    required: ["title", "fire_at_iso"],
  },
  async handler(ctx, args) {
    const title = String(args.title || "").trim();
    const timezone = String(args.timezone || ctx.timezone);
    if (!title || !args.fire_at_iso) {
      return { ok: false, summary: "Dados inválidos", errorCode: "invalid_args" };
    }

    const maxScheduled = getEnv().RATE_LIMIT_MAX_SCHEDULED_REMINDERS;
    const scheduledCount = await countScheduledReminders(ctx.db, ctx.workspaceId);
    if (scheduledCount >= maxScheduled) {
      return {
        ok: false,
        summary: `Você já tem ${scheduledCount} lembretes ativos. Cancele algum antes de criar outro.`,
        errorCode: "reminder_cap",
      };
    }

    const fireAt = resolveReminderFireAt({
      fireAtIso: String(args.fire_at_iso),
      timezone,
      userText: ctx.userText,
    });
    if (Number.isNaN(fireAt.getTime())) {
      return { ok: false, summary: "Horário inválido", errorCode: "invalid_args" };
    }
    const amount =
      typeof args.amount === "number" && Number.isFinite(args.amount)
        ? Number(args.amount)
        : null;
    const payload: ReminderPayload = {
      amount,
      note: args.note ? String(args.note).slice(0, 300) : null,
      kind: args.kind ? String(args.kind) : amount != null ? "conta" : "geral",
    };
    const fromArgs = args.recurrence_rule
      ? String(args.recurrence_rule).trim().slice(0, 256)
      : null;
    const inferred = parseRecurrenceFromText(
      `${ctx.userText || ""} ${title} ${args.note || ""}`
    );
    const recurrenceRule = fromArgs || inferred;

    const [row] = await ctx.db
      .insert(reminders)
      .values({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        title: title.slice(0, 500),
        fireAt,
        timezone,
        status: "scheduled",
        deliveryChannel: "whatsapp",
        recurrenceRule,
        payload,
        nextAttemptAt: fireAt,
      })
      .returning();

    const { ensureReminderOutbox, reminderOccurrenceKey } = await import(
      "@/domain/alert-delivery"
    );
    await ensureReminderOutbox(ctx.db, {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      title: row.title,
      fireAt: row.fireAt,
      payload: (row.payload || {}) as Record<string, unknown>,
    });
    await ctx.db
      .update(reminders)
      .set({
        occurrenceKey: reminderOccurrenceKey(row.id, row.fireAt),
        updatedAt: new Date(),
      })
      .where(eq(reminders.id, row.id));

    // Listas do dia / "preciso fazer" → também vira tarefa aberta (aparece no briefing)
    const wantTask =
      args.also_task === true ||
      /\b(final do dia|lista|tarefas?|pend[eê]ncias?|preciso|verificar|cobrar|falar com|ate (eu )?dar baixa)\b/i.test(
        String(ctx.userText || "")
      );
    if (wantTask) {
      await ctx.db.insert(tasks).values({
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.userId,
        assignedUserId: ctx.userId,
        title: title.slice(0, 500),
        status: "open",
      });
    }

    const recurNote = describeRecurrence(recurrenceRule);
    let googleNote = "";
    try {
      const { autoPushReminderToGoogle } = await import(
        "@/integrations/google/auto-push"
      );
      const line = await autoPushReminderToGoogle(ctx.db, {
        workspaceId: ctx.workspaceId,
        reminderId: row.id,
        title,
        fireAt,
        timezone,
        payload: payload as unknown as Record<string, unknown>,
      });
      if (line) googleNote = `\n${line}`;
    } catch {
      /* best-effort */
    }

    let familyNote = "";
    try {
      const ownerUser = await ctx.db.query.users.findFirst({
        where: eq(users.id, ctx.userId),
      });
      const alsoNotify = Array.isArray(args.also_notify)
        ? args.also_notify.map((n) => String(n)).filter(Boolean)
        : [];
      const { queueTeamReminderSelection } = await import(
        "@/domain/team-reminders"
      );
      const team = await queueTeamReminderSelection(ctx.db, {
        ownerUserId: ctx.userId,
        ownerDisplayName: ownerUser?.fullName || ownerUser?.email || null,
        userText: ctx.userText,
        alsoNotifyNames: alsoNotify,
        title,
        fireAt,
        timezone,
        recurrenceRule,
        payload: payload as unknown as Record<string, unknown>,
      });
      familyNote = team.note;
      if (!team.queued) {
        const { shareReminderToFamily } = await import(
          "@/domain/family-contacts"
        );
        const share = await shareReminderToFamily(ctx.db, {
          ownerUserId: ctx.userId,
          ownerWorkspaceId: ctx.workspaceId,
          ownerDisplayName: ownerUser?.fullName || ownerUser?.email || null,
          userText: ctx.userText,
          alsoNotifyNames: alsoNotify,
          title,
          fireAt,
          timezone,
          recurrenceRule,
          payload: payload as unknown as Record<string, unknown>,
        });
        familyNote = share.note;
      }
    } catch {
      familyNote = "\n⚠️ O lembrete pessoal foi criado, mas não consegui preparar a seleção da equipe. Nenhuma mensagem foi enviada à equipe.";
    }

    return {
      ok: true,
      summary:
        formatReminderConfirm({
          title,
          fireAt,
          timezone,
          payload,
          mode: "single",
        }) +
        (recurNote ? `\n🔁 Repete: ${recurNote}` : "") +
        (wantTask ? "\n✅ Também deixei como *tarefa aberta* (aparece no resumo da manhã)." : "") +
        googleNote +
        familyNote +
        "\nDiz *desfaz* se o horário ou o texto estiver errado.",
      data: {
        reminder_id: row.id,
        fire_at: fireAt.toISOString(),
        title,
        timezone,
        payload,
        recurrence_rule: recurrenceRule,
        also_task: wantTask,
      },
    };
  },
});

registerTool({
  name: "list_reminders",
  description:
    "Lista ÚNICA do dia pessoal (lembrete, compromisso e agenda são a mesma lista). Passe date_iso. Não chame list_appointments junto.",
  inputSchema: {
    type: "object",
    properties: {
      date_iso: { type: "string" },
      timezone: { type: "string" },
    },
  },
  async handler(ctx, args) {
    const timezone = String(args.timezone || ctx.timezone);
    const hasDay = Boolean(args.date_iso);

    if (hasDay) {
      const summary = await buildUnifiedDay(
        ctx,
        String(args.date_iso),
        timezone
      );
      return { ok: true, summary, data: { date_iso: String(args.date_iso) } };
    }

    let rows = await ctx.db.query.reminders.findMany({
      where: and(
        eq(reminders.workspaceId, ctx.workspaceId),
        isNull(reminders.deletedAt)
      ),
    });
    rows = rows.filter((r) => {
      if (isInternalTestReminder(r.title, r.payload)) return false;
      if (hasDay) {
        return (
          r.status === "scheduled" ||
          r.status === "queued" ||
          r.status === "sent"
        );
      }
      return r.status === "scheduled" || r.status === "queued";
    });
    if (hasDay) {
      const day = DateTime.fromISO(String(args.date_iso), { zone: timezone });
      const { start, end } = dayRange(day);
      rows = rows.filter((r) => r.fireAt >= start && r.fireAt <= end);
    }
    rows = [...rows].sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
    if (!rows.length) {
      return {
        ok: true,
        summary: hasDay
          ? "📭 Nada na agenda pessoal nesse dia."
          : "📭 Nenhum lembrete ativo no momento.",
        data: { reminders: [] },
      };
    }
    const lines = [
      `🔔 *Seus avisos* (${rows.length})`,
      "",
      ...rows.map((r) => {
        const p = (r.payload || {}) as ReminderPayload;
        return formatReminderListItem({
          title: r.title,
          fireAt: r.fireAt,
          timezone: r.timezone || timezone,
          payload: p,
          recurrenceRule: r.recurrenceRule,
          status: r.status,
        });
      }),
    ];
    return {
      ok: true,
      summary: lines.join("\n"),
      data: {
        reminders: rows.map((r) => ({
          id: r.id,
          title: r.title,
          fire_at: r.fireAt.toISOString(),
          status: r.status,
        })),
      },
    };
  },
});

registerTool({
  name: "complete_reminder",
  description:
    "Dá baixa em lembrete: para de avisar e cancela recorrência. Use indices da lista de hoje, title_query, reminder_id ou all_past_today.",
  inputSchema: {
    type: "object",
    properties: {
      reminder_id: { type: "string" },
      title_query: { type: "string" },
      indices: { type: "array", items: { type: "number" } },
      all_past_today: { type: "boolean" },
    },
  },
  async handler(ctx, args) {
    const {
      applyBaixaIntent,
      completeReminderById,
      loadTodayReminders,
    } = await import("@/domain/reminder-baixa");

    if (args.all_past_today) {
      return {
        ok: true,
        summary: await applyBaixaIntent(ctx.db, {
          workspaceId: ctx.workspaceId,
          timezone: ctx.timezone,
          intent: { kind: "baixa_all_past" },
        }),
      };
    }
    if (Array.isArray(args.indices) && args.indices.length) {
      return {
        ok: true,
        summary: await applyBaixaIntent(ctx.db, {
          workspaceId: ctx.workspaceId,
          timezone: ctx.timezone,
          intent: {
            kind: "baixa_indices",
            indices: args.indices.map(Number).filter((n) => n >= 1),
          },
        }),
      };
    }
    if (args.reminder_id) {
      const r = await completeReminderById(ctx.db, {
        workspaceId: ctx.workspaceId,
        reminderId: String(args.reminder_id),
      });
      if (!r.ok) {
        return {
          ok: false,
          summary: "Lembrete não encontrado",
          errorCode: "not_found",
        };
      }
      return { ok: true, summary: `✅ Baixa: *${r.title}*` };
    }
    const q = String(args.title_query || "").trim().toLowerCase();
    if (!q) {
      return {
        ok: false,
        summary: "Diga *baixa 1* ou o título pra eu dar baixa.",
        errorCode: "invalid_args",
      };
    }
    const todayRows = await loadTodayReminders(
      ctx.db,
      ctx.workspaceId,
      ctx.timezone
    );
    let hit = todayRows.find((r) => r.title.toLowerCase().includes(q));
    if (!hit) {
      const all = await ctx.db.query.reminders.findMany({
        where: and(
          eq(reminders.workspaceId, ctx.workspaceId),
          isNull(reminders.deletedAt)
        ),
      });
      const found = all.find(
        (r) =>
          (r.status === "scheduled" ||
            r.status === "queued" ||
            r.status === "sent") &&
          r.title.toLowerCase().includes(q)
      );
      if (found) {
        hit = {
          id: found.id,
          title: found.title,
          fireAt: found.fireAt,
          timezone: found.timezone,
          status: found.status,
          recurrenceRule: found.recurrenceRule,
          payload: found.payload,
        };
      }
    }
    if (!hit) {
      return {
        ok: false,
        summary: `Não achei lembrete com “${args.title_query}”.`,
        errorCode: "not_found",
      };
    }
    const r = await completeReminderById(ctx.db, {
      workspaceId: ctx.workspaceId,
      reminderId: hit.id,
    });
    return { ok: true, summary: `✅ Baixa: *${r.title}*` };
  },
});

registerTool({
  name: "cancel_reminder",
  description: "Cancela um lembrete do workspace.",
  inputSchema: {
    type: "object",
    properties: {
      reminder_id: { type: "string" },
    },
    required: ["reminder_id"],
  },
  async handler(ctx, args) {
    const id = String(args.reminder_id);
    const row = await ctx.db.query.reminders.findFirst({
      where: and(eq(reminders.id, id), eq(reminders.workspaceId, ctx.workspaceId)),
    });
    if (!row) return { ok: false, summary: "Lembrete não encontrado", errorCode: "not_found" };
    const { completeReminderById } = await import("@/domain/reminder-baixa");
    await completeReminderById(ctx.db, {
      workspaceId: ctx.workspaceId,
      reminderId: id,
    });
    return { ok: true, summary: `Lembrete cancelado: ${row.title}` };
  },
});

registerTool({
  name: "undo_last_reminder",
  description: "Desfaz o lembrete gravado nas últimas 24h. Não apaga o que é mais antigo.",
  inputSchema: {
    type: "object",
    properties: {
      reminder_id: { type: "string" },
      phrase: { type: "string" },
    },
  },
  async handler(ctx, args) {
    const since = new Date(Date.now() - RECEIPT_WINDOW_MS);
    let row = args.reminder_id
      ? await ctx.db.query.reminders.findFirst({
          where: and(
            eq(reminders.id, String(args.reminder_id)),
            eq(reminders.workspaceId, ctx.workspaceId),
            eq(reminders.status, "scheduled"),
            isNull(reminders.deletedAt),
            gte(reminders.createdAt, since)
          ),
        })
      : null;
    if (!row) {
      const rows = await ctx.db.query.reminders.findMany({
        where: and(
          eq(reminders.workspaceId, ctx.workspaceId),
          eq(reminders.status, "scheduled"),
          isNull(reminders.deletedAt),
          gte(reminders.createdAt, since)
        ),
        orderBy: [desc(reminders.createdAt)],
        limit: 20,
      });
      const phrase = args.phrase
        ? String(args.phrase)
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
        : "";
      row =
        rows.find((item) => {
          if (!withinReceiptWindow(item.createdAt)) return false;
          if (!phrase) return true;
          return item.title
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .includes(phrase);
        }) || null;
    }
    if (!row || !withinReceiptWindow(row.createdAt)) {
      return {
        ok: false,
        summary: "Não achei nada das últimas 24h para desfazer.",
        errorCode: "not_found",
      };
    }
    await ctx.db
      .update(reminders)
      .set({
        status: "cancelled",
        recurrenceRule: null,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(reminders.id, row.id));
    await ctx.db.execute(sql`
      UPDATE alert_outbox
      SET status = 'cancelled', updated_at = NOW()
      WHERE source_type = 'reminder'
        AND source_id = ${row.id}
        AND status IN ('pending', 'processing', 'failed')
    `);
    return {
      ok: true,
      summary: `Desfiz o lembrete *${row.title}*.`,
      data: { reminder_id: row.id },
    };
  },
});
