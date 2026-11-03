import { eq } from "drizzle-orm";
import { conversations, whatsappIdentities } from "@/db/schema";
import { createZernioClient } from "@/channels/zernio";
import {
  assessorCommercialAccess,
  commercialBlockedSummary,
} from "@/domain/assessor-access";
import { resolveZernioRuntimeConfig } from "@/domain/providers";
import {
  askEscritorio,
  resolveEscritorio,
  type EscritorioResult,
} from "@/integrations/facejus-assessor";
import { logger } from "@/lib/logger";
import { facejusAgendaKind } from "@/domain/facejus-commands";
import { requireActiveBusinessOrChooser } from "./business-context";
import { registerTool } from "./registry";

async function sendEscritorioPdf(
  ctx: {
    db: import("@/db/client").Db;
    conversationId: string;
    workspaceId: string;
  },
  res: EscritorioResult
): Promise<{ ok: boolean; note?: string }> {
  if (!res.send_pdf) return { ok: false };
  const conversation = await ctx.db.query.conversations.findFirst({
    where: eq(conversations.id, ctx.conversationId),
  });
  const externalId = conversation?.externalConversationId;
  if (!externalId) return { ok: false, note: "sem_canal" };

  let buffer: Buffer | null = null;
  const filename = res.pdf_name || `facejus-${Date.now()}.pdf`;
  try {
    if (res.pdf_base64) {
      buffer = Buffer.from(res.pdf_base64, "base64");
    } else if (res.pdf_url) {
      const got = await fetch(res.pdf_url, {
        signal: AbortSignal.timeout(45000),
      });
      if (!got.ok) {
        logger.warn("facejus_pdf_fetch_failed", { status: got.status });
        return { ok: false, note: "fetch_failed" };
      }
      buffer = Buffer.from(await got.arrayBuffer());
    }
  } catch (err) {
    logger.warn("facejus_pdf_load_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, note: "load_failed" };
  }
  if (!buffer?.length) return { ok: false, note: "empty" };

  const cfg = await resolveZernioRuntimeConfig(ctx.db);
  const client = createZernioClient({
    mock: cfg.mock,
    apiKey: cfg.apiKey,
    apiUrl: cfg.apiUrl,
    accountId: cfg.accountId,
  });
  const uploaded = await client.uploadMedia({
    buffer,
    filename,
    mimeType: "application/pdf",
  });
  if (!uploaded.ok || !uploaded.url) {
    return { ok: false, note: "upload_failed" };
  }
  const send = await client.sendMedia({
    conversationId: externalId,
    attachmentUrl: uploaded.url,
    attachmentType: "file",
    attachmentName: filename,
    message: `📄 *${filename}* — relatório Facejus`,
    idempotencyKey: `facejus-pdf:${ctx.workspaceId}:${Date.now()}`,
    accountId: cfg.accountId || undefined,
  });
  return { ok: Boolean(send.ok), note: send.ok ? undefined : "send_failed" };
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

async function gate(ctx: {
  db: import("@/db/client").Db;
  userId: string;
  workspaceId: string;
  phone: string;
}) {
  return assessorCommercialAccess(ctx.db, {
    phone: ctx.phone,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
}

registerTool({
  name: "check_escritorio_integration",
  description:
    "Verifica se ESTE WhatsApp está liberado no Facejus (escritório de advocacia). Use em 'tenho integração facejus?', 'meu escritório está ligado?', 'posso ver processos?'.",
  inputSchema: { type: "object", properties: {} },
  async handler(ctx) {
    const phone = await phoneFromCtx(ctx);
    if (!phone) {
      return { ok: false, summary: "Não identifiquei seu WhatsApp.", errorCode: "no_phone" };
    }
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(phone)) {
      return { ok: true, summary: PERSONAL_FOCUS_REPLY, data: { personalFocus: true } };
    }
    const access = await gate({ ...ctx, phone });
    if (!access.allowed) {
      return {
        ok: true,
        summary: await commercialBlockedSummary(ctx.db, access),
        data: { access },
      };
    }
    const res = await resolveEscritorio(phone);
    if (!res.integrated) {
      return {
        ok: true,
        summary: [
          res.message || "Este número ainda não está liberado no Facejus.",
          "",
          "O admin do escritório libera em Administração → Assessor MOOPE.",
          "Sócio vê tudo. Advogado vê só os processos ligados a ele.",
        ].join("\n"),
        data: { integrated: false },
      };
    }
    const picked = await requireActiveBusinessOrChooser(ctx.db, phone, "facejus");
    const links = res.links || [];
    const link = picked.ok
      ? links.find((L) => Number(L.tenant_id) === picked.option.tenantId) || links[0]
      : links[0];
    const multi =
      links.length > 1
        ? [
            "",
            `Você tem *${links.length} escritórios* neste número. Agora: *${link?.escritorio || "—"}*.`,
            "Para trocar: *trocar empresa* ou *mudar contexto*.",
          ]
        : [];
    return {
      ok: true,
      summary: [
        `✅ Número liberado no escritório *${link?.escritorio || "Facejus"}*.`,
        `Papel: ${link?.papel === "socio" ? "sócio (vê tudo)" : "advogado (só os processos dele)"}.`,
        "",
        "Pode pedir:",
        "• agenda de atendimento (por filial; OAB opcional) · PDF agenda de atendimento",
        "• agenda de prazos processuais · PDF agenda de prazos",
        "• agenda jurídica de hoje / da semana (com qtde por filial)",
        "• agenda OAB 15444 (compromissos + KPIs do advogado)",
        "• KPIs · processos da filial X · PDF processos",
        "• andamento do processo NUMERO",
        ...multi,
      ].join("\n"),
      data: { integrated: true, links: res.links },
    };
  },
});

registerTool({
  name: "query_escritorio",
  description:
    "Consulta o Facejus: processos, andamento, KPIs, agenda de atendimento, agenda de prazos processuais, agenda jurídica, agenda OAB NUMERO, PDF de listagens. Sócio vê o escritório; advogado só o ligado a ele.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "Ex.: meus processos; PDF processos; agenda de atendimento; agenda de atendimento da filial Içara; agenda de atendimento OAB 15444; agenda de prazos processuais; PDF agenda de prazos; agenda jurídica de hoje; agenda OAB 15444; KPIs",
      },
    },
    required: ["question"],
  },
  async handler(ctx, args) {
    const phone = await phoneFromCtx(ctx);
    if (!phone) {
      return { ok: false, summary: "Não identifiquei seu WhatsApp.", errorCode: "no_phone" };
    }
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(phone)) {
      return { ok: true, summary: PERSONAL_FOCUS_REPLY, data: { personalFocus: true } };
    }
    const access = await gate({ ...ctx, phone });
    if (!access.allowed) {
      return {
        ok: true,
        summary: await commercialBlockedSummary(ctx.db, access),
        data: { access },
      };
    }
    const question = String(args.question || "").trim();
    if (!question) {
      return {
        ok: false,
        summary: "Diz o que quer ver: processos, andamento ou agenda.",
        errorCode: "no_question",
      };
    }
    const picked = await requireActiveBusinessOrChooser(ctx.db, phone, "facejus");
    if (!picked.ok) {
      return { ok: true, summary: picked.summary, data: { needsChoice: true } };
    }
    const res = await askEscritorio(phone, question, {
      tenantId: picked.option.tenantId,
    });
    let summary = res.ok
      ? `📍 *${picked.option.label}*\n\n${res.text || res.message || "Sem resposta do Facejus."}`
      : res.text || res.message || "Sem resposta do Facejus.";
    if (res.ok && facejusAgendaKind(question) === "atendimento" && !/\boab\b/i.test(question)) {
      summary +=
        "\n\n_A lista sai por filial. Para um advogado: *agenda de atendimento OAB 12345*._";
    }
    let pdfSent = false;
    if (res.ok && res.send_pdf) {
      const sent = await sendEscritorioPdf(ctx, res);
      pdfSent = sent.ok;
      if (sent.ok) {
        summary += `\n\n📄 Enviei o *PDF* (${res.pdf_name || "relatório"}).`;
      } else {
        summary +=
          "\n\n_Gerei o relatório, mas o envio do PDF falhou — peça de novo “PDF agenda” ou “PDF processos”._";
      }
    }
    if (res.ok && res.painel && (res.painel.modo === "agenda" || res.painel.itens?.length || res.painel.totais)) {
      const { appendVisualBoard } = await import("@/domain/visual-board");
      const { boardFromAgenda, boardFromEscritorio } = await import("@/domain/facejus-board");
      const board =
        res.painel.modo === "agenda"
          ? boardFromAgenda(res.painel, picked.option.label)
          : boardFromEscritorio(res.painel, picked.option.label);
      summary = await appendVisualBoard(ctx, summary, {
        ...board,
        live: {
          source: "facejus",
          modo: res.painel.modo === "agenda" ? "agenda" : "processos",
          tenantId: Number(picked.option.tenantId),
          phone,
          dia: res.painel.dia,
          natureza: res.painel.natureza || null,
          escritorioId: res.painel.escritorio_id || null,
        },
      });
    } else if (res.ok && (res.text || "").trim().length > 20) {
      const { appendVisualBoard, boardFromReply } = await import(
        "@/domain/visual-board"
      );
      summary = await appendVisualBoard(
        ctx,
        summary,
        boardFromReply({
          kind: "facejus",
          title: "Escritório",
          org: picked.option.label,
          text: res.text || summary,
        })
      );
    }
    return {
      ok: Boolean(res.ok),
      summary,
      data: {
        integrated: res.integrated,
        tenantId: picked.option.tenantId,
        pdfSent,
        send_pdf: Boolean(res.send_pdf),
      },
    };
  },
});
