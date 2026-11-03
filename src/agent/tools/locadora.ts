import { eq } from "drizzle-orm";
import { conversations, whatsappIdentities } from "@/db/schema";
import { createZernioClient } from "@/channels/zernio";
import {
  assessorCommercialAccess,
  commercialBlockedSummary,
} from "@/domain/assessor-access";
import { addToWhitelist } from "@/domain/access-whitelist";
import {
  askLocadora,
  collapseLocadoraLinks,
  resolveLocadoraIntegration,
  snapshotLocadora,
  type LocadoraResolveResult,
} from "@/integrations/moope-finance-assessor";
import { resolveZernioRuntimeConfig } from "@/domain/providers";
import { maybeAppendReportOffer } from "@/lib/report-pdf";
import {
  boardFromInvestidores,
  boardFromLocatarios,
  boardFromVeiculos,
  boardFromLocadora,
  boardFromRendimentos,
} from "@/domain/locadora-board";
import { appendVisualBoard } from "@/domain/visual-board";
import { logger } from "@/lib/logger";
import { requireActiveBusinessOrChooser } from "./business-context";
import { registerTool } from "./registry";

/** Se a locadora liberou o número no MOOPE Gestão, espelha na whitelist (idempotente). */
async function ensureWhitelistFromLocadora(
  db: import("@/db/client").Db,
  phone: string,
  empresaNome?: string | null
) {
  try {
    await addToWhitelist(db, {
      phone,
      label: empresaNome
        ? `MOOPE · ${String(empresaNome).slice(0, 60)}`
        : "MOOPE Gestão · Locadora",
      notes: "auto: integração locadora ativa",
    });
  } catch (err) {
    logger.warn("locadora_auto_whitelist_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const LOCADORA_HELP_FOOTER = "_Para mais comandos: *ajuda locadora*_";

function withLocadoraHelpFooter(summary: string): string {
  if (/ajuda locadora/i.test(summary)) return summary;
  return `${summary.trim()}\n\n${LOCADORA_HELP_FOOTER}`;
}

async function sendLocadoraXlsx(
  ctx: {
    db: import("@/db/client").Db;
    conversationId: string;
    workspaceId: string;
  },
  res: LocadoraResolveResult
): Promise<{ ok: boolean; note?: string }> {
  if (!res.send_xlsx || !res.xlsx_base64) return { ok: false };
  const conversation = await ctx.db.query.conversations.findFirst({
    where: eq(conversations.id, ctx.conversationId),
  });
  const externalId = conversation?.externalConversationId;
  if (!externalId) return { ok: false, note: "sem_canal" };

  const filename = res.xlsx_name || `iot-${Date.now()}.xlsx`;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(res.xlsx_base64, "base64");
  } catch {
    return { ok: false, note: "b64_invalid" };
  }
  if (!buffer.length) return { ok: false, note: "empty" };

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
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  if (!uploaded.ok || !uploaded.url) {
    return { ok: false, note: "upload_failed" };
  }
  const send = await client.sendMedia({
    conversationId: externalId,
    attachmentUrl: uploaded.url,
    attachmentType: "file",
    attachmentName: filename,
    message: `📊 *${filename}* — relatório IoT`,
    idempotencyKey: `iot-xlsx:${ctx.workspaceId}:${Date.now()}`,
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

async function blockedIfNeeded(ctx: {
  db: import("@/db/client").Db;
  userId: string;
  workspaceId: string;
  phone: string;
}) {
  const access = await assessorCommercialAccess(ctx.db, {
    phone: ctx.phone,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  if (access.allowed) return null;
  return {
    ok: true as const,
    summary: await commercialBlockedSummary(ctx.db, access),
    data: { access },
  };
}

registerTool({
  name: "check_locadora_integration",
  description:
    "Verifica se ESTE WhatsApp tem integração MOOPE Locadora ou IoT/supermercado (MOOPE Gestão). Use quando perguntarem 'tenho integração moope?', 'minha locadora está ligada?', 'posso ver carrinhos/TAGs?'.",
  inputSchema: { type: "object", properties: {} },
  async handler(ctx) {
    const phone = await phoneFromCtx(ctx);
    if (!phone) {
      return {
        ok: false,
        summary: "Não consegui identificar seu WhatsApp nesta conversa.",
        errorCode: "no_phone",
      };
    }
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(phone)) {
      return { ok: true, summary: PERSONAL_FOCUS_REPLY, data: { personalFocus: true } };
    }
    const blocked = await blockedIfNeeded({ ...ctx, phone });
    if (blocked) return blocked;
    const res = await resolveLocadoraIntegration(phone);
    if (!res.integrated) {
      return {
        ok: true,
        summary: [
          "Ainda *não* achei integração MOOPE Locadora/IoT para o seu número.",
          "",
          "Como liberar:",
          "1) acessar: Gestão → https://frotas.moope.com.br",
          "2) Configurações → *Assessor MOOPE*",
          "3) Ligue a integração e cadastre este WhatsApp.",
          "4) Volte e pergunte: “tenho integração moope?”",
          "",
          "acessar: moope.com.br → https://moope.com.br",
        ].join("\n"),
        data: { integrated: false, phone },
      };
    }
    const links = collapseLocadoraLinks(res.links);
    const active = await requireActiveBusinessOrChooser(ctx.db, phone, "locadora");
    const link = active.ok
      ? links.find((L) => Number(L.userid) === active.option.tenantId) || links[0]
      : links[0];
    await ensureWhitelistFromLocadora(ctx.db, phone, link?.empresa_nome);
    const isIot = String(link?.modulo || "").toLowerCase() === "iot";
    const multi =
      links.length > 1
        ? [
            "",
            `Você tem *${links.length} empresas* neste número. Agora: *${link?.empresa_nome || "—"}*.`,
            "Para trocar: *trocar empresa* ou *mudar contexto*.",
          ]
        : [];
    return {
      ok: true,
      summary: isIot
        ? [
            `✅ Sim! Seu número está liberado no *IoT / Carrinhos* — *${link?.empresa_nome || "MOOPE Gestão"}*.`,
            `Papel: ${link?.papel || "gerente_iot"}.`,
            "",
            "Como pedir:",
            "• “quantos carrinhos / por unidade”",
            "• “carrinhos fora” / “fora da loja X”",
            "• “onde está a tag LJ010_…”",
            "• “alertas de saída” / “sairam hoje”",
            "• “manda Excel das tags fora”",
            "• “rota de recolha dos que estão fora”",
            "",
            ...multi,
          ]
            .filter(Boolean)
            .join("\n")
        : [
            `✅ Sim! Seu número está liberado na locadora *${link?.empresa_nome || "MOOPE Gestão"}*.`,
            `Papel: ${link?.papel || "gerente"}.`,
            ...(multi.length ? ["", ...multi] : []),
            "",
            LOCADORA_HELP_FOOTER,
          ].join("\n"),
      data: { integrated: true, links: res.links, phone },
    };
  },
});

registerTool({
  name: "query_locadora",
  description:
    "Consulta MOOPE Gestão: locadora (frota/contratos/financeiro, faturamento/rendimento e recebimentos por hoje/semana/período) OU IoT/supermercado (carrinhos, TAGs FINDTAG/TAGBRGPS, fora da loja, Excel, rota de recolha). Para recebimentos, preserve o período literal; não troque por receita mensal. Use question='capacidades' para o menu. IoT: quantos carrinhos, fora, onde está a tag, Excel, alertas, rota.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "Pergunta em português. Locadora: resumo, placa, inadimplência, recebimentos hoje/semana ou período… IoT: quantos carrinhos; carrinhos fora; onde está TAG-…; manda Excel das tags fora; rota de recolha; alertas de saída.",
      },
    },
    required: ["question"],
  },
  async handler(ctx, args) {
    const phone = await phoneFromCtx(ctx);
    if (!phone) {
      return {
        ok: false,
        summary: "Não identifiquei o WhatsApp para consultar a locadora/IoT.",
        errorCode: "no_phone",
      };
    }
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(phone)) {
      return { ok: true, summary: PERSONAL_FOCUS_REPLY, data: { personalFocus: true } };
    }
    const blocked = await blockedIfNeeded({ ...ctx, phone });
    if (blocked) return blocked;
    const picked = await requireActiveBusinessOrChooser(ctx.db, phone, "locadora");
    if (!picked.ok) {
      return { ok: true, summary: picked.summary, data: { needsChoice: true } };
    }
    const {
      detectLocadoraIntent,
      isLocadoraAcaoPhrase,
      isLocadoraInclusaoPhrase,
      resolveLocadoraQuestion,
    } = await import("@/domain/locadora-intent");
    const q = resolveLocadoraQuestion({
      toolQuestion: String(args.question || "").trim(),
      userText: ctx.userText || "",
    });
    const acao =
      typeof isLocadoraAcaoPhrase === "function" ? isLocadoraAcaoPhrase : () => false;
    const inclusao =
      typeof isLocadoraInclusaoPhrase === "function"
        ? isLocadoraInclusaoPhrase
        : () => false;
    const acaoLocadora =
      acao(q) ||
      acao(String(ctx.userText || "")) ||
      /^(sim|confirma|confirmo|pode marcar|não|nao|cancela|cancelar)[.!]?$/i.test(
        String(q || "").trim()
      );
    const askedYields = /rendiment|lucro da locadora|faturamento da locadora/i.test(
      `${ctx.userText || ""} ${q}`
    );
    const isReceivables =
      !askedYields && detectLocadoraIntent(q) === "recebimentos";
    const res = await askLocadora(phone, q, { tenantId: picked.option.tenantId });
    if (!res.ok && res.error) {
      return {
        ok: false,
        summary:
          res.message ||
          "Não consegui consultar o MOOPE Gestão agora. Tente de novo em instantes.",
        errorCode: res.error,
        data: { integrated: false },
      };
    }
    if (!res.integrated) {
      return {
        ok: true,
        summary:
          res.text ||
          res.message ||
          "Sem integração ativa. Pergunte “tenho integração moope?” para ver como liberar.",
        data: { integrated: false },
      };
    }
    await ensureWhitelistFromLocadora(ctx.db, phone, picked.option.label);
    let xlsxNote = "";
    if (res.send_xlsx) {
      const sent = await sendLocadoraXlsx(ctx, res);
      xlsxNote = sent.ok
        ? "\n\n📎 Excel enviado neste chat."
        : "\n\n_(Excel gerado, mas o envio falhou — peça de novo.)_";
    }
    const body = `${res.text || "Consultei o MOOPE Gestão."}${xlsxNote}`;
    const preserveFinanceText =
      acaoLocadora ||
      inclusao(q) ||
      inclusao(String(ctx.userText || "")) ||
      /isto é da locadora\.|para marcar a vistoria/i.test(body);
    const isIot =
      Boolean(res.send_xlsx) ||
      /🛒|🛵|🚨 \*Saídas|🔴 \*Fora|📦 \*Tipos|carrinhos?|geocerca|TAGBRGPS|FINDTAG/i.test(
        body
      ) ||
      /iot/i.test(picked.option.label) ||
      /iot/i.test(picked.option.papel);
    // IoT já vem layoutado pelo Finance — sem cabeçalho extra nem oferta de PDF locadora
    let summary = isIot
      ? body
      : preserveFinanceText
        ? `📍 *${picked.option.label}*\n\n${body}`
      : isReceivables
        ? `📍 *${picked.option.label}*\n\n${body.replace(/https?:\/\/(?:www\.)?frotas\.moope\.com\.br\S*/gi, "").replace(/Lista completa:\s*/gi, "").trim()}\n\n📅 *Abrir calendário de recebimentos*\nhttps://frotas.moope.com.br/calendariorecebimentos\n\n📄 Quer o detalhamento em PDF e planilha (abre no Excel)? Diga, por exemplo, *PDF recebimentos hoje* ou *Excel recebimentos da semana*.`
        : res.investidores || res.locatarios || res.veiculos
          ? `📍 *${picked.option.label}*\n\n${body}`
          : maybeAppendReportOffer(`📍 *${picked.option.label}*\n\n${body}`);
    const deniedInvestors = /painel de \*investidores\* é só do \*gerente geral\*/.test(body);
    if (!isIot && res.investidores) {
      summary = await appendVisualBoard(
        ctx,
        summary,
        boardFromInvestidores(res.investidores, picked.option.label)
      );
    } else if (!isIot && res.locatarios) {
      summary = await appendVisualBoard(
        ctx,
        summary,
        boardFromLocatarios(res.locatarios, picked.option.label)
      );
    } else if (!isIot && res.veiculos) {
      summary = await appendVisualBoard(
        ctx,
        summary,
        boardFromVeiculos(res.veiculos, picked.option.label)
      );
    } else if (
      !preserveFinanceText &&
      !acaoLocadora &&
      !isIot &&
      !isReceivables &&
      !deniedInvestors &&
      (askedYields || res.rendimentos || body.trim().length > 20)
    ) {
      summary = await appendVisualBoard(
        ctx,
        summary,
        res.rendimentos
          ? boardFromRendimentos(res.rendimentos, picked.option.label)
          : boardFromLocadora({
              title: askedYields ? "Rendimentos da locadora" : "Locadora",
              org: picked.option.label,
              text: body,
              snapshot: res.snapshot,
            })
      );
    }
    if (!isIot && !preserveFinanceText) summary = withLocadoraHelpFooter(summary);
    return {
      ok: true,
      summary,
      data: {
        integrated: true,
        link: (res as { link?: unknown }).link,
        tenantId: picked.option.tenantId,
        send_xlsx: Boolean(res.send_xlsx),
        iot: isIot,
        receivables: isReceivables,
      },
    };
  },
});

registerTool({
  name: "locadora_snapshot",
  description:
    "Resumo completo da locadora ou snapshot IoT (frota/carrinhos) se o número estiver liberado.",
  inputSchema: { type: "object", properties: {} },
  async handler(ctx) {
    const phone = await phoneFromCtx(ctx);
    if (!phone) {
      return {
        ok: false,
        summary: "WhatsApp não identificado.",
        errorCode: "no_phone",
      };
    }
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(phone)) {
      return { ok: true, summary: PERSONAL_FOCUS_REPLY, data: { personalFocus: true } };
    }
    const blocked = await blockedIfNeeded({ ...ctx, phone });
    if (blocked) return blocked;
    const picked = await requireActiveBusinessOrChooser(ctx.db, phone, "locadora");
    if (!picked.ok) {
      return { ok: true, summary: picked.summary, data: { needsChoice: true } };
    }
    const res = await snapshotLocadora(phone, {
      tenantId: picked.option.tenantId,
    });
    if (!res.integrated) {
      return {
        ok: true,
        summary:
          res.text ||
          res.message ||
          "Não consegui consultar a locadora agora. Tente de novo em instantes.",
        data: { integrated: false },
      };
    }
    await ensureWhitelistFromLocadora(ctx.db, phone, picked.option.label);
    const body = res.text || "Resumo.";
    const isIot =
      /🛒|🛵|carrinhos?|geocerca|TAGBRGPS|FINDTAG/i.test(body) ||
      /iot/i.test(picked.option.label) ||
      /iot/i.test(picked.option.papel);
    let summary = isIot
      ? body
      : maybeAppendReportOffer(`📍 *${picked.option.label}*\n\n${body}`);
    if (!isIot && body.trim().length > 20) {
      summary = await appendVisualBoard(
        ctx,
        summary,
        boardFromLocadora({
          title: "Resumo da locadora",
          org: picked.option.label,
          text: body,
          snapshot: res.snapshot,
        })
      );
    }
    if (!isIot) summary = withLocadoraHelpFooter(summary);
    return {
      ok: true,
      summary,
      data: { integrated: true, tenantId: picked.option.tenantId, iot: isIot },
    };
  },
});
