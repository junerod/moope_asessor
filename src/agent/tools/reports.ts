/**
 * Relatórios PDF ricos (gastos, semana, locadora) + briefing matinal.
 */
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { appointments, conversations, memories, reminders, tasks } from "@/db/schema";
import { createZernioClient } from "@/channels/zernio";
import { resolveZernioRuntimeConfig } from "@/domain/providers";
import {
  askLocadora,
  resolveLocadoraIntegration,
} from "@/integrations/moope-finance-assessor";
import { buildReportPdf } from "@/lib/report-pdf";
import { buildCsvSheet, buildXlsxSheet } from "@/lib/report-sheet";
import { boardFromLocadora } from "@/domain/locadora-board";
import { appendVisualBoard, emptyBoard } from "@/domain/visual-board";
import type { ReminderPayload } from "@/lib/reminder-copy";
import { registerTool } from "./registry";
import { whatsappIdentities } from "@/db/schema";

function moneyBr(n: number) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function csvEscapeMoney(n: number) {
  return n.toFixed(2).replace(".", ",");
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
  if (
    input.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" &&
    !cfg.mock
  ) {
    const { putPrivateObject, createPrivateObjectDownloadUrl, deletePrivateObject } =
      await import("@/lib/storage/private");
    const storageKey = `temporary-reports/${randomUUID()}/${input.filename}`;
    let storedKey: string | null = null;
    try {
      const stored = await putPrivateObject({
        key: storageKey,
        buffer: input.buffer,
        mimeType: input.mimeType,
      });
      storedKey = stored.storageKey;
      const attachmentUrl = await createPrivateObjectDownloadUrl(
        stored.storageKey,
        input.filename,
        900
      );
      if (!attachmentUrl) {
        return {
          ok: false,
          summary: "Não consegui preparar o link privado da planilha para envio.",
          errorCode: "xlsx_private_link_unavailable",
        };
      }
      const sent = await client.sendMedia({
        conversationId: externalId,
        attachmentUrl,
        attachmentType: "file",
        attachmentName: input.filename,
        message: input.caption,
        idempotencyKey: input.idempotencyKey,
        accountId: cfg.accountId || undefined,
      });
      if (!sent.ok) {
        return {
          ok: false,
          summary: "A planilha ficou pronta, mas o WhatsApp não aceitou o envio.",
          errorCode: "send_failed",
        };
      }
      return { ok: true, summary: "" };
    } catch {
      return {
        ok: false,
        summary: "Não consegui preparar a planilha privada para envio.",
        errorCode: "xlsx_private_upload_failed",
      };
    } finally {
      if (storedKey) {
        try {
          await deletePrivateObject(storedKey);
        } catch {
          // O objeto permanece privado; a URL assinada expira em 15 minutos.
        }
      }
    }
  }
  const uploaded = await client.uploadMedia({
    buffer: input.buffer,
    filename: input.filename,
    mimeType: input.mimeType,
  });
  if (!uploaded.ok || !uploaded.url) {
    return {
      ok: false,
      summary: "Gerei o relatório, mas falhou o upload. Tenta de novo em instantes.",
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
      summary: "Relatório pronto, mas o WhatsApp não aceitou o envio agora.",
      errorCode: "send_failed",
    };
  }
  // Caption já vai no arquivo — não repetir em sendText.
  return { ok: true, summary: "" };
}

/** Envia PDF + planilha Excel (CSV). Se um falhar, tenta o outro. */
async function sendPdfAndSheet(
  ctx: {
    db: import("@/db/client").Db;
    conversationId: string;
    workspaceId: string;
  },
  input: {
    pdf: Buffer;
    pdfName: string;
    sheet: Buffer;
    sheetName: string;
    sheetMimeType?: string;
    captionPdf: string;
    captionSheet: string;
    keyPrefix: string;
  }
): Promise<{
  ok: boolean;
  summary: string;
  errorCode?: string;
  formatsSent?: string[];
  formatsFailed?: string[];
}> {
  const ts = Date.now();
  const pdf = await sendFileToChat(ctx, {
    buffer: input.pdf,
    filename: input.pdfName,
    mimeType: "application/pdf",
    caption: input.captionPdf,
    idempotencyKey: `${input.keyPrefix}:pdf:${ctx.workspaceId}:${ts}`,
  });
  const sheet = await sendFileToChat(ctx, {
    buffer: input.sheet,
    filename: input.sheetName,
    mimeType: input.sheetMimeType || "text/csv",
    caption: input.captionSheet,
    idempotencyKey: `${input.keyPrefix}:xlsx:${ctx.workspaceId}:${ts}`,
  });
  // Arquivo(s) já carregam a legenda no WhatsApp — sem 2ª bolha.
  const formatsSent = [
    ...(pdf.ok ? ["pdf"] : []),
    ...(sheet.ok ? [input.sheetMimeType ? "xlsx" : "csv"] : []),
  ];
  const formatsFailed = [
    ...(!pdf.ok ? ["PDF"] : []),
    ...(!sheet.ok ? ["planilha"] : []),
  ];
  if (formatsSent.length) {
    return {
      ok: true,
      summary: formatsFailed.length
        ? `⚠️ Enviei ${formatsSent.includes("pdf") ? "o PDF" : "a planilha"}, mas não consegui enviar ${formatsFailed.join(" e ")}. Peça novamente para tentar de novo.`
        : "",
      formatsSent,
      formatsFailed,
    };
  }
  return pdf.ok === false ? pdf : sheet;
}

async function phoneFromCtx(ctx: {
  db: import("@/db/client").Db;
  conversationId: string;
}): Promise<string | null> {
  const conv = await ctx.db.query.conversations.findFirst({
    where: eq(conversations.id, ctx.conversationId),
  });
  if (!conv?.whatsappIdentityId) return null;
  const id = await ctx.db.query.whatsappIdentities.findFirst({
    where: eq(whatsappIdentities.id, conv.whatsappIdentityId),
  });
  return id?.phoneE164 || null;
}

async function loadExpensesInMonth(
  ctx: { db: import("@/db/client").Db; workspaceId: string; timezone: string },
  month?: string
) {
  const tz = ctx.timezone || "America/Sao_Paulo";
  const now = DateTime.now().setZone(tz);
  let start = now.startOf("month");
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    start = DateTime.fromISO(`${month}-01`, { zone: tz }).startOf("month");
  }
  const end = start.endOf("month");

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
      note: String(meta.note || r.content || "").slice(0, 80),
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
  name: "generate_report_pdf",
  description:
    "Gera e envia relatório PDF visual + planilha que abre no Excel pelo WhatsApp. Use para relatório, PDF, Excel, planilha de gastos/semana/locadora ou recebimentos da locadora. kind: gastos | semana | locadora_resumo | locadora_alertas | locadora_faturas | locadora_recebimentos. Preserve o período pedido em period (ex.: recebimentos hoje / recebimentos da semana).",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description:
          "gastos | semana | locadora_resumo | locadora_alertas | locadora_faturas | locadora_recebimentos | auto",
      },
      month: { type: "string", description: "YYYY-MM para gastos" },
      placa: { type: "string", description: "Placa opcional (faturas)" },
      days: { type: "number", description: "Dias à frente na semana (padrão 7)" },
      period: {
        type: "string",
        description: "Período de recebimentos, preservado como pedido: hoje, semana ou intervalo informado.",
      },
    },
  },
  async handler(ctx, args) {
    let kind = String(args.kind || "auto").toLowerCase().trim();
    if (kind === "despesas" || kind === "despesa") kind = "gastos";
    if (kind === "agenda") kind = "semana";
    if (kind === "alertas") kind = "locadora_alertas";
    if (kind === "recebimentos" || kind === "locadora_recebimento") {
      kind = "locadora_recebimentos";
    }
    if (kind === "tarefas" || kind === "tarefa") {
      const rows = await ctx.db.query.tasks.findMany({
        where: and(
          eq(tasks.workspaceId, ctx.workspaceId),
          isNull(tasks.deletedAt)
        ),
        limit: 80,
      });
      const open = rows.filter((item) => item.status !== "completed" && item.status !== "cancelled");
      if (!open.length) {
        return { ok: true, summary: "Nenhuma tarefa aberta para o relatório." };
      }
      const tz = ctx.timezone || "America/Sao_Paulo";
      const nowLabel = DateTime.now().setZone(tz).toFormat("dd/LL/yyyy HH:mm");
      const pdf = buildReportPdf({
        brand: "Assessor MOOPE",
        title: "Tarefas abertas",
        subtitle: "Lista pessoal",
        generatedAt: nowLabel,
        kpis: [{ label: "Abertas", value: String(open.length) }],
        sections: [
          {
            title: "Tarefas",
            rows: open.map((item) => `• ${item.title}`),
          },
        ],
      });
      const sheet = buildCsvSheet({
        headers: ["Tarefa", "Status"],
        rows: open.map((item) => [item.title, item.status]),
      });
      const sent = await sendPdfAndSheet(ctx, {
        pdf,
        pdfName: `tarefas-${Date.now()}.pdf`,
        sheet,
        sheetName: `tarefas-${Date.now()}.csv`,
        captionPdf: `📄 *PDF — Tarefas*\n${open.length} abertas`,
        captionSheet: `📊 *Excel — Tarefas*\n${open.length} abertas`,
        keyPrefix: "report-tarefas",
      });
      if (!sent.ok) return sent;
      const summary = await appendVisualBoard(
        ctx,
        sent.summary || `Mandei PDF e Excel com *${open.length}* tarefas.`,
        emptyBoard({
          kind: "pessoal",
          title: "Tarefas",
          org: "Pessoal",
          kpis: [{ label: "Abertas", value: String(open.length) }],
          rows: open.slice(0, 16).map((item) => ({
            title: item.title,
            detail: item.status,
          })),
          note: "O arquivo fica no Zap. O link vale 24 horas.",
        })
      );
      return { ok: true, summary, data: { kind: "tarefas", formats: ["pdf", "csv"] } };
    }

    if (kind === "auto") {
      // Pessoal: não listar locadora se não houver integração
      let hasLocadora = false;
      try {
        const phone = await phoneFromCtx(ctx);
        if (phone) {
          const integ = await resolveLocadoraIntegration(phone);
          hasLocadora = Boolean(integ?.integrated);
        }
      } catch {
        hasLocadora = false;
      }
      const lines = [
        "Qual relatório você quer? (mando *PDF + Excel*)",
        "• *gastos* (mês)",
        "• *semana* / agenda",
      ];
      if (hasLocadora) {
        lines.push(
          "• *resumo da locadora*",
          "• *alertas da locadora*",
          "• *faturas da placa XXX*",
          "• *recebimentos de hoje ou da semana*"
        );
      }
      lines.push("", 'Ex.: “me manda o relatório de gastos”');
      return { ok: true, summary: lines.join("\n") };
    }

    const tz = ctx.timezone || "America/Sao_Paulo";
    const nowLabel = DateTime.now()
      .setZone(tz)
      .toFormat("dd/LL/yyyy HH:mm");

    if (kind === "gastos") {
      const month = args.month ? String(args.month).trim() : undefined;
      const pack = await loadExpensesInMonth(ctx, month);
      if (!pack.items.length) {
        return {
          ok: true,
          summary: `Ainda não tenho gastos em ${pack.label} para o relatório 📄`,
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
      const pdf = buildReportPdf({
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
      const sheet = buildCsvSheet({
        headers: ["Data", "Categoria", "Valor", "Estabelecimento", "Nota"],
        rows: pack.items.map((i) => [
          i.date,
          i.category,
          csvEscapeMoney(i.amount),
          i.merchant,
          i.note,
        ]),
        extraLines: [
          [],
          ["TOTAL", "", csvEscapeMoney(total), "", ""],
          ...topCats.map(([c, v]) => ["CATEGORIA", c, csvEscapeMoney(v), "", ""]),
        ],
      });
      const sent = await sendPdfAndSheet(ctx, {
        pdf,
        pdfName: `relatorio-gastos-${pack.monthKey}.pdf`,
        sheet,
        sheetName: `gastos-${pack.monthKey}.csv`,
        captionPdf: `📄 *PDF — Gastos ${pack.label}*\n${pack.items.length} lançamentos · total ${moneyBr(total)}`,
        captionSheet: `📊 *Excel — Gastos ${pack.label}*\nAbre no Excel / Numbers / Sheets · total ${moneyBr(total)}`,
        keyPrefix: `report-gastos`,
      });
      if (!sent.ok) return sent;
      const summary = await appendVisualBoard(
        ctx,
        "",
        emptyBoard({
          kind: "pessoal",
          title: `Gastos — ${pack.label}`,
          org: "Pessoal",
          subtitle: "O PDF e o Excel já foram neste Zap",
          kpis: [
            { label: "Total", value: moneyBr(total), tone: "warn" },
            { label: "Lançamentos", value: String(pack.items.length) },
            {
              label: "Ticket médio",
              value: moneyBr(total / Math.max(pack.items.length, 1)),
            },
            {
              label: "Maior categoria",
              value: topCats[0]?.[0] || "—",
            },
          ],
          bars: topCats.map(([c, v]) => ({
            label: c,
            value: v,
            display: moneyBr(v),
          })),
          rows: pack.items.slice(0, 16).map((i) => ({
            title: i.merchant || i.category,
            detail: `${i.date} · ${i.category}`,
            value: moneyBr(i.amount),
          })),
          note: "O arquivo fica no seu WhatsApp. O link da página vale 24 horas e é só desta consulta.",
        })
      );
      return {
        ok: true,
        summary,
        data: { kind: "gastos", formats: ["pdf", "csv"] },
      };
    }

    if (kind === "semana") {
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
        limit: 60,
      });
      const apptRows = await ctx.db.query.appointments.findMany({
        where: and(
          eq(appointments.workspaceId, ctx.workspaceId),
          eq(appointments.status, "scheduled"),
          isNull(appointments.deletedAt),
          gte(appointments.startsAt, now.toJSDate()),
          lte(appointments.startsAt, until.toJSDate())
        ),
        limit: 60,
      });
      type Row = { when: string; tipo: string; titulo: string; valor: string };
      const sheetRows: Row[] = [];
      const remLines: string[] = [];
      for (const r of remRows) {
        const at = DateTime.fromJSDate(r.fireAt).setZone(r.timezone || tz);
        const payload = (r.payload || {}) as ReminderPayload;
        const money =
          typeof payload.amount === "number" && payload.amount > 0
            ? moneyBr(payload.amount)
            : "";
        remLines.push(
          `${at.toFormat("dd/LL HH:mm")}  ${r.title}${money ? ` · ${money}` : ""}`
        );
        sheetRows.push({
          when: at.toFormat("dd/LL/yyyy HH:mm"),
          tipo: "lembrete",
          titulo: r.title,
          valor: money ? csvEscapeMoney(Number(payload.amount)) : "",
        });
      }
      const apptLines: string[] = [];
      for (const a of apptRows) {
        const at = DateTime.fromJSDate(a.startsAt).setZone(a.timezone || tz);
        apptLines.push(`${at.toFormat("dd/LL HH:mm")}  ${a.title}`);
        sheetRows.push({
          when: at.toFormat("dd/LL/yyyy HH:mm"),
          tipo: "compromisso",
          titulo: a.title,
          valor: "",
        });
      }
      if (!remLines.length && !apptLines.length) {
        return {
          ok: true,
          summary: `Agenda livre nos próximos ${days} dias — nada para o relatório ✨`,
        };
      }
      const pdf = buildReportPdf({
        brand: "Assessor MOOPE",
        title: `Agenda — proximos ${days} dias`,
        subtitle: "Lembretes e compromissos",
        generatedAt: nowLabel,
        kpis: [
          { label: "Lembretes", value: String(remLines.length) },
          { label: "Compromissos", value: String(apptLines.length) },
          { label: "Janela", value: `${days} dias` },
          {
            label: "Total itens",
            value: String(remLines.length + apptLines.length),
          },
        ],
        sections: [
          { title: "Lembretes", rows: remLines.length ? remLines : ["(nenhum)"] },
          {
            title: "Compromissos",
            rows: apptLines.length ? apptLines : ["(nenhum)"],
          },
        ],
      });
      const sheet = buildCsvSheet({
        headers: ["Quando", "Tipo", "Titulo", "Valor"],
        rows: sheetRows.map((r) => [r.when, r.tipo, r.titulo, r.valor]),
      });
      const dayKey = now.toFormat("yyyy-MM-dd");
      const sent = await sendPdfAndSheet(ctx, {
        pdf,
        pdfName: `relatorio-agenda-${dayKey}.pdf`,
        sheet,
        sheetName: `agenda-${dayKey}.csv`,
        captionPdf: `📄 *PDF — Agenda* próximos ${days} dias\n${remLines.length} lembretes · ${apptLines.length} compromissos`,
        captionSheet: `📊 *Excel — Agenda* próximos ${days} dias\nAbre no Excel / Numbers / Sheets`,
        keyPrefix: `report-semana`,
      });
      return sent.ok
        ? {
            ok: true,
            summary: sent.summary,
            data: { kind: "semana", formats: ["pdf", "csv"] },
          }
        : sent;
    }

    // Locadora reports — PDF + planilha com as linhas
    if (kind.startsWith("locadora")) {
      const phone = await phoneFromCtx(ctx);
      if (!phone) {
        return {
          ok: false,
          summary: "Não identifiquei seu WhatsApp para o relatório da locadora.",
          errorCode: "no_phone",
        };
      }
      const { requireActiveBusinessOrChooser } = await import("./business-context");
      const picked = await requireActiveBusinessOrChooser(ctx.db, phone, "locadora");
      if (!picked.ok) {
        return { ok: true, summary: picked.summary, data: { needsChoice: true } };
      }
      const empresa = picked.option.label || "Locadora";
      let q = "resumo";
      if (kind.includes("alerta")) q = "alertas da locadora";
      else if (kind.includes("recebimento")) {
        q = String(args.period || ctx.userText || "recebimentos hoje").trim();
        if (!/recebiment|a receber|receber/i.test(q)) q = `recebimentos ${q}`;
        const { resolveLocadoraQuestion } = await import("@/domain/locadora-intent");
        q = resolveLocadoraQuestion({ toolQuestion: q, userText: q });
      } else if (kind.includes("fatura")) {
        const placa = String(args.placa || "").trim();
        if (!placa) {
          return {
            ok: true,
            summary:
              "Para o relatório de faturas, me diga a placa. Ex.: *me manda o relatório de faturas da placa SSW7B52*",
          };
        }
        q = `faturas da placa ${placa}`;
      }

      const res = await askLocadora(phone, q, {
        tenantId: picked.option.tenantId,
      });
      if (!res.ok || !res.integrated) {
        return {
          ok: false,
          summary:
            res.message ||
            "Não consegui montar o relatório da locadora agora.",
          errorCode: res.error || "finance",
        };
      }
      const body = String(res.text || "");
      const lines = body
        .split("\n")
        .map((l) => l.replace(/\*/g, "").trim())
        .filter(Boolean);
      const tipo = kind.includes("alerta")
        ? "Alertas"
        : kind.includes("recebimento")
          ? "Recebimentos"
          : kind.includes("fatura")
            ? "Faturas"
            : "Resumo";
      const isReceivables = kind.includes("recebimento");
      const receiptTotal = isReceivables
        ? body.match(/total\s+\*?R\$\s*([\d.]+,\d{2})/i)?.[1]
        : undefined;
      const receiptCount = isReceivables
        ? body.match(/\*?(\d+)\*?\s+lançamento/i)?.[1]
        : undefined;
      const receiptRows = isReceivables
        ? body.split("\n").flatMap((line) => {
            const match = line.match(/^[•-]\s*R\$\s*([\d.]+,\d{2})\s*·\s*(.+)$/i);
            return match ? [[match[1], match[2]]] : [];
          })
        : [];
      const pdf = buildReportPdf({
        brand: "Assessor MOOPE · Locadora",
        title: empresa.slice(0, 42),
        subtitle: isReceivables ? q : `${tipo} operacionais`,
        generatedAt: nowLabel,
        kpis: isReceivables
          ? [
              ...(receiptTotal ? [{ label: "Total previsto", value: `R$ ${receiptTotal}` }] : []),
              ...(receiptCount ? [{ label: "Lançamentos", value: receiptCount }] : []),
              { label: "Período", value: q },
              { label: "Empresa", value: empresa },
            ]
          : [
              { label: "Fonte", value: "MOOPE Gestão de Frotas e Locação" },
              { label: "Itens", value: String(Math.min(lines.length, 99)) },
              { label: "Tipo", value: kind.replace("locadora_", "") },
              { label: "Canal", value: "WhatsApp" },
            ],
        sections: [{
          title: isReceivables ? "Recebimentos do período" : "Conteudo",
          rows: isReceivables && receiptRows.length
            ? receiptRows.map(([value, detail]) => `${detail} · R$ ${value}`)
            : lines.slice(0, 80),
        }],
        footerNote: "frotas.moope.com.br  ·  Documento para gestao da locadora",
      });
      const receiptSheetRows = receiptRows.length
        ? receiptRows.slice(0, 200)
        : lines.slice(0, 200).map((line) => [line, ""]);
      const sheet = isReceivables
        ? await buildXlsxSheet({
            name: "Recebimentos",
            headers: ["Valor", "Data ou detalhe"],
            rows: receiptSheetRows,
          })
        : buildCsvSheet({
            headers: ["Linha", "Conteudo"],
            rows: lines.slice(0, 200).map((line, index) => [String(index + 1), line]),
          });
      const sent = await sendPdfAndSheet(ctx, {
        pdf,
        pdfName: `${isReceivables ? "recebimentos" : "relatorio-locadora"}-${Date.now()}.pdf`,
        sheet,
        sheetName: `${isReceivables ? "recebimentos" : "locadora"}-${kind.replace("locadora_", "")}-${Date.now()}.${isReceivables ? "xlsx" : "csv"}`,
        sheetMimeType: isReceivables
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : undefined,
        captionPdf: `📄 *PDF — ${empresa}*\n${tipo}${isReceivables ? ` · ${q}` : ""} pronto.`,
        captionSheet: `📊 *Planilha — ${empresa}*\n${tipo}${isReceivables ? ` · ${q}` : ""} · abre no Excel`,
        keyPrefix: `report-loc`,
      });
      if (!sent.ok) return sent;
      const panelSummary = kind.includes("recebimento")
        ? `📅 *Abrir calendário de recebimentos*\nhttps://frotas.moope.com.br/calendariorecebimentos\n_Entre no MOOPE Gestão para consultar outros dias ou períodos._`
        : await appendVisualBoard(
            ctx,
            "",
            boardFromLocadora({
              title: tipo,
              org: empresa,
              text: body,
              snapshot: res.snapshot,
            })
          );
      return {
        ok: true,
        summary: [sent.summary, panelSummary].filter(Boolean).join("\n\n"),
        data: {
          kind,
          formats: sent.formatsSent || [],
          formatsFailed: sent.formatsFailed || [],
        },
      };
    }

    return {
      ok: true,
      summary:
        "Qual relatório? *gastos*, *semana*, *resumo da locadora*, *alertas* ou *faturas da placa XXX* — mando PDF + Excel.",
    };
  },
});

registerTool({
  name: "daily_briefing",
  description:
    "Briefing do dia a dia: agenda das próximas horas/dias + gastos do mês + (se integrado) alerta curto da locadora. Use em 'bom dia', 'como está meu dia', 'me atualiza', 'briefing'.",
  inputSchema: {
    type: "object",
    properties: {
      include_locadora: { type: "boolean" },
    },
  },
  async handler(ctx, args) {
    const tz = ctx.timezone || "America/Sao_Paulo";
    const now = DateTime.now().setZone(tz);
    const until = now.plus({ hours: 36 }).endOf("hour");

    const remRows = await ctx.db.query.reminders.findMany({
      where: and(
        eq(reminders.workspaceId, ctx.workspaceId),
        eq(reminders.status, "scheduled"),
        isNull(reminders.deletedAt),
        gte(reminders.fireAt, now.toJSDate()),
        lte(reminders.fireAt, until.toJSDate())
      ),
      limit: 8,
    });
    const apptRows = await ctx.db.query.appointments.findMany({
      where: and(
        eq(appointments.workspaceId, ctx.workspaceId),
        eq(appointments.status, "scheduled"),
        isNull(appointments.deletedAt),
        gte(appointments.startsAt, now.toJSDate()),
        lte(appointments.startsAt, until.toJSDate())
      ),
      limit: 8,
    });

    const agenda: string[] = [];
    for (const r of remRows) {
      const at = DateTime.fromJSDate(r.fireAt).setZone(r.timezone || tz);
      agenda.push(`• 🔔 ${at.toFormat("HH:mm")} — ${r.title}`);
    }
    for (const a of apptRows) {
      const at = DateTime.fromJSDate(a.startsAt).setZone(a.timezone || tz);
      agenda.push(`• 📅 ${at.toFormat("ccc HH:mm", { locale: "pt-BR" })} — ${a.title}`);
    }

    const pack = await loadExpensesInMonth(ctx);
    const total = pack.items.reduce((s, i) => s + i.amount, 0);

    const parts = [
      `☀️ *Briefing — ${now.toFormat("cccc, dd/LL", { locale: "pt-BR" })}*`,
      "",
      "*Próximas 36h*",
      agenda.length ? agenda.join("\n") : "• Nada marcado — dia livre por aqui.",
      "",
      `*Gastos de ${pack.label}*`,
      `• ${pack.items.length} lançamentos · ${moneyBr(total)}`,
    ];

    const includeLoc =
      args.include_locadora !== false;
    if (includeLoc) {
      const phone = await phoneFromCtx(ctx);
      if (phone) {
        const { requireActiveBusinessOrChooser } = await import("./business-context");
        const picked = await requireActiveBusinessOrChooser(
          ctx.db,
          phone,
          "locadora"
        );
        if (picked.ok) {
          const snap = await askLocadora(phone, "resumo", {
            tenantId: picked.option.tenantId,
          });
          if (snap.integrated && snap.text) {
            const short = snap.text
              .split("\n")
              .filter((l) => /Frota|Contratos|Receita|Inadimpl/i.test(l))
              .slice(0, 4);
            parts.push(
              "",
              `*Locadora — ${picked.option.label || "MOOPE"}*`,
              ...(short.length ? short : [snap.text.slice(0, 220)])
            );
          }
        }
      }
    }

    parts.push(
      "",
      "_Pessoal:_ “balanço do mês” · “como estou de gastos?” · “me manda o relatório” (PDF+Excel)"
    );

    return {
      ok: true,
      summary: parts.join("\n"),
      data: {
        agenda: agenda.length,
        expenses: pack.items.length,
        total,
      },
    };
  },
});
