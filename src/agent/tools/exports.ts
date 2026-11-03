import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import { appointments, conversations, memories, reminders } from "@/db/schema";
import { createZernioClient } from "@/channels/zernio";
import { resolveZernioRuntimeConfig } from "@/domain/providers";
import { registerTool } from "./registry";
import type { ReminderPayload } from "@/lib/reminder-copy";
import {
  emojiForReminder,
  isInternalTestReminder,
} from "@/lib/reminder-copy";

function moneyBr(n: number) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function csvEscape(v: string) {
  if (/[",\n;]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function icsEscape(v: string) {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function toIcsUtc(d: Date): string {
  return DateTime.fromJSDate(d).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
}

async function sendFileToChat(
  ctx: {
    db: import("@/db/client").Db;
    conversationId: string;
  },
  input: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    caption: string;
    idempotencyKey: string;
  }
): Promise<{ ok: boolean; summary: string; errorCode?: string }> {
  const conversation = await ctx.db.query.conversations.findFirst({
    where: eq(conversations.id, ctx.conversationId),
  });
  const externalId = conversation?.externalConversationId;
  if (!externalId) {
    return {
      ok: false,
      summary: "Não achei o canal do WhatsApp para enviar o arquivo.",
      errorCode: "no_channel",
    };
  }
  const cfg = await resolveZernioRuntimeConfig(ctx.db);
  const client = createZernioClient({
    mock: cfg.mock,
    apiKey: cfg.apiKey,
    apiUrl: cfg.apiUrl,
    accountId: cfg.accountId,
  });
  const uploaded = await client.uploadMedia({
    buffer: input.buffer,
    filename: input.filename,
    mimeType: input.mimeType,
  });
  if (!uploaded.ok || !uploaded.url) {
    return {
      ok: false,
      summary: "Gerei o arquivo, mas falhou o upload. Tenta de novo em instantes.",
      errorCode: "upload_failed",
    };
  }
  const send = await client.sendMedia({
    conversationId: externalId,
    attachmentUrl: uploaded.url,
    attachmentType: "file",
    message: input.caption,
    attachmentName: input.filename,
    idempotencyKey: input.idempotencyKey,
    accountId: cfg.accountId || undefined,
  });
  if (!send.ok) {
    return {
      ok: false,
      summary: "Arquivo pronto, mas o WhatsApp não aceitou o envio agora.",
      errorCode: "send_failed",
    };
  }
  // Caption já vai no arquivo — não repetir em sendText.
  return { ok: true, summary: "" };
}

async function loadExpensesInMonth(
  ctx: { db: import("@/db/client").Db; workspaceId: string; timezone: string },
  month?: string
) {
  const tz = ctx.timezone || "America/Sao_Paulo";
  const now = DateTime.now().setZone(tz);
  let start = now.startOf("month");
  let end = now.endOf("month");
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    start = DateTime.fromISO(`${month}-01`, { zone: tz }).startOf("month");
    end = start.endOf("month");
  }

  const rows = await ctx.db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, ctx.workspaceId),
      eq(memories.status, "active"),
      eq(memories.sourceType, "expense"),
      isNull(memories.deletedAt)
    ),
    orderBy: (m, { desc }) => [desc(m.createdAt)],
    limit: 500,
  });

  const items: Array<{
    date: string;
    category: string;
    amount: number;
    merchant: string;
    note: string;
  }> = [];

  for (const r of rows) {
    const meta = (r.metadata || {}) as Record<string, unknown>;
    let when = DateTime.fromJSDate(r.createdAt).setZone(tz);
    if (typeof meta.date === "string" && meta.date) {
      const iso = DateTime.fromISO(meta.date, { zone: tz });
      const br = DateTime.fromFormat(meta.date, "dd/MM/yyyy", { zone: tz });
      if (iso.isValid) when = iso;
      else if (br.isValid) when = br;
    }
    if (when < start || when > end) continue;
    const amount = Number(meta.amount);
    if (!Number.isFinite(amount)) continue;
    items.push({
      date: when.toFormat("dd/LL/yyyy"),
      category: String(meta.category || "outro"),
      amount,
      merchant: meta.merchant ? String(meta.merchant) : "",
      note: String(meta.note || r.content || "").slice(0, 120),
    });
  }

  return {
    start,
    end,
    label: start.toFormat("LLLL yyyy", { locale: "pt-BR" }),
    monthKey: start.toFormat("yyyy-MM"),
    items,
  };
}

registerTool({
  name: "export_expenses_sheet",
  description:
    "Gera e envia planilha CSV dos gastos (Excel/Sheets). Use quando pedirem planilha, CSV, exportar gastos, Excel, Google Sheets.",
  inputSchema: {
    type: "object",
    properties: {
      month: { type: "string", description: "YYYY-MM opcional" },
    },
  },
  async handler(ctx, args) {
    const month = args.month ? String(args.month).trim() : undefined;
    const pack = await loadExpensesInMonth(ctx, month);
    if (!pack.items.length) {
      return {
        ok: true,
        summary: `Ainda não tenho gastos em ${pack.label} para montar a planilha 📊`,
        data: { count: 0, month: pack.monthKey },
      };
    }

    const header = "data;categoria;valor;estabelecimento;nota";
    const lines = pack.items.map((i) =>
      [
        i.date,
        csvEscape(i.category),
        i.amount.toFixed(2).replace(".", ","),
        csvEscape(i.merchant),
        csvEscape(i.note),
      ].join(";")
    );
    const total = pack.items.reduce((s, i) => s + i.amount, 0);
    const csv = `\uFEFF${header}\n${lines.join("\n")}\n;;;TOTAL;${total
      .toFixed(2)
      .replace(".", ",")}\n`;
    const filename = `gastos-${pack.monthKey}.csv`;
    const buffer = Buffer.from(csv, "utf8");

    const sent = await sendFileToChat(ctx, {
      buffer,
      filename,
      mimeType: "text/csv",
      caption: `📊 Planilha de ${pack.label}: *${pack.items.length} gastos* · total ${moneyBr(total)}\nAbre no Excel, Numbers ou Google Sheets.`,
      idempotencyKey: `export-csv:${ctx.workspaceId}:${pack.monthKey}:${Date.now()}`,
    });
    if (!sent.ok) return sent;
    return {
      ok: true,
      summary: sent.summary,
      data: {
        count: pack.items.length,
        total,
        month: pack.monthKey,
        filename,
        sent: true,
      },
    };
  },
});

registerTool({
  name: "export_expenses_pdf",
  description:
    "Gera e envia PDF dos gastos do mês no WhatsApp. Use quando pedirem PDF, relatório em PDF, 'me manda um pdf dos gastos'.",
  inputSchema: {
    type: "object",
    properties: {
      month: { type: "string", description: "YYYY-MM opcional" },
    },
  },
  async handler(ctx, args) {
    const { buildReportPdf } = await import("@/lib/report-pdf");
    const { DateTime } = await import("luxon");
    const month = args.month ? String(args.month).trim() : undefined;
    const pack = await loadExpensesInMonth(ctx, month);
    if (!pack.items.length) {
      return {
        ok: true,
        summary: `Ainda não tenho gastos em ${pack.label} para montar o PDF 📄`,
        data: { count: 0, month: pack.monthKey },
      };
    }
    const total = pack.items.reduce((s, i) => s + i.amount, 0);
    const byCat = new Map<string, number>();
    for (const i of pack.items) {
      byCat.set(i.category, (byCat.get(i.category) || 0) + i.amount);
    }
    const topCats = [...byCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const tz = ctx.timezone || "America/Sao_Paulo";
    const nowLabel = DateTime.now().setZone(tz).toFormat("dd/LL/yyyy HH:mm");
    const buffer = buildReportPdf({
      brand: "Assessor MOOPE",
      title: `Gastos — ${pack.label}`,
      subtitle: "Relatorio pessoal de despesas",
      generatedAt: nowLabel,
      kpis: [
        { label: "Total", value: moneyBr(total) },
        { label: "Lancamentos", value: String(pack.items.length) },
        {
          label: "Ticket medio",
          value: moneyBr(total / Math.max(pack.items.length, 1)),
        },
        {
          label: "Maior categoria",
          value: topCats[0]
            ? `${topCats[0][0]} ${moneyBr(topCats[0][1])}`
            : "—",
        },
      ],
      sections: [
        {
          title: "Por categoria",
          rows: topCats.map(([c, v]) => `• ${c}: ${moneyBr(v)}`),
        },
        {
          title: "Lancamentos",
          rows: pack.items.map(
            (i) =>
              `${i.date}  ${moneyBr(i.amount)}  ${i.category}${i.merchant ? `  · ${i.merchant}` : ""}`
          ),
        },
      ],
    });
    const filename = `gastos-${pack.monthKey}.pdf`;
    const sent = await sendFileToChat(ctx, {
      buffer,
      filename,
      mimeType: "application/pdf",
      caption: `📄 Relatório de ${pack.label}: *${pack.items.length} gastos* · total ${moneyBr(total)}`,
      idempotencyKey: `export-pdf:${ctx.workspaceId}:${pack.monthKey}:${Date.now()}`,
    });
    if (!sent.ok) return sent;
    return {
      ok: true,
      summary: sent.summary,
      data: { count: pack.items.length, total, month: pack.monthKey, filename },
    };
  },
});

registerTool({
  name: "export_agenda_ics",
  description:
    "Gera arquivo .ics da agenda (lembretes + compromissos) para importar no Google Agenda, Outlook/Hotmail ou Apple. Use para 'manda pra minha agenda', 'Google Calendar', 'Outlook', 'sincronizar agenda'.",
  inputSchema: {
    type: "object",
    properties: {
      days_ahead: {
        type: "number",
        description: "Janela em dias (padrão 60)",
      },
    },
  },
  async handler(ctx, args) {
    const tz = ctx.timezone || "America/Sao_Paulo";
    const days = Math.min(Math.max(Number(args.days_ahead) || 60, 7), 180);
    const now = DateTime.now().setZone(tz);
    const until = now.plus({ days }).endOf("day");

    const remRows = await ctx.db.query.reminders.findMany({
      where: and(
        eq(reminders.workspaceId, ctx.workspaceId),
        eq(reminders.status, "scheduled"),
        isNull(reminders.deletedAt),
        gte(reminders.fireAt, now.toJSDate()),
        lte(reminders.fireAt, until.toJSDate())
      ),
      limit: 100,
    });

    const apptRows = await ctx.db.query.appointments.findMany({
      where: and(
        eq(appointments.workspaceId, ctx.workspaceId),
        eq(appointments.status, "scheduled"),
        isNull(appointments.deletedAt),
        gte(appointments.startsAt, now.toJSDate()),
        lte(appointments.startsAt, until.toJSDate())
      ),
      limit: 100,
    });

    if (!remRows.length && !apptRows.length) {
      return {
        ok: true,
        summary: `Não achei lembretes/compromissos nos próximos ${days} dias para exportar 📅`,
        data: { count: 0 },
      };
    }

    const stamp = toIcsUtc(new Date());
    const events: string[] = [];

    for (const r of remRows) {
      const start = DateTime.fromJSDate(r.fireAt).setZone(r.timezone || tz);
      const end = start.plus({ minutes: 30 });
      const payload = (r.payload || {}) as ReminderPayload;
      const amount =
        typeof payload.amount === "number" && payload.amount > 0
          ? ` · ${moneyBr(payload.amount)}`
          : "";
      const desc = payload.note ? String(payload.note) : "Lembrete MOOPE Assessor";
      events.push(
        [
          "BEGIN:VEVENT",
          `UID:reminder-${r.id}@assessor.moope.com.br`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${toIcsUtc(start.toJSDate())}`,
          `DTEND:${toIcsUtc(end.toJSDate())}`,
          `SUMMARY:${icsEscape(`🔔 ${r.title}${amount}`)}`,
          `DESCRIPTION:${icsEscape(desc)}`,
          "END:VEVENT",
        ].join("\r\n")
      );
    }

    for (const a of apptRows) {
      const start = DateTime.fromJSDate(a.startsAt).setZone(a.timezone || tz);
      const end = a.endsAt
        ? DateTime.fromJSDate(a.endsAt).setZone(a.timezone || tz)
        : start.plus({ hours: 1 });
      events.push(
        [
          "BEGIN:VEVENT",
          `UID:appt-${a.id}@assessor.moope.com.br`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${toIcsUtc(start.toJSDate())}`,
          `DTEND:${toIcsUtc(end.toJSDate())}`,
          `SUMMARY:${icsEscape(`📅 ${a.title}`)}`,
          `DESCRIPTION:${icsEscape(a.description || "Compromisso MOOPE Assessor")}`,
          "END:VEVENT",
        ].join("\r\n")
      );
    }

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//MOOPE Assessor//PT-BR",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:Assessor MOOPE`,
      ...events,
      "END:VCALENDAR",
      "",
    ].join("\r\n");

    const filename = `agenda-assessor-${now.toFormat("yyyy-LL-dd")}.ics`;
    const sent = await sendFileToChat(ctx, {
      buffer: Buffer.from(ics, "utf8"),
      filename,
      mimeType: "text/calendar",
      caption:
        `📅 Exportei *${remRows.length + apptRows.length} eventos* (.ics)\n` +
        `Abre no *Google Agenda*, *Outlook/Hotmail* ou *Apple Calendar* e importa.\n` +
        `(Sync automático OAuth vem depois — esse arquivo já funciona em qualquer agenda.)`,
      idempotencyKey: `export-ics:${ctx.workspaceId}:${Date.now()}`,
    });
    if (!sent.ok) return sent;
    return {
      ok: true,
      summary: sent.summary,
      data: {
        reminders: remRows.length,
        appointments: apptRows.length,
        filename,
        sent: true,
      },
    };
  },
});

registerTool({
  name: "week_ahead",
  description:
    "Mostra os próximos vencimentos e compromissos (próximos 7–14 dias). Use para 'o que tenho essa semana', 'próximos vencimentos', 'agenda da semana'.",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "number" },
    },
  },
  async handler(ctx, args) {
    const tz = ctx.timezone || "America/Sao_Paulo";
    const days = Math.min(Math.max(Number(args.days) || 7, 3), 30);
    const now = DateTime.now().setZone(tz);
    const until = now.plus({ days }).endOf("day");

    const remRows = await ctx.db.query.reminders.findMany({
      where: and(
        eq(reminders.workspaceId, ctx.workspaceId),
        eq(reminders.status, "scheduled"),
        isNull(reminders.deletedAt),
        gte(reminders.fireAt, now.toJSDate()),
        lte(reminders.fireAt, until.toJSDate())
      ),
      limit: 40,
    });
    const apptRows = await ctx.db.query.appointments.findMany({
      where: and(
        eq(appointments.workspaceId, ctx.workspaceId),
        eq(appointments.status, "scheduled"),
        isNull(appointments.deletedAt),
        gte(appointments.startsAt, now.toJSDate()),
        lte(appointments.startsAt, until.toJSDate())
      ),
      limit: 40,
    });

    type Item = { at: DateTime; line: string };
    const items: Item[] = [];

    for (const r of remRows) {
      if (isInternalTestReminder(r.title, r.payload)) continue;
      const at = DateTime.fromJSDate(r.fireAt).setZone(r.timezone || tz);
      const payload = (r.payload || {}) as ReminderPayload;
      const money =
        typeof payload.amount === "number" && payload.amount > 0
          ? ` · ${moneyBr(payload.amount)}`
          : "";
      const emoji = emojiForReminder(payload, r.title);
      items.push({
        at,
        line: `• ${emoji} ${at.toFormat("ccc dd/LL HH:mm", { locale: "pt-BR" })} — *${r.title}*${money}`,
      });
    }
    for (const a of apptRows) {
      const at = DateTime.fromJSDate(a.startsAt).setZone(a.timezone || tz);
      items.push({
        at,
        line: `• 📅 ${at.toFormat("ccc dd/LL HH:mm", { locale: "pt-BR" })} — *${a.title}*`,
      });
    }

    items.sort((a, b) => a.at.toMillis() - b.at.toMillis());

    if (!items.length) {
      return {
        ok: true,
        summary: `Nos próximos ${days} dias sua agenda está livre ✨ Quer marcar algo ou um lembrete de conta?`,
        data: { count: 0, days },
      };
    }

    const { maybeAppendReportOffer } = await import("@/lib/report-pdf");
    return {
      ok: true,
      summary: maybeAppendReportOffer(
        [
          `🗓️ *Próximos ${days} dias* (${items.length}):`,
          "",
          ...items.map((i) => i.line),
          "",
          `_Dica:_ diga “manda minha agenda em ICS” ou “me manda o relatório da semana”.`,
        ].join("\n"),
        700
      ),
      data: { count: items.length, days },
    };
  },
});
