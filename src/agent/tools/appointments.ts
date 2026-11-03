import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import { appointments, reminders, users } from "@/db/schema";
import { dayRange, formatInTimezone } from "@/lib/datetime";
import { parseRecurrenceFromText } from "@/lib/recurrence";
import { withinReceiptWindow } from "@/domain/receipt-undo";
import { registerTool } from "./registry";

async function findAppointment(
  ctx: { db: import("@/db/client").Db; workspaceId: string },
  opts: { id?: string; title_query?: string; last?: boolean }
) {
  if (opts.id) {
    return (
      (await ctx.db.query.appointments.findFirst({
        where: and(
          eq(appointments.id, opts.id),
          eq(appointments.workspaceId, ctx.workspaceId),
          isNull(appointments.deletedAt)
        ),
      })) || null
    );
  }
  if (opts.title_query) {
    const q = opts.title_query.toLowerCase();
    const rows = await ctx.db.query.appointments.findMany({
      where: and(
        eq(appointments.workspaceId, ctx.workspaceId),
        eq(appointments.status, "scheduled"),
        isNull(appointments.deletedAt)
      ),
      orderBy: [desc(appointments.startsAt)],
      limit: 30,
    });
    return rows.find((a) => a.title.toLowerCase().includes(q)) || null;
  }
  if (opts.last) {
    const rows = await ctx.db.query.appointments.findMany({
      where: and(
        eq(appointments.workspaceId, ctx.workspaceId),
        eq(appointments.status, "scheduled"),
        isNull(appointments.deletedAt)
      ),
      orderBy: [desc(appointments.createdAt)],
      limit: 1,
    });
    return rows[0] || null;
  }
  return null;
}

registerTool({
  name: "create_appointment",
  description:
    "Agenda um compromisso. Para Meet, não invente data/horário nem participantes: pergunte o que faltar; se não disser se quer convidados, pergunte se será só a pessoa ou quem participa. Duração padrão: 60 minutos. Use create_meet=true para gerar link. Passe convidados em also_notify ou identifique o grupo; sempre abra seleção e peça confirmação antes de avisar qualquer pessoa. Preserve link/material e use recurrence_rule quando solicitado.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      starts_at_iso: { type: "string" },
      ends_at_iso: { type: "string" },
      timezone: { type: "string" },
      description: { type: "string" },
      meet_url: { type: "string", description: "Link do Meet ou material que deve acompanhar o convite." },
      create_meet: { type: "boolean", description: "Criar Google Meet no Calendar do organizador, se conectado." },
      recurrence_rule: { type: "string", description: "Regra suportada: daily, weekly, weekly:1..7 ou monthly." },
      reminder_before_minutes: {
        type: "integer",
        description: "Minutos antes do compromisso para avisar o organizador (ex.: 10).",
      },
      also_notify: {
        type: "array",
        items: { type: "string" },
        description: "Contatos salvos que o usuário identificou como convidados; solicitar seleção/confirmação antes do envio.",
      },
      force: {
        type: "boolean",
        description: "true se o usuário confirmou marcar mesmo com conflito",
      },
    },
    required: ["title", "starts_at_iso"],
  },
  async handler(ctx, args) {
    const title = String(args.title || "").trim();
    const timezone = String(args.timezone || ctx.timezone);
    const startsAt = new Date(String(args.starts_at_iso));
    if (!title || Number.isNaN(startsAt.getTime())) {
      return { ok: false, summary: "Dados inválidos", errorCode: "invalid_args" };
    }
    if (startsAt.getTime() <= Date.now()) {
      return {
        ok: false,
        summary: "Esse horário já passou. Qual data e horário futuro devo usar?",
        errorCode: "appointment_in_past",
      };
    }
    const endsAt = args.ends_at_iso ? new Date(String(args.ends_at_iso)) : null;
    const description = String(args.description || "").trim();
    const meetUrl = String(args.meet_url || "").trim() ||
      description.match(/https:\/\/[^\s<>]+/i)?.[0] ||
      String(ctx.userText || "").match(/https:\/\/[^\s<>]+/i)?.[0] ||
      null;
    const recurrenceRule = args.recurrence_rule
      ? String(args.recurrence_rule).trim().slice(0, 256)
      : parseRecurrenceFromText(ctx.userText || "");
    const { reminderMinutesFromText } = await import("@/domain/appointment-intent");
    const explicitMinutes = Number(args.reminder_before_minutes);
    const reminderOffsetValue =
      args.reminder_before_minutes != null && Number.isFinite(explicitMinutes)
        ? explicitMinutes
        : reminderMinutesFromText(String(ctx.userText || ""));
    const reminderBeforeMinutes = Number.isFinite(reminderOffsetValue)
      ? Math.max(0, Math.min(1440, Math.round(reminderOffsetValue)))
      : 15;
    const wantsMeet = args.create_meet === true ||
      /google\s*meet|\bmeet\b|videochamada|videoconfer[eê]ncia/i.test(String(ctx.userText || ""));
    const { parseAlsoNotifyGroups, parseAlsoNotifyNames } = await import(
      "@/domain/family-contacts"
    );
    const alsoNotify = [...new Set([
      ...(Array.isArray(args.also_notify)
        ? args.also_notify.map(String).map((name) => name.trim()).filter(Boolean)
        : []),
      ...parseAlsoNotifyNames(ctx.userText || ""),
    ])];
    const teamGroupRequested =
      parseAlsoNotifyGroups(ctx.userText || "").length > 0 || alsoNotify.length > 0;

    // Conflito: outro compromisso em ±30 min
    const windowStart = new Date(startsAt.getTime() - 30 * 60_000);
    const windowEnd = new Date(
      (endsAt && !Number.isNaN(endsAt.getTime())
        ? endsAt.getTime()
        : startsAt.getTime()) + 30 * 60_000
    );
    const near = await ctx.db.query.appointments.findMany({
      where: and(
        eq(appointments.workspaceId, ctx.workspaceId),
        eq(appointments.status, "scheduled"),
        isNull(appointments.deletedAt),
        gte(appointments.startsAt, windowStart),
        lte(appointments.startsAt, windowEnd)
      ),
      limit: 5,
    });

    const said = String(ctx.userText || "").trim();
    const force =
      /\b(mesmo assim|pode marcar|confirma|for[cç]a|pode agendar|sim,? marca)\b/i.test(
        said
      ) ||
      /^(sim|ok|pode|marca|confirma)[.!]?$/i.test(said) ||
      /^(às?\s*)?\d{1,2}([:h]\d{2})?\s*h?$/i.test(said) ||
      args.force === true;

    const sameAlready = near.find((row) => {
      const sameClock = Math.abs(row.startsAt.getTime() - startsAt.getTime()) < 2 * 60_000;
      const left = row.title.toLowerCase();
      const right = title.toLowerCase();
      return sameClock && (left === right || left.includes(right) || right.includes(left));
    });
    if (sameAlready) {
      const when = formatInTimezone(sameAlready.startsAt, sameAlready.timezone || timezone);
      return {
        ok: true,
        summary: [
          `Já está marcado: *${sameAlready.title}*`,
          `🗓️ ${when}`,
          "Diz *desfaz* se o horário ou o assunto estiver errado.",
        ].join("\n"),
        data: {
          appointment_id: sameAlready.id,
          starts_at: sameAlready.startsAt.toISOString(),
          duplicate: true,
        },
      };
    }

    if (near.length > 0 && !force) {
      const when = formatInTimezone(startsAt, timezone);
      return {
        ok: true,
        summary: [
          `⚠️ *Conflito de agenda*`,
          ``,
          `Você pediu *${title}* em ${when}, mas já tem:`,
          ...near.map(
            (a) =>
              `• ${formatInTimezone(a.startsAt, a.timezone || timezone)} — ${a.title}`
          ),
          ``,
          `Quer marcar *mesmo assim*? Responda *sim, marca* ou escolha outro horário.`,
        ].join("\n"),
        data: {
          needs_confirm: true,
          conflicts: near.length,
          title,
          starts_at_iso: startsAt.toISOString(),
        },
      };
    }

    const conflictNote =
      near.length > 0
        ? `\n⚠️ Marcado *mesmo com* ${near.length === 1 ? "outro compromisso" : "outros compromissos"} perto.`
        : "";

    const [row] = await ctx.db
      .insert(appointments)
      .values({
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.userId,
        userId: ctx.userId,
        title,
        description: description || meetUrl,
        startsAt,
        endsAt,
        timezone,
        status: "scheduled",
        metadata: {
          team_event: teamGroupRequested,
          recurrence_rule: recurrenceRule,
          meet_url: meetUrl,
          reminder_before_minutes: reminderBeforeMinutes,
        },
      })
      .returning();

    const alertAt = new Date(
      startsAt.getTime() - reminderBeforeMinutes * 60_000
    );
    const reminderCanBeScheduled = alertAt.getTime() > Date.now() + 60_000;
    if (reminderCanBeScheduled) {
      const [rem] = await ctx.db
        .insert(reminders)
        .values({
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          title: `${reminderBeforeMinutes ? "Lembrete" : "Compromisso"}: ${title}`.slice(0, 500),
          fireAt: alertAt,
          timezone,
          status: "scheduled",
          deliveryChannel: "whatsapp",
          recurrenceRule,
          payload: {
            kind: "compromisso",
            note: `appointment:${row.id}${description ? `\n${description}` : ""}`,
            appointment_id: row.id,
            team_event: teamGroupRequested,
            meet_url: meetUrl,
            reminder_before_minutes: reminderBeforeMinutes,
          },
          nextAttemptAt: alertAt,
        })
        .returning();
      const { ensureReminderOutbox } = await import("@/domain/alert-delivery");
      await ensureReminderOutbox(ctx.db, {
        id: rem.id,
        workspaceId: rem.workspaceId,
        userId: rem.userId,
        title: rem.title,
        fireAt: rem.fireAt,
        payload: (rem.payload || {}) as Record<string, unknown>,
      });
    }

    let googleNote = "";
    let finalMeetUrl = meetUrl;
    let googleEventId: string | undefined;
    try {
      const { autoPushAppointmentToGoogle } = await import(
        "@/integrations/google/auto-push"
      );
      const googleResult = await autoPushAppointmentToGoogle(ctx.db, {
        workspaceId: ctx.workspaceId,
        title,
        startsAt,
        endsAt: endsAt || new Date(startsAt.getTime() + 60 * 60 * 1000),
        timezone,
        description: description || meetUrl,
        createMeet: wantsMeet && !meetUrl,
        recurrenceRule,
        assessorId: `assessor-appt-${row.id}`,
      });
      if (googleResult.note) googleNote = `\n${googleResult.note}`;
      if (googleResult.meetUrl) finalMeetUrl = googleResult.meetUrl;
      googleEventId = googleResult.eventId;
    } catch {
      /* best-effort */
    }

    await ctx.db
      .update(appointments)
      .set({
        metadata: {
          ...((row.metadata || {}) as Record<string, unknown>),
          team_event: teamGroupRequested,
          recurrence_rule: recurrenceRule,
          meet_url: finalMeetUrl,
          google_event_id: googleEventId || null,
        },
        updatedAt: new Date(),
      })
      .where(eq(appointments.id, row.id));
    if (finalMeetUrl || googleEventId) {
      const eventReminderRows = await ctx.db.query.reminders.findMany({
        where: and(
          eq(reminders.workspaceId, ctx.workspaceId),
          eq(reminders.userId, ctx.userId),
          isNull(reminders.deletedAt)
        ),
      });
      for (const eventReminder of eventReminderRows) {
        const reminderPayload = (eventReminder.payload || {}) as Record<string, unknown>;
        if (reminderPayload.appointment_id !== row.id) continue;
        await ctx.db
          .update(reminders)
          .set({
            payload: {
              ...reminderPayload,
              meet_url: finalMeetUrl,
              google_event_id: googleEventId || null,
              recurrence_rule: recurrenceRule,
              note: [
                `appointment:${row.id}`,
                finalMeetUrl ? `Meet: ${finalMeetUrl}` : "",
                description,
              ].filter(Boolean).join("\n"),
            },
            recurrenceRule,
            updatedAt: new Date(),
          })
          .where(eq(reminders.id, eventReminder.id));
      }
    }

    let teamNote = "";
    if (teamGroupRequested) {
      try {
        const owner = await ctx.db.query.users.findFirst({
          where: eq(users.id, ctx.userId),
        });
        const { queueTeamReminderSelection } = await import(
          "@/domain/team-reminders"
        );
        const queued = await queueTeamReminderSelection(ctx.db, {
          ownerUserId: ctx.userId,
          ownerDisplayName: owner?.fullName || owner?.email || null,
          userText: ctx.userText,
          alsoNotifyNames: alsoNotify,
          onlyNamedGroupMembers: alsoNotify.length > 0 &&
            /\b(?:da|do)\s+(?:minha\s+)?lista\b/i.test(ctx.userText || ""),
          title,
          fireAt: startsAt,
          endsAt: endsAt || new Date(startsAt.getTime() + 60 * 60 * 1000),
          timezone,
          recurrenceRule,
          payload: {
            kind: "compromisso",
            appointment_id: row.id,
            note: description || null,
            meet_url: finalMeetUrl,
            meet_required: wantsMeet,
            google_event_id: googleEventId || null,
          },
        });
        teamNote = queued.note;
      } catch {
        teamNote = "\n⚠️ Compromisso pessoal criado; não consegui preparar convites da equipe. Nenhum convidado foi avisado.";
      }
    }

    return {
      ok: true,
      summary: [
        `✅ *Marcado:* ${title}`,
        `🗓️ ${formatInTimezone(startsAt, timezone)}`,
        reminderCanBeScheduled
          ? reminderBeforeMinutes > 0
            ? `🔔 Te aviso ${
                reminderBeforeMinutes === 30
                  ? "meia hora antes"
                  : reminderBeforeMinutes === 60
                    ? "1 hora antes"
                    : `${reminderBeforeMinutes} min antes`
              } · ${formatInTimezone(alertAt, timezone)}`
            : "🔔 Te aviso na hora."
          : "⚠️ Horário perto demais para um aviso antes.",
        recurrenceRule ? `🔁 Repete: ${recurrenceRule}` : "",
        finalMeetUrl ? `🎥 ${finalMeetUrl}` : "",
        conflictNote,
        googleNote,
        teamNote,
        "Diz *desfaz* se o horário ou o assunto estiver errado.",
      ]
        .filter(Boolean)
        .join("\n"),
      data: {
        appointment_id: row.id,
        starts_at: startsAt.toISOString(),
        conflicts: near.length,
        meet_url: finalMeetUrl,
        recurrence_rule: recurrenceRule,
      },
    };
  },
});

registerTool({
  name: "list_appointments",
  description:
    "Não use para “o que tenho hoje/amanhã” nem “agenda do dia” — isso é list_reminders, uma lista só. Use só para achar um compromisso por id ao remarcar.",
  inputSchema: {
    type: "object",
    properties: {
      date_iso: { type: "string" },
      timezone: { type: "string" },
    },
  },
  async handler(ctx, args) {
    const timezone = String(args.timezone || ctx.timezone);
    if (args.date_iso) {
      const { formatDayAgenda, loadDayAgenda } = await import("@/domain/day-agenda");
      const items = await loadDayAgenda(
        ctx.db,
        ctx.workspaceId,
        timezone,
        String(args.date_iso)
      );
      return {
        ok: true,
        summary: formatDayAgenda(items, timezone, String(args.date_iso)),
        data: { appointments: items.map((item) => ({ title: item.title })) },
      };
    }
    const conditions = [
      eq(appointments.workspaceId, ctx.workspaceId),
      isNull(appointments.deletedAt),
      eq(appointments.status, "scheduled"),
    ];
    if (args.date_iso) {
      const day = DateTime.fromISO(String(args.date_iso), { zone: timezone });
      const { start, end } = dayRange(day);
      conditions.push(gte(appointments.startsAt, start));
      conditions.push(lte(appointments.startsAt, end));
    }
    const rows = await ctx.db.query.appointments.findMany({
      where: and(...conditions),
    });
    const sorted = [...rows].sort(
      (a, b) => a.startsAt.getTime() - b.startsAt.getTime()
    );
    if (!sorted.length) {
      return {
        ok: true,
        summary: "📭 Nenhum compromisso nesse período.",
        data: { appointments: [] },
      };
    }
    const lines = [
      `📅 *Compromissos* (${sorted.length})`,
      "",
      ...sorted.map((a) => {
        const when = formatInTimezone(a.startsAt, a.timezone);
        return `• 🗓️ *${a.title}*\n  ${when}`;
      }),
    ];
    return {
      ok: true,
      summary: lines.join("\n"),
      data: {
        appointments: sorted.map((a) => ({
          id: a.id,
          title: a.title,
          starts_at: a.startsAt.toISOString(),
        })),
      },
    };
  },
});

registerTool({
  name: "update_appointment",
  description:
    "Remarca/edita compromisso (título ou horário). Use 'muda o dentista pra quinta', 'adia 1h'. Sem id, busca por título ou o último.",
  inputSchema: {
    type: "object",
    properties: {
      appointment_id: { type: "string" },
      title_query: { type: "string" },
      title: { type: "string" },
      starts_at_iso: { type: "string" },
      ends_at_iso: { type: "string" },
      description: { type: "string" },
      meet_url: { type: "string" },
      recurrence_rule: { type: "string" },
      create_meet: { type: "boolean" },
      stop_recurrence: { type: "boolean", description: "Encerra a recorrência da série." },
    },
  },
  async handler(ctx, args) {
    const row = await findAppointment(ctx, {
      id: args.appointment_id ? String(args.appointment_id) : undefined,
      title_query: args.title_query ? String(args.title_query) : undefined,
      last: !args.appointment_id && !args.title_query,
    });
    if (!row) {
      return {
        ok: false,
        summary: "Não achei esse compromisso.",
        errorCode: "not_found",
      };
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    const changes: string[] = [];
    if (args.title) {
      patch.title = String(args.title).trim().slice(0, 500);
      changes.push(`título=${patch.title}`);
    }
    if (args.starts_at_iso) {
      const startsAt = new Date(String(args.starts_at_iso));
      if (Number.isNaN(startsAt.getTime())) {
        return { ok: false, summary: "Data/hora inválida", errorCode: "invalid_args" };
      }
      patch.startsAt = startsAt;
      changes.push(`quando=${formatInTimezone(startsAt, row.timezone)}`);
    }
    if (args.ends_at_iso) {
      const endsAt = new Date(String(args.ends_at_iso));
      if (!Number.isNaN(endsAt.getTime())) patch.endsAt = endsAt;
    }
    if (args.description) {
      patch.description = String(args.description);
      changes.push("descrição atualizada");
    }
    if (args.meet_url || args.create_meet === true) changes.push("Meet/material atualizado");
    const stopRecurrence = args.stop_recurrence === true ||
      /(?:nao|sem)\s+(?:mais\s+)?(?:recorrencia|repetir)|so\s+(?:desta|essa)\s+vez/i.test(String(ctx.userText || ""));
    if (args.recurrence_rule || stopRecurrence) changes.push("recorrência atualizada");
    const oldMeta = (row.metadata || {}) as Record<string, unknown>;
    const updatedMeetUrl = args.meet_url
      ? String(args.meet_url).trim()
      : typeof oldMeta.meet_url === "string"
        ? oldMeta.meet_url
        : null;
    const wantsMeet = args.create_meet === true ||
      /google\s*meet|\bmeet\b|videochamada|videoconfer[eê]ncia/i.test(String(ctx.userText || ""));
    const recurrenceRule = stopRecurrence
      ? null
      : args.recurrence_rule
        ? String(args.recurrence_rule).trim().slice(0, 256)
        : typeof oldMeta.recurrence_rule === "string"
          ? oldMeta.recurrence_rule
          : null;
    patch.metadata = {
      ...oldMeta,
      meet_url: updatedMeetUrl,
      recurrence_rule: recurrenceRule,
    };
    if (!changes.length) {
      return {
        ok: false,
        summary: "Diga o que mudar (dia, hora ou título).",
        errorCode: "empty",
      };
    }
    await ctx.db
      .update(appointments)
      .set(patch)
      .where(
        and(
          eq(appointments.id, row.id),
          eq(appointments.workspaceId, ctx.workspaceId)
        )
      );
    const nextTitle = String(patch.title || row.title);
    const nextStartsAt = patch.startsAt instanceof Date ? patch.startsAt : row.startsAt;
    const nextEndsAt = patch.endsAt instanceof Date ? patch.endsAt : row.endsAt;
    const { autoPushAppointmentToGoogle } = await import(
      "@/integrations/google/auto-push"
    );
    const googleResult = await autoPushAppointmentToGoogle(ctx.db, {
      workspaceId: ctx.workspaceId,
      title: nextTitle,
      startsAt: nextStartsAt,
      endsAt: nextEndsAt || new Date(nextStartsAt.getTime() + 60 * 60 * 1000),
      timezone: row.timezone,
      description: String(patch.description || row.description || updatedMeetUrl || ""),
      createMeet: wantsMeet && !updatedMeetUrl,
      recurrenceRule,
      assessorId: `assessor-appt-${row.id}`,
      existingEventId: typeof oldMeta.google_event_id === "string"
        ? oldMeta.google_event_id
        : null,
    });
    const finalMeetUrl = updatedMeetUrl || googleResult.meetUrl || null;
    await ctx.db
      .update(appointments)
      .set({
        metadata: {
          ...oldMeta,
          meet_url: finalMeetUrl,
          recurrence_rule: recurrenceRule,
          google_event_id: googleResult.eventId || oldMeta.google_event_id || null,
        },
        updatedAt: new Date(),
      })
      .where(eq(appointments.id, row.id));
    const { rescheduleAppointmentTeamDeliveries } = await import(
      "@/domain/team-reminders"
    );
    const teamReschedule = await rescheduleAppointmentTeamDeliveries(ctx.db, {
      appointmentId: row.id,
      title: nextTitle,
      startsAt: nextStartsAt,
      recurrenceRule,
      meetUrl: finalMeetUrl,
      note: String(patch.description || row.description || "") || null,
    });
    const { rescheduleAppointmentOwnerReminder } = await import(
      "@/domain/team-reminders"
    );
    await rescheduleAppointmentOwnerReminder(ctx.db, {
      appointmentId: row.id,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      title: nextTitle,
      startsAt: nextStartsAt,
      recurrenceRule,
      reminderOffsetMinutes: Number(oldMeta.reminder_before_minutes || 0),
      meetUrl: finalMeetUrl,
      note: String(patch.description || row.description || "") || null,
    });
    const when =
      patch.startsAt instanceof Date
        ? formatInTimezone(patch.startsAt, row.timezone)
        : formatInTimezone(row.startsAt, row.timezone);
    return {
      ok: true,
      summary: `Remarquei *${nextTitle}* para ${when}.${finalMeetUrl ? `\n🎥 ${finalMeetUrl}` : ""}${googleResult.note ? `\n${googleResult.note}` : ""}${teamReschedule.externalNoticeFailed.length ? `\n⚠️ Não consegui avisar por template: ${teamReschedule.externalNoticeFailed.join(", ")}. Confira em *grupo ${String(oldMeta.team_group || "Trabalho")}*.` : ""}`,
      data: { appointment_id: row.id, changes },
    };
  },
});

registerTool({
  name: "cancel_appointment",
  description:
    "Cancela um compromisso. Use 'cancela a reunião de quarta', 'desmarca o dentista'.",
  inputSchema: {
    type: "object",
    properties: {
      appointment_id: { type: "string" },
      title_query: { type: "string" },
    },
  },
  async handler(ctx, args) {
    const row = await findAppointment(ctx, {
      id: args.appointment_id ? String(args.appointment_id) : undefined,
      title_query: args.title_query ? String(args.title_query) : undefined,
      last: !args.appointment_id && !args.title_query,
    });
    if (!row) {
      return {
        ok: false,
        summary: "Não achei esse compromisso para cancelar.",
        errorCode: "not_found",
      };
    }
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const { cancelAppointmentTeamDeliveries } = await import(
      "@/domain/team-reminders"
    );
    await cancelAppointmentTeamDeliveries(ctx.db, row.id);
    if (typeof meta.google_event_id === "string") {
      const { deleteAppointmentFromGoogle } = await import(
        "@/integrations/google/auto-push"
      );
      await deleteAppointmentFromGoogle(ctx.db, {
        workspaceId: ctx.workspaceId,
        eventId: meta.google_event_id,
      });
    }
    await ctx.db
      .update(appointments)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(appointments.id, row.id),
          eq(appointments.workspaceId, ctx.workspaceId)
        )
      );
    return {
      ok: true,
      summary: `Cancelei: *${row.title}* (${formatInTimezone(
        row.startsAt,
        row.timezone
      )}).`,
      data: { appointment_id: row.id },
    };
  },
});

registerTool({
  name: "undo_last_appointment",
  description: "Desfaz/cancela o último compromisso criado.",
  inputSchema: {
    type: "object",
    properties: {
      appointment_id: { type: "string" },
      phrase: { type: "string" },
    },
  },
  async handler(ctx, args) {
    const row = await findAppointment(ctx, {
      id: args.appointment_id ? String(args.appointment_id) : undefined,
      title_query: args.phrase ? String(args.phrase) : undefined,
      last: !args.appointment_id && !args.phrase,
    });
    if (!row || !withinReceiptWindow(row.createdAt)) {
      return {
        ok: false,
        summary: "Não achei nada das últimas 24h para desfazer.",
        errorCode: "not_found",
      };
    }
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const { cancelAppointmentTeamDeliveries } = await import(
      "@/domain/team-reminders"
    );
    await cancelAppointmentTeamDeliveries(ctx.db, row.id);
    if (typeof meta.google_event_id === "string") {
      const { deleteAppointmentFromGoogle } = await import(
        "@/integrations/google/auto-push"
      );
      await deleteAppointmentFromGoogle(ctx.db, {
        workspaceId: ctx.workspaceId,
        eventId: meta.google_event_id,
      });
    }
    await ctx.db
      .update(appointments)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(appointments.id, row.id),
          eq(appointments.workspaceId, ctx.workspaceId)
        )
      );
    return {
      ok: true,
      summary: `Desfiz o compromisso *${row.title}*.`,
      data: { appointment_id: row.id },
    };
  },
});
