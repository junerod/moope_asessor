import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  agentRuns,
  conversations,
  documents,
  messages,
  reminders,
  users,
  whatsappChannels,
  whatsappIdentities,
  type AgentJob,
} from "@/db/schema";
import { createZernioClient } from "@/channels/zernio";
import { sendProactiveMessage } from "@/channels/zernio/proactive";
import { completeJob, failJob } from "@/domain/jobs";
import { handleOnboardingTurn } from "@/domain/onboarding";
import { processDocumentJob } from "@/domain/documents";
import { processInboundMedia } from "@/domain/inbound-media";
import { runAgentTurn } from "@/agent/runtime";
import { rescueUserReply } from "@/domain/rescue-reply";
import { looksLikeCodeLeak } from "@/domain/safe-reply";
import { scrubFakeValueHint } from "@/domain/receipt-undo";
import { resolveZernioRuntimeConfig } from "@/domain/providers";
import { checkInboundRateLimit } from "@/domain/rate-limit";
import { isPhoneBanned } from "@/domain/access-blacklist";
import { formatReminderDelivery, type ReminderPayload } from "@/lib/reminder-copy";
import { logger } from "@/lib/logger";
import { newCorrelationId } from "@/lib/crypto";
import type { BalanceTarget } from "@/domain/balance-route";

async function zernioClientForDb(db: Db) {
  const cfg = await resolveZernioRuntimeConfig(db);
  return createZernioClient({
    mock: cfg.mock,
    apiKey: cfg.apiKey,
    apiUrl: cfg.apiUrl,
    accountId: cfg.accountId,
  });
}

async function sendOutbound(
  db: Db,
  input: {
    conversationId: string;
    workspaceId: string | null;
    externalConversationId: string | null;
    text: string;
    correlationId: string;
    idempotencyKey: string;
    accountId?: string;
    proactive?: boolean;
  }
) {
  const text = scrubFakeValueHint(input.text);
  const [outbound] = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      direction: "outbound",
      status: "queued",
      bodyText: text,
      contentType: "text",
      correlationId: input.correlationId,
    })
    .returning();

  if (!input.externalConversationId) {
    await db
      .update(messages)
      .set({
        status: "failed",
        rawPayload: { error: "missing_external_conversation_id" },
        updatedAt: new Date(),
      })
      .where(eq(messages.id, outbound.id));
    throw new Error("missing_external_conversation_id");
  }

  const send = input.proactive
    ? await sendProactiveMessage(db, {
        conversationId: input.externalConversationId,
        message: text,
        idempotencyKey: input.idempotencyKey,
        accountId: input.accountId,
        logicalTemplate: "reminder",
      })
    : await (await zernioClientForDb(db)).sendText({
        conversationId: input.externalConversationId,
        message: text,
        idempotencyKey: input.idempotencyKey,
        accountId: input.accountId,
      });

  if (!send.ok) {
    if ("errorCode" in send && send.errorCode === "TEMPLATE_NOT_CONFIGURED") {
      throw new Error("TEMPLATE_NOT_CONFIGURED");
    }
    await db
      .update(messages)
      .set({
        status: "failed",
        rawPayload: { error: send.error, mocked: send.mocked },
        updatedAt: new Date(),
      })
      .where(eq(messages.id, outbound.id));
    throw new Error(send.error || "zernio_send_failed");
  }

  await db
    .update(messages)
    .set({
      status: "sent",
      externalMessageId: send.externalMessageId,
      sentAt: new Date(),
      rawPayload: {
        mocked: send.mocked,
        mode: "mode" in send ? send.mode : "free_form",
      },
      updatedAt: new Date(),
    })
    .where(eq(messages.id, outbound.id));

  return outbound;
}

export async function processAgentJob(db: Db, job: AgentJob) {
  const correlationId = job.correlationId || newCorrelationId();
  const log = logger.child({
    correlation_id: correlationId,
    job_id: job.id,
    workspace_id: job.workspaceId ?? undefined,
    conversation_id: job.conversationId ?? undefined,
  });

  if (job.jobType === "process_document") {
    const documentId = String(
      (job.payload as { document_id?: string }).document_id || ""
    );
    const [run] = await db
      .insert(agentRuns)
      .values({
        jobId: job.id,
        workspaceId: job.workspaceId,
        conversationId: job.conversationId,
        status: "running",
        provider: "pipeline",
        model: "document-processor",
        correlationId,
      })
      .returning();
    try {
      await processDocumentJob(db, documentId);
      // Follow-up no Zap: documento pronto
      if (job.conversationId) {
        try {
          const conv = await db.query.conversations.findFirst({
            where: eq(conversations.id, job.conversationId),
          });
          if (conv?.externalConversationId) {
            const doc = await db.query.documents.findFirst({
              where: eq(documents.id, documentId),
            });
            const name = doc?.originalFilename || "arquivo";
            const mime = String(doc?.mimeType || "");
            if (mime.startsWith("image/")) {
              /* A foto já foi respondida no recebimento. */
            } else await sendOutbound(db, {
              conversationId: conv.id,
              workspaceId: conv.workspaceId || job.workspaceId,
              externalConversationId: conv.externalConversationId,
              text: `📎 Pronto — *${name}* processado.\nPode pedir: “resume” · “anota o valor” · “o que tem aí?”`,
              correlationId,
              idempotencyKey: `doc-ready:${documentId}`,
              proactive: true,
            });
          }
        } catch {
          /* best-effort */
        }
      }
      await db
        .update(agentRuns)
        .set({ status: "completed", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentRuns.id, run.id));
      await completeJob(db, job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "doc_failed";
      await db
        .update(agentRuns)
        .set({ status: "failed", error: message, finishedAt: new Date() })
        .where(eq(agentRuns.id, run.id));
      await failJob(db, job, message);
    }
    return;
  }

  if (job.jobType === "deliver_reminder") {
    await processReminderDelivery(db, job, correlationId, log);
    return;
  }

  const [run] = await db
    .insert(agentRuns)
    .values({
      jobId: job.id,
      workspaceId: job.workspaceId,
      conversationId: job.conversationId,
      status: "running",
      provider: "pending",
      model: "pending",
      inputSummary: String((job.payload as { text?: string })?.text || "").slice(0, 500),
      correlationId,
    })
    .returning();

  try {
    if (!job.conversationId) throw new Error("missing_conversation_id");
    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, job.conversationId),
    });
    if (!conversation) throw new Error("conversation_not_found");

    let inboundText = String((job.payload as { text?: string })?.text || "");
    let accountId =
      String((job.payload as { account_id?: string })?.account_id || "") ||
      undefined;
    if (!accountId && conversation.whatsappChannelId) {
      const channel = await db.query.whatsappChannels.findFirst({
        where: eq(whatsappChannels.id, conversation.whatsappChannelId),
      });
      accountId = channel?.providerAccountId || undefined;
    }
    if (!accountId) {
      const cfg = await resolveZernioRuntimeConfig(db);
      accountId = cfg.accountId || undefined;
    }
    // Best-effort: mostra "digitando..." no WhatsApp enquanto processa (até ~25s)
    if (conversation.externalConversationId) {
      const zClient = await zernioClientForDb(db);
      void zClient
        .sendTyping({
          conversationId: conversation.externalConversationId,
          accountId,
        })
        .catch(() => undefined);
    }

    const paired = Boolean((job.payload as { paired?: boolean })?.paired);
    const needsOnboarding =
      job.jobType === "onboarding_message" ||
      !paired ||
      conversation.onboardingStep !== "completed" ||
      !conversation.userId ||
      !conversation.workspaceId;

    // Banimento: não responde (silencioso — regras avançadas depois)
    if (conversation.whatsappIdentityId) {
      const identity = await db.query.whatsappIdentities.findFirst({
        where: eq(whatsappIdentities.id, conversation.whatsappIdentityId),
      });
      if (identity?.phoneE164 && (await isPhoneBanned(db, identity.phoneE164))) {
        log.warn("phone_banned_skip", { phone: identity.phoneE164 });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "access",
            model: "banned",
            outputSummary: "phone_banned",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      if (identity?.phoneE164) {
        const { handleTeamReminderConsentMessage } = await import(
          "@/domain/team-reminders"
        );
        const consentReply = await handleTeamReminderConsentMessage(db, {
          phoneE164: identity.phoneE164,
          text: inboundText,
        });
        if (consentReply) {
          await sendOutbound(db, {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId || job.workspaceId,
            externalConversationId: conversation.externalConversationId,
            text: consentReply,
            correlationId,
            idempotencyKey: `job:${job.id}:team_reminder_consent`,
            accountId,
          });
          await db
            .update(agentRuns)
            .set({
              status: "completed",
              provider: "deterministic",
              model: "team-reminder-consent",
              outputSummary: consentReply.slice(0, 500),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(agentRuns.id, run.id));
          await completeJob(db, job.id);
          return;
        }

        const { handleTeamAppointmentResponse } = await import(
          "@/domain/team-reminders"
        );
        const teamAppointmentReply = await handleTeamAppointmentResponse(db, {
          phoneE164: identity.phoneE164,
          userId: conversation.userId,
          text: inboundText,
        });
        if (teamAppointmentReply) {
          await sendOutbound(db, {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId || job.workspaceId,
            externalConversationId: conversation.externalConversationId,
            text: teamAppointmentReply,
            correlationId,
            idempotencyKey: `job:${job.id}:team_appointment_response`,
            accountId,
          });
          await db
            .update(agentRuns)
            .set({
              status: "completed",
              provider: "deterministic",
              model: "team-appointment-response",
              outputSummary: teamAppointmentReply.slice(0, 500),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(agentRuns.id, run.id));
          await completeJob(db, job.id);
          return;
        }
      }

      // Dono do CRM: "ligar alerta lead" / "desligar alerta lead". Não é comando de DEV.
      if (identity?.phoneE164) {
        const { fraseAjudaCrm, fraseAlertaLead, fraseConsultaCrm, responderAlertaLead, consultarLeadsCrm } =
          await import("@/domain/crm-lead-alert");
        if (fraseAjudaCrm(inboundText)) {
          const reply = [
            "📘 *CRM no Assessor*",
            "• ligar alerta lead",
            "• desligar alerta lead",
            "• ligar alerta resposta",
            "• desligar alerta resposta",
            "• leads do dia",
            "• leads da semana",
            "• leads abertos",
            "• quem respondeu hoje",
            "Manual: https://assessor.moope.com.br/ajuda/crm",
          ].join("\n");
          await sendOutbound(db, {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId || job.workspaceId,
            externalConversationId: conversation.externalConversationId,
            text: reply,
            correlationId,
            idempotencyKey: `job:${job.id}:ajuda_crm`,
            accountId,
          });
          await db
            .update(agentRuns)
            .set({
              status: "completed",
              provider: "deterministic",
              model: "ajuda-crm",
              outputSummary: reply.slice(0, 500),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(agentRuns.id, run.id));
          await completeJob(db, job.id);
          return;
        }
        const alerta = fraseAlertaLead(inboundText);
        if (alerta) {
          const reply = await responderAlertaLead(identity.phoneE164, alerta.lado, alerta.kind);
          await sendOutbound(db, {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId || job.workspaceId,
            externalConversationId: conversation.externalConversationId,
            text: reply,
            correlationId,
            idempotencyKey: `job:${job.id}:alerta_lead:${alerta.kind}:${alerta.lado}`,
            accountId,
          });
          await db
            .update(agentRuns)
            .set({
              status: "completed",
              provider: "deterministic",
              model: `alerta-lead:${alerta.kind}:${alerta.lado}`,
              outputSummary: reply.slice(0, 500),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(agentRuns.id, run.id));
          await completeJob(db, job.id);
          return;
        }
        const consulta = fraseConsultaCrm(inboundText);
        if (consulta) {
          let reply = "Não consegui ler os leads do CRM agora. Tente de novo em instantes.";
          try {
            const achou = await consultarLeadsCrm(identity.phoneE164, consulta);
            if (achou) {
              reply = achou.text;
              const workspaceId = conversation.workspaceId || job.workspaceId;
              const userId = conversation.userId || "";
              if (achou.board && workspaceId && userId) {
                const { appendVisualBoard } = await import("@/domain/visual-board");
                reply = await appendVisualBoard(
                  { db, workspaceId, userId },
                  reply,
                  achou.board as import("@/domain/visual-board").VisualBoardPayload,
                );
              }
            }
          } catch {
            reply = "Não consegui ler os leads do CRM agora. Tente de novo em instantes.";
          }
          await sendOutbound(db, {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId || job.workspaceId,
            externalConversationId: conversation.externalConversationId,
            text: reply,
            correlationId,
            idempotencyKey: `job:${job.id}:consulta_crm:${consulta}`,
            accountId,
          });
          await db
            .update(agentRuns)
            .set({
              status: "completed",
              provider: "deterministic",
              model: `consulta-crm:${consulta}`,
              outputSummary: reply.slice(0, 500),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(agentRuns.id, run.id));
          await completeJob(db, job.id);
          return;
        }
      }

      // Ops DEV-only: /saude /status /cura /alerta /ops (não passa pelo LLM)
      if (identity?.phoneE164) {
        const { isDevOpsPhone, parseDevOpsCommand, runDevOpsCommand } =
          await import("@/domain/dev-ops-commands");
        if (isDevOpsPhone(identity.phoneE164)) {
          // Canal DEV master ↔ Cursor: /ajuste /ajustes /agente
          const {
            parseAjustePedido,
            saveAjustePedido,
            listAjustesHoje,
            isAgenteStatusCommand,
            getAgentStatusReply,
          } = await import("@/domain/dev-ajustes");
          const tNorm = String(inboundText || "")
            .trim()
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
          if (isAgenteStatusCommand(inboundText)) {
            const agentReply = await getAgentStatusReply(db);
            await sendOutbound(db, {
              conversationId: conversation.id,
              workspaceId: conversation.workspaceId || job.workspaceId,
              externalConversationId: conversation.externalConversationId,
              text: agentReply,
              correlationId,
              idempotencyKey: `job:${job.id}:dev_agente_status`,
              accountId,
            });
            await db
              .update(agentRuns)
              .set({
                status: "completed",
                provider: "deterministic",
                model: "dev-agente-status",
                outputSummary: agentReply.slice(0, 500),
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(agentRuns.id, run.id));
            await completeJob(db, job.id);
            return;
          }
          if (/^\/?ajuste\s*$/.test(tNorm)) {
            const help = [
              "🛠️ *Canal DEV · /ajuste*",
              "Mande o pedido na mesma mensagem, ex.:",
              "",
              "`/ajuste deixa o card do dólar menor`",
              "`ajuste: aviso de chuva às 7h`",
              "",
              "_Fila:_ `/ajustes` · _Engenheiro:_ `/agente`",
            ].join("\n");
            await sendOutbound(db, {
              conversationId: conversation.id,
              workspaceId: conversation.workspaceId || job.workspaceId,
              externalConversationId: conversation.externalConversationId,
              text: help,
              correlationId,
              idempotencyKey: `job:${job.id}:dev_ajuste_help`,
              accountId,
            });
            await db
              .update(agentRuns)
              .set({
                status: "completed",
                provider: "deterministic",
                model: "dev-ajuste-help",
                outputSummary: help.slice(0, 500),
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(agentRuns.id, run.id));
            await completeJob(db, job.id);
            return;
          }
          if (
            /^(ajustes?\s*hoje|listar ajustes?|\/ajustes?)$/.test(tNorm)
          ) {
            const listReply = await listAjustesHoje(db);
            await sendOutbound(db, {
              conversationId: conversation.id,
              workspaceId: conversation.workspaceId || job.workspaceId,
              externalConversationId: conversation.externalConversationId,
              text: listReply,
              correlationId,
              idempotencyKey: `job:${job.id}:dev_ajustes_list`,
              accountId,
            });
            await db
              .update(agentRuns)
              .set({
                status: "completed",
                provider: "deterministic",
                model: "dev-ajustes-list",
                outputSummary: listReply.slice(0, 500),
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(agentRuns.id, run.id));
            await completeJob(db, job.id);
            return;
          }
          const pedido = parseAjustePedido(inboundText);
          if (pedido) {
            const saved = await saveAjustePedido(db, {
              text: pedido,
              phoneE164: identity.phoneE164,
            });
            await sendOutbound(db, {
              conversationId: conversation.id,
              workspaceId: conversation.workspaceId || job.workspaceId,
              externalConversationId: conversation.externalConversationId,
              text: saved.reply,
              correlationId,
              idempotencyKey: `job:${job.id}:dev_ajuste:${saved.id}`,
              accountId,
            });
            await db
              .update(agentRuns)
              .set({
                status: "completed",
                provider: "deterministic",
                model: "dev-ajuste",
                outputSummary: saved.reply.slice(0, 500),
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(agentRuns.id, run.id));
            await completeJob(db, job.id);
            return;
          }

          const cmd = parseDevOpsCommand(inboundText);
          if (cmd) {
            let opsReply = await runDevOpsCommand(db, cmd);
            if (cmd === "consumo") {
              const { buildAiConsumoBoard } = await import("@/domain/ai-consumo");
              const { appendVisualBoard } = await import("@/domain/visual-board");
              const workspaceId = conversation.workspaceId || job.workspaceId;
              if (workspaceId) {
                opsReply = await appendVisualBoard(
                  {
                    db,
                    workspaceId,
                    userId: conversation.userId || "",
                  },
                  opsReply,
                  await buildAiConsumoBoard(db)
                );
              }
            }
            await sendOutbound(db, {
              conversationId: conversation.id,
              workspaceId: conversation.workspaceId || job.workspaceId,
              externalConversationId: conversation.externalConversationId,
              text: opsReply,
              correlationId,
              idempotencyKey: `job:${job.id}:dev_ops:${cmd}`,
              accountId,
            });
            await db
              .update(agentRuns)
              .set({
                status: "completed",
                provider: "deterministic",
                model: `dev-ops:${cmd}`,
                outputSummary: opsReply.slice(0, 500),
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(agentRuns.id, run.id));
            await completeJob(db, job.id);
            return;
          }
        }
      }
    }

    // Preferências de notificação (todos os usuários pareados)
    if (
      conversation.userId &&
      !needsOnboarding &&
      conversation.onboardingStep === "completed"
    ) {
      const { looksLikePreferencesCommand, handlePreferencesTurn } =
        await import("@/domain/user-preferences");
      if (looksLikePreferencesCommand(inboundText)) {
        const prefsReply = await handlePreferencesTurn(
          db,
          conversation.userId,
          inboundText
        );
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: prefsReply,
          correlationId,
          idempotencyKey: `job:${job.id}:prefs`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "user-preferences",
            outputSummary: prefsReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      const { looksLikeLegalAsk, formatLegalReply } = await import(
        "@/domain/legal-docs"
      );
      if (looksLikeLegalAsk(inboundText)) {
        const legalReply = formatLegalReply(inboundText) || "";
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: legalReply,
          correlationId,
          idempotencyKey: `job:${job.id}:legal`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "legal-docs",
            outputSummary: legalReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      const { looksLikePainelMenu, formatPainelMenu } = await import(
        "@/domain/painel-menu"
      );
      if (looksLikePainelMenu(inboundText)) {
        const painelReply = formatPainelMenu();
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: painelReply,
          correlationId,
          idempotencyKey: `job:${job.id}:painel`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "painel-menu",
            outputSummary: painelReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      const {
        classifyBalanceAsk,
        formatBalanceMenu,
        looksLikeBalancePick,
        matchBalancePick,
        readBalancePick,
        balanceTargetsForAsk,
      } = await import("@/domain/balance-route");
      const { setActiveBusinessContext, listBusinessOptions } = await import(
        "@/domain/business-context"
      );
      const { getTool } = await import("@/agent/tools/registry");

      const finishBalance = async (text: string, model: string) => {
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text,
          correlationId,
          idempotencyKey: `job:${job.id}:balance`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model,
            outputSummary: text.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
      };

      const saveBalancePick = async (options: BalanceTarget[]) => {
        const meta = (conversation.metadata || {}) as Record<string, unknown>;
        await db
          .update(conversations)
          .set({
            metadata: { ...meta, balancePick: { at: Date.now(), options } },
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conversation.id));
      };

      const clearBalancePick = async () => {
        const meta = { ...((conversation.metadata || {}) as Record<string, unknown>) };
        delete meta.balancePick;
        await db
          .update(conversations)
          .set({ metadata: meta, updatedAt: new Date() })
          .where(eq(conversations.id, conversation.id));
      };

      const runBalanceTarget = async (target: BalanceTarget, phone: string) => {
        const workspaceId = conversation.workspaceId || job.workspaceId;
        const userId = conversation.userId;
        if (!workspaceId || !userId) {
          await finishBalance("Não consegui abrir o balanço agora.", "balance-missing");
          return;
        }
        if (target.kind !== "pessoal") {
          const options = await listBusinessOptions(phone);
          const option = options.find(
            (o) => o.kind === target.kind && o.tenantId === target.tenantId
          );
          if (!option) {
            await finishBalance(
              target.kind === "locadora"
                ? "Neste número não há locadora liberada para o balanço."
                : "Neste número não há escritório liberado para o balanço.",
              "balance-none"
            );
            return;
          }
          await setActiveBusinessContext(db, phone, option);
        }
        const toolName =
          target.kind === "pessoal"
            ? "monthly_balance"
            : target.kind === "locadora"
              ? "query_locadora"
              : "query_escritorio";
        const tool = getTool(toolName);
        if (!tool) {
          await finishBalance("Não consegui abrir o balanço agora.", "balance-tool");
          return;
        }
        const result = await tool.handler(
          {
            db,
            userId,
            workspaceId,
            conversationId: conversation.id,
            agentRunId: run.id,
            correlationId,
            timezone: "America/Sao_Paulo",
            userText:
              target.kind === "locadora"
                ? "resumo da locadora"
                : target.kind === "facejus"
                  ? "resumo do escritório"
                  : "balanço do mês",
          },
          target.kind === "pessoal"
            ? {}
            : {
                question:
                  target.kind === "locadora" ? "resumo" : "resumo do escritório",
              }
        );
        await clearBalancePick();
        await finishBalance(result.summary || "Sem números nesta consulta.", "balance");
      };

      const phoneForBalance = conversation.whatsappIdentityId
        ? (
            await db.query.whatsappIdentities.findFirst({
              where: eq(whatsappIdentities.id, conversation.whatsappIdentityId),
            })
          )?.phoneE164 || null
        : null;

      if (conversation.userId && conversation.workspaceId) {
        const { handlePendingTeamReminderTurn } = await import(
          "@/domain/team-reminders"
        );
        const teamReply = await handlePendingTeamReminderTurn(db, {
          userId: conversation.userId,
          workspaceId: conversation.workspaceId,
          text: inboundText,
        });
        if (teamReply) {
          await sendOutbound(db, {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId,
            externalConversationId: conversation.externalConversationId,
            text: teamReply,
            correlationId,
            idempotencyKey: `job:${job.id}:team_reminder_selection`,
            accountId,
          });
          await db
            .update(agentRuns)
            .set({
              status: "completed",
              provider: "deterministic",
              model: "team-reminder-selection",
              outputSummary: teamReply.slice(0, 500),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(agentRuns.id, run.id));
          await completeJob(db, job.id);
          return;
        }
      }

      const pendingPick = readBalancePick(conversation.metadata);
      if (pendingPick && phoneForBalance && looksLikeBalancePick(inboundText)) {
        const idx = matchBalancePick(inboundText, pendingPick.options);
        if (idx == null) {
          await finishBalance(formatBalanceMenu(pendingPick.options), "balance-menu");
          return;
        }
        await runBalanceTarget(pendingPick.options[idx], phoneForBalance);
        return;
      }
      if (pendingPick && !looksLikeBalancePick(inboundText)) {
        await clearBalancePick();
      }

      const balanceAsk = classifyBalanceAsk(inboundText);
      if (balanceAsk && phoneForBalance && conversation.workspaceId) {
        const targets = await balanceTargetsForAsk(db, {
          phone: phoneForBalance,
          workspaceId: conversation.workspaceId,
          forced: balanceAsk === "ask" ? null : balanceAsk,
        });
        if (!targets.length) {
          await finishBalance(
            balanceAsk === "locadora"
              ? "Neste número não há locadora liberada. O pessoal segue com *balanço do mês*."
              : "Neste número não há escritório liberado.",
            "balance-none"
          );
          return;
        }
        if (targets.length === 1) {
          await runBalanceTarget(targets[0], phoneForBalance);
          return;
        }
        await saveBalancePick(targets);
        await finishBalance(formatBalanceMenu(targets), "balance-menu");
        return;
      }

      const { shouldHandleHoroscopeTurn, handleHoroscopeTurn } = await import(
        "@/domain/horoscope-prefs"
      );
      if (
        conversation.userId &&
        (await shouldHandleHoroscopeTurn(db, conversation.userId, inboundText))
      ) {
        const hReply = await handleHoroscopeTurn(
          db,
          conversation.userId,
          inboundText
        );
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: hReply,
          correlationId,
          idempotencyKey: `job:${job.id}:horoscope`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "horoscope",
            outputSummary: hReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      // Pin de localização WhatsApp → origem da rota
      const jobLoc = (job.payload as { location?: { lat: number; lon: number; name?: string | null; address?: string | null } | null })
        ?.location;
      const contentTypeEarly = String(
        (job.payload as { content_type?: string })?.content_type || ""
      ).toLowerCase();
      if (
        conversation.userId &&
        jobLoc &&
        Number.isFinite(jobLoc.lat) &&
        Number.isFinite(jobLoc.lon)
      ) {
        const { handleLocationShare } = await import("@/domain/routes");
        let phoneE164: string | null = null;
        if (conversation.whatsappIdentityId) {
          const idLoc = await db.query.whatsappIdentities.findFirst({
            where: eq(whatsappIdentities.id, conversation.whatsappIdentityId),
          });
          phoneE164 = idLoc?.phoneE164 || null;
        }
        const locReply = await handleLocationShare(db, {
          userId: conversation.userId,
          location: jobLoc,
          phoneE164,
        });
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: locReply,
          correlationId,
          idempotencyKey: `job:${job.id}:location_share`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "location-share",
            outputSummary: locReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }
      // Fallback: content_type location sem coords no payload tipado
      if (
        conversation.userId &&
        contentTypeEarly.includes("location") &&
        !jobLoc &&
        job.messageId
      ) {
        const { extractInboundLocation, handleLocationShare } = await import(
          "@/domain/routes"
        );
        const rawMsg = await db.query.messages.findFirst({
          where: eq(messages.id, job.messageId),
        });
        const deep = extractInboundLocation(rawMsg?.rawPayload || null);
        if (deep) {
          const locReply = await handleLocationShare(db, {
            userId: conversation.userId,
            location: deep,
          });
          await sendOutbound(db, {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId || job.workspaceId,
            externalConversationId: conversation.externalConversationId,
            text: locReply,
            correlationId,
            idempotencyKey: `job:${job.id}:location_share_deep`,
            accountId,
          });
          await db
            .update(agentRuns)
            .set({
              status: "completed",
              provider: "deterministic",
              model: "location-share",
              outputSummary: locReply.slice(0, 500),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(agentRuns.id, run.id));
          await completeJob(db, job.id);
          return;
        }
      }

      // Contato WhatsApp compartilhado → família
      // Zernio manda contacts em metadata.contacts (parser + deep raw)
      let jobContacts = (
        job.payload as {
          shared_contacts?: Array<{ name: string; phoneE164: string }> | null;
        }
      )?.shared_contacts;
      if (
        (!jobContacts || !jobContacts.length) &&
        conversation.userId &&
        job.messageId
      ) {
        try {
          const rawMsg = await db.query.messages.findFirst({
            where: eq(messages.id, job.messageId),
          });
          const { parseZernioWebhook } = await import("@/channels/zernio/parse");
          const reparsed = parseZernioWebhook(rawMsg?.rawPayload || {});
          if (reparsed?.sharedContacts?.length) {
            jobContacts = reparsed.sharedContacts;
          }
        } catch {
          /* ignore */
        }
      }
      const {
        handleSharedContacts,
        isAwaitingFamilyContact,
        looksLikeContactShareText,
      } = await import("@/domain/family-contacts");
      const awaitingFamily = conversation.userId
        ? await isAwaitingFamilyContact(db, conversation.userId)
        : false;
      const contactish =
        Array.isArray(jobContacts) && jobContacts.length > 0
          ? true
          : looksLikeContactShareText(inboundText) ||
            contentTypeEarly.includes("contact");
      if (
        conversation.userId &&
        contactish &&
        Array.isArray(jobContacts) &&
        jobContacts.length > 0 &&
        (awaitingFamily || contactish)
      ) {
        const familyReply = await handleSharedContacts(db, {
          userId: conversation.userId,
          contacts: jobContacts,
        });
        if (familyReply) {
          await sendOutbound(db, {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId || job.workspaceId,
            externalConversationId: conversation.externalConversationId,
            text: familyReply,
            correlationId,
            idempotencyKey: `job:${job.id}:family_contact_share`,
            accountId,
          });
          await db
            .update(agentRuns)
            .set({
              status: "completed",
              provider: "deterministic",
              model: "family-contact-share",
              outputSummary: familyReply.slice(0, 500),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(agentRuns.id, run.id));
          await completeJob(db, job.id);
          return;
        }
      }
      // Contato sem telefone no payload (só “👤 Nome”) enquanto aguarda família
      if (
        conversation.userId &&
        awaitingFamily &&
        looksLikeContactShareText(inboundText) &&
        (!jobContacts || !jobContacts.length)
      ) {
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: [
            "Recebi o card, mas o telefone não veio completo neste canal.",
            "Manda de novo pelo 📎 *Contato*, ou digite:",
            "`família Ju 61 99999-0000`",
          ].join("\n"),
          correlationId,
          idempotencyKey: `job:${job.id}:family_contact_incomplete`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "family-contact-incomplete",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      // Previsão do tempo (on-demand + cadastro cidade) — não passa pelo LLM
      const {
        shouldHandleWeatherTurn,
        handleWeatherTurn,
      } = await import("@/domain/weather-prefs");
      if (await shouldHandleWeatherTurn(db, conversation.userId, inboundText)) {
        let phoneE164: string | null = null;
        if (conversation.whatsappIdentityId) {
          const identity = await db.query.whatsappIdentities.findFirst({
            where: eq(whatsappIdentities.id, conversation.whatsappIdentityId),
          });
          phoneE164 = identity?.phoneE164 || null;
        }
        const weatherReply = await handleWeatherTurn(db, {
          userId: conversation.userId,
          text: inboundText,
          phoneE164,
        });
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: weatherReply,
          correlationId,
          idempotencyKey: `job:${job.id}:weather`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "weather",
            outputSummary: weatherReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      // Câmbio / cotação de moeda → card em R$ (não web_research)
      const { looksLikeFxIntent, handleFxTurn } = await import(
        "@/domain/exchange-rate"
      );
      if (looksLikeFxIntent(inboundText)) {
        const fxReply = await handleFxTurn(inboundText);
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: fxReply,
          correlationId,
          idempotencyKey: `job:${job.id}:fx`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "exchange-rate",
            outputSummary: fxReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      // “já paguei o telefone” fecha esse item, não o último comprovante aberto
      if (conversation.workspaceId) {
        const { parseSpokenDone, applySpokenDone, looksLikeYesterdayAsk, replyYesterdayOpen } =
          await import("@/domain/reminder-baixa");
        if (looksLikeYesterdayAsk(inboundText)) {
          const yReply = await replyYesterdayOpen(db, {
            workspaceId: conversation.workspaceId,
            timezone: "America/Sao_Paulo",
          });
          await sendOutbound(db, {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId || job.workspaceId,
            externalConversationId: conversation.externalConversationId,
            text: yReply,
            correlationId,
            idempotencyKey: `job:${job.id}:yesterday_open`,
            accountId,
          });
          await db
            .update(agentRuns)
            .set({
              status: "completed",
              provider: "deterministic",
              model: "yesterday-open",
              outputSummary: yReply.slice(0, 500),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(agentRuns.id, run.id));
          await completeJob(db, job.id);
          return;
        }
        if (parseSpokenDone(inboundText)) {
          const doneReply = await applySpokenDone(db, {
            workspaceId: conversation.workspaceId,
            text: inboundText,
          });
          if (doneReply) {
            await sendOutbound(db, {
              conversationId: conversation.id,
              workspaceId: conversation.workspaceId || job.workspaceId,
              externalConversationId: conversation.externalConversationId,
              text: doneReply,
              correlationId,
              idempotencyKey: `job:${job.id}:spoken_done`,
              accountId,
            });
            await db
              .update(agentRuns)
              .set({
                status: "completed",
                provider: "deterministic",
                model: "spoken-done",
                outputSummary: doneReply.slice(0, 500),
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(agentRuns.id, run.id));
            await completeJob(db, job.id);
            return;
          }
        }
      }

      // Comprovante na hora (após lembrete de conta)
      const {
        getReceiptPending,
        looksLikeReceiptPaidText,
        handleReceiptTextTurn,
      } = await import("@/domain/receipt-prompt");
      if (
        conversation.userId &&
        conversation.workspaceId &&
        looksLikeReceiptPaidText(inboundText) &&
        (await getReceiptPending(db, conversation.userId))
      ) {
        const receiptReply = await handleReceiptTextTurn(db, {
          userId: conversation.userId,
          workspaceId: conversation.workspaceId,
          text: inboundText,
        });
        if (receiptReply) {
          await sendOutbound(db, {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId || job.workspaceId,
            externalConversationId: conversation.externalConversationId,
            text: receiptReply,
            correlationId,
            idempotencyKey: `job:${job.id}:receipt_text`,
            accountId,
          });
          await db
            .update(agentRuns)
            .set({
              status: "completed",
              provider: "deterministic",
              model: "receipt-prompt",
              outputSummary: receiptReply.slice(0, 500),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(agentRuns.id, run.id));
          await completeJob(db, job.id);
          return;
        }
      }

      // Modo família (cadastro / lista)
      const {
        looksLikeContactGroupIntent,
        isPendingGroupContactPhone,
        isPendingContactPhoneFix,
        handleContactGroupTurn,
        looksLikeFamilyIntent,
        handleFamilyTurn,
      } = await import("@/domain/family-contacts");
      if (
        conversation.userId &&
        (looksLikeContactGroupIntent(inboundText) ||
          await isPendingGroupContactPhone(db, conversation.userId, inboundText))
      ) {
        const groupReply = await handleContactGroupTurn(db, {
          userId: conversation.userId,
          text: inboundText,
        });
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: groupReply,
          correlationId,
          idempotencyKey: `job:${job.id}:contact_group`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "contact-groups",
            outputSummary: groupReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }
      if (
        conversation.userId &&
        (looksLikeFamilyIntent(inboundText) ||
          (await isPendingContactPhoneFix(db, conversation.userId, inboundText)))
      ) {
        const familyReply = await handleFamilyTurn(db, {
          userId: conversation.userId,
          text: inboundText,
        });
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: familyReply,
          correlationId,
          idempotencyKey: `job:${job.id}:family`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "family-contacts",
            outputSummary: familyReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      // Modo viagem
      const { looksLikeTravelIntent, handleTravelTurn } = await import(
        "@/domain/travel-mode"
      );
      if (conversation.userId && looksLikeTravelIntent(inboundText)) {
        const travelReply = await handleTravelTurn(db, {
          userId: conversation.userId,
          text: inboundText,
        });
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: travelReply,
          correlationId,
          idempotencyKey: `job:${job.id}:travel`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "travel-mode",
            outputSummary: travelReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      // Follow-up social
      const { looksLikeSocialFollowUp, handleSocialFollowUp } = await import(
        "@/domain/social-followup"
      );
      if (
        conversation.userId &&
        conversation.workspaceId &&
        looksLikeSocialFollowUp(inboundText)
      ) {
        const owner = await db.query.users.findFirst({
          where: eq(users.id, conversation.userId),
        });
        const socialReply = await handleSocialFollowUp(db, {
          userId: conversation.userId,
          workspaceId: conversation.workspaceId,
          text: inboundText,
          timezone: owner?.timezone || "America/Sao_Paulo",
        });
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: socialReply,
          correlationId,
          idempotencyKey: `job:${job.id}:social_followup`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "social-followup",
            outputSummary: socialReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      // Memória útil (fatos pessoais)
      const {
        looksLikeUsefulMemoryIntent,
        handleUsefulMemoryTurn,
      } = await import("@/domain/useful-memory");
      if (
        conversation.userId &&
        conversation.workspaceId &&
        looksLikeUsefulMemoryIntent(inboundText)
      ) {
        const memReply = await handleUsefulMemoryTurn(db, {
          userId: conversation.userId,
          workspaceId: conversation.workspaceId,
          conversationId: conversation.id,
          text: inboundText,
        });
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: memReply,
          correlationId,
          idempotencyKey: `job:${job.id}:useful_memory`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "useful-memory",
            outputSummary: memReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }

      // Rotas / Saí de casa
      const {
        looksLikeLeaveHomeIntent,
        handleLeaveHomeTurn,
      } = await import("@/domain/leave-home");
      const { looksLikeRouteIntent, handleRouteTurn } = await import(
        "@/domain/routes"
      );
      const { classifyTurnAct } = await import("@/domain/turn-act");
      const turnAct = classifyTurnAct(inboundText);
      if (turnAct === "registrar_pessoal" || turnAct === "listar_dia") {
        // Compromisso e lista do dia não passam por rota.
      } else if (looksLikeLeaveHomeIntent(inboundText)) {
        let phoneE164: string | null = null;
        if (conversation.whatsappIdentityId) {
          const identity = await db.query.whatsappIdentities.findFirst({
            where: eq(whatsappIdentities.id, conversation.whatsappIdentityId),
          });
          phoneE164 = identity?.phoneE164 || null;
        }
        const user = conversation.userId
          ? await db.query.users.findFirst({
              where: eq(users.id, conversation.userId),
            })
          : null;
        const leaveReply = await handleLeaveHomeTurn(db, {
          userId: conversation.userId!,
          workspaceId: conversation.workspaceId || job.workspaceId!,
          text: inboundText,
          phoneE164,
          timezone: user?.timezone || "America/Sao_Paulo",
        });
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: leaveReply,
          correlationId,
          idempotencyKey: `job:${job.id}:leave_home`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "leave-home",
            outputSummary: leaveReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }
      else if (looksLikeRouteIntent(inboundText)) {
        let phoneE164: string | null = null;
        if (conversation.whatsappIdentityId) {
          const identity = await db.query.whatsappIdentities.findFirst({
            where: eq(whatsappIdentities.id, conversation.whatsappIdentityId),
          });
          phoneE164 = identity?.phoneE164 || null;
        }
        const routeReply = await handleRouteTurn(db, {
          userId: conversation.userId,
          text: inboundText,
          phoneE164,
        });
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId || job.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: routeReply,
          correlationId,
          idempotencyKey: `job:${job.id}:route`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "deterministic",
            model: "routes",
            outputSummary: routeReply.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }
    }

    // Anti-abuso: flood / tokens / mensagem gigante
    if (conversation.workspaceId && !needsOnboarding) {
      const rl = await checkInboundRateLimit(db, {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        userText: inboundText,
      });
      if (!rl.ok) {
        await sendOutbound(db, {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId,
          externalConversationId: conversation.externalConversationId,
          text: rl.userMessage,
          correlationId,
          idempotencyKey: `job:${job.id}:rate_limit`,
          accountId,
        });
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            provider: "rate_limit",
            model: rl.reason,
            outputSummary: rl.userMessage.slice(0, 500),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }
      if (rl.truncatedText) inboundText = rl.truncatedText;
    }

    const mediaUrl = String(
      (job.payload as { media_url?: string })?.media_url || ""
    );
    const mediaMime = String(
      (job.payload as { media_mime_type?: string })?.media_mime_type || ""
    );
    const contentType = String(
      (job.payload as { content_type?: string })?.content_type || "text"
    );

    let reply = "";
    let metrics = {
      provider: "onboarding",
      model: "state-machine",
      inputTokens: undefined as number | undefined,
      outputTokens: undefined as number | undefined,
      latencyMs: 0,
      toolCount: 0,
    };

    if (needsOnboarding) {
      const result = await handleOnboardingTurn(db, {
        conversation,
        identityId: conversation.whatsappIdentityId,
        text: inboundText || "Oi",
      });
      reply = result.reply;
    } else {
      // Media for paired users: transcribe audio or ingest docs/images first
      let audioTranscriptHint: string | null = null;
      let mediaShortCircuit: string | null = null;

      if (mediaUrl && conversation.workspaceId && conversation.userId) {
        const media = await processInboundMedia(db, {
          workspaceId: conversation.workspaceId,
          userId: conversation.userId,
          conversationId: conversation.id,
          messageId: job.messageId,
          mediaUrl,
          mediaMimeType: mediaMime || null,
          contentType,
          caption: inboundText || null,
        });
        if (media.kind === "skipped") {
          mediaShortCircuit =
            media.reason === "video"
              ? "Ainda não consigo processar vídeo 🎬 Me manda uma foto, PDF ou áudio que eu te ajudo 📎"
              : "Esse tipo de arquivo eu ainda não consigo abrir. Me manda foto, PDF ou áudio 📎";
        } else if (media.kind === "audio") {
          if (media.text) {
            audioTranscriptHint = media.text;
            inboundText = media.text;

            // Áudio puro chegava sem texto no bloco cedo — re-despacha atalhos
            try {
              const { tryPersonalShortcuts } = await import(
                "@/domain/personal-shortcuts"
              );
              const owner = await db.query.users.findFirst({
                where: eq(users.id, conversation.userId!),
              });
              const phoneE164 = conversation.whatsappIdentityId
                ? (
                    await db.query.whatsappIdentities.findFirst({
                      where: eq(
                        whatsappIdentities.id,
                        conversation.whatsappIdentityId
                      ),
                    })
                  )?.phoneE164 || null
                : null;
              const hit = await tryPersonalShortcuts(db, {
                userId: conversation.userId!,
                workspaceId: conversation.workspaceId!,
                text: inboundText,
                phoneE164,
                timezone: owner?.timezone || "America/Sao_Paulo",
              });
              if (hit) {
                const snippet =
                  media.text.length > 120
                    ? `${media.text.slice(0, 117)}…`
                    : media.text;
                mediaShortCircuit = `🎧 Ouvi: “${snippet}”\n\n${hit.reply}`;
                metrics = {
                  provider: "deterministic",
                  model: `audio:${hit.model}`,
                  inputTokens: 0,
                  outputTokens: 0,
                  latencyMs: 0,
                  toolCount: 0,
                };
              }
            } catch {
              /* segue pro LLM */
            }
          } else {
            mediaShortCircuit =
              "Recebi o áudio, mas não consegui entender o que você falou 🎧 Pode repetir ou digitar?";
          }
        } else if (media.kind === "document") {
          const caption = inboundText?.trim() || "";
          const { isLocadoraInclusaoPhrase } = await import("@/domain/locadora-intent");
          const locadoraFoto = isLocadoraInclusaoPhrase(caption);
          if (locadoraFoto) {
            try {
              const phone = conversation.whatsappIdentityId
                ? (
                    await db.query.whatsappIdentities.findFirst({
                      where: eq(whatsappIdentities.id, conversation.whatsappIdentityId),
                    })
                  )?.phoneE164
                : null;
              if (!phone) {
                mediaShortCircuit =
                  "Não identifiquei o WhatsApp para enviar essa foto à locadora. Ela não entrou no gasto pessoal.";
              } else {
                const { postLocadoraAcao } = await import(
                  "@/integrations/moope-finance-assessor"
                );
                const posted = await postLocadoraAcao(
                  phone,
                  caption,
                  {
                    amount: media.extracted?.amount ?? null,
                    date: media.extracted?.date ?? null,
                    merchant: media.extracted?.merchant ?? null,
                    summary: media.extracted?.summary ?? null,
                    rawText: media.text || media.extracted?.rawText || null,
                  },
                  media.imageBase64
                    ? {
                        base64: media.imageBase64,
                        mime: media.imageMime,
                        nome: media.imageName,
                      }
                    : null
                );
                mediaShortCircuit =
                  posted.text ||
                  posted.message ||
                  "Não consegui falar com a locadora agora. A foto não entrou no gasto pessoal.";
              }
              metrics = {
                provider: "deterministic",
                model: "locadora-foto",
                inputTokens: 0,
                outputTokens: 0,
                latencyMs: 0,
                toolCount: 1,
              };
            } catch {
              mediaShortCircuit =
                "Não consegui falar com a locadora agora. A foto não entrou no gasto pessoal.";
            }
          }

          // Comprovante na hora: se aguardando foto pós-lembrete de conta
          // (mesmo com visão fraca — o arquivo já foi ingerido)
          try {
            if (locadoraFoto) {
              /* a frase da locadora não fecha comprovante pessoal */
            } else {
            const { handleReceiptMedia } = await import(
              "@/domain/receipt-prompt"
            );
            const receiptReply = await handleReceiptMedia(db, {
              userId: conversation.userId!,
              workspaceId: conversation.workspaceId!,
              documentId: media.documentId!,
              amount: media.extracted?.amount ?? null,
              merchant: media.extracted?.merchant ?? null,
              summary: media.extracted?.summary ?? media.text ?? null,
            });
            if (receiptReply) {
              mediaShortCircuit = receiptReply;
              metrics = {
                provider: "deterministic",
                model: "receipt-prompt",
                inputTokens: 0,
                outputTokens: 0,
                latencyMs: 0,
                toolCount: 0,
              };
            }
            }
          } catch {
            /* segue fluxo normal */
          }

          const imageAsked =
            /(anota|guarda|salva|lembra|lembre|me avisa|gastei|despesa|boleto|conta|resume|resumo|extrai|quanto|valor|cadastr|registr)/i.test(
              caption
            );
          if (locadoraFoto) {
            /* rascunho da locadora já respondeu; não vira gasto pessoal */
          } else if (!mediaShortCircuit && !imageAsked && media.visionUnreadable && !media.text) {
            mediaShortCircuit =
              "📷 Recebi a foto, mas não consegui ver o que é.\nManda de novo mais nítida, ou diga o que quer que eu faça.";
          } else if (!mediaShortCircuit && !imageAsked) {
            const { replyForUnaskedPhoto } = await import("@/domain/vision-extract");
            const sceneReply = replyForUnaskedPhoto(media.extracted);
            if (sceneReply) {
              mediaShortCircuit = sceneReply;
            } else if (
              media.extracted?.amount != null &&
              Number(media.extracted.amount) > 0
            ) {
              const { getTool } = await import("@/agent/tools/registry");
              await import("@/agent/tools");
              const tool = getTool("propose_bill");
              if (tool) {
                const owner = await db.query.users.findFirst({
                  where: eq(users.id, conversation.userId!),
                });
                const bill = await tool.handler(
                  {
                    db,
                    userId: conversation.userId!,
                    workspaceId: conversation.workspaceId!,
                    conversationId: conversation.id,
                    agentRunId: run.id,
                    correlationId,
                    timezone: owner?.timezone || "America/Sao_Paulo",
                    userText: caption || undefined,
                    relatedDocumentId: media.documentId,
                  },
                  {
                    amount: media.extracted.amount,
                    category: media.extracted.category || "conta",
                    merchant: media.extracted.merchant || undefined,
                    due_date: media.extracted.date || undefined,
                    note: caption || media.extracted.summary || undefined,
                    entry_type: "expense",
                    document_id: media.documentId,
                  }
                );
                mediaShortCircuit = bill.summary;
                metrics = {
                  provider: "deterministic",
                  model: "photo-bill",
                  inputTokens: 0,
                  outputTokens: 0,
                  latencyMs: 0,
                  toolCount: 1,
                };
              }
            }
          } else if (!mediaShortCircuit && media.visionUnreadable && !media.text) {
            mediaShortCircuit = caption
              ? `Recebi a foto 📷, mas não consegui ler o conteúdo.\nManda de novo mais nítida ou digita o valor/texto.\n\n_Você escreveu:_ ${caption.slice(0, 120)}`
              : "Recebi a foto, mas não consegui ler 📷 Manda de novo mais nítida ou digita o valor.";
          } else if (
            !mediaShortCircuit &&
            media.extracted?.kind === "nota_recibo" &&
            media.extracted.amount != null &&
            Number(media.extracted.amount) > 0
          ) {
            // Caminho duro: boleto/nota com valor → propose_bill (não depende do LLM)
            const { getTool } = await import("@/agent/tools/registry");
            // ensure tools registered
            await import("@/agent/tools");
            const tool = getTool("propose_bill");
            if (tool) {
              const owner = await db.query.users.findFirst({
                where: eq(users.id, conversation.userId!),
              });
              const bill = await tool.handler(
                {
                  db,
                  userId: conversation.userId!,
                  workspaceId: conversation.workspaceId!,
                  conversationId: conversation.id,
                  agentRunId: run.id,
                  correlationId,
                  timezone: owner?.timezone || "America/Sao_Paulo",
                  userText: caption || undefined,
                  relatedDocumentId: media.documentId,
                },
                {
                  amount: media.extracted.amount,
                  category: media.extracted.category || "conta",
                  merchant: media.extracted.merchant || undefined,
                  due_date: media.extracted.date || undefined,
                  note: caption || media.extracted.summary || undefined,
                  entry_type: "expense",
                  document_id: media.documentId,
                }
              );
              mediaShortCircuit = bill.summary;
              metrics = {
                provider: "deterministic",
                model: "bill-direct",
                inputTokens: 0,
                outputTokens: 0,
                latencyMs: 0,
                toolCount: 1,
              };
            }
          } else if (!mediaShortCircuit && media.text) {
            inboundText = [caption, `[Conteúdo da imagem]\n${media.text}`]
              .filter(Boolean)
              .join("\n\n");
            if (media.extracted?.kind === "receita_medica") {
              inboundText +=
                "\n\nConfirme de forma humana com 💊 (remédio, dose, médico). " +
                "No final ofereça: “Quer que eu te lembre de tomar o remédio? É só falar o horário.”";
            }
          } else if (!mediaShortCircuit && !caption) {
            mediaShortCircuit =
              "Recebi o arquivo 📎 Ainda estou processando o texto. Me diga o que quer que eu faça com ele (ex.: “resume” ou “anota o valor”).";
          }
        }
      }

      if (mediaShortCircuit) {
        reply = mediaShortCircuit;
      } else {
      const user = await db.query.users.findFirst({
        where: eq(users.id, conversation.userId!),
      });
      if (!user) throw new Error("user_not_found");
      if (user.accountStatus === "suspended" || user.accountStatus === "cancelled") {
        reply =
          "Sua conta está temporariamente suspensa. Fale com o suporte MOOPE.";
      } else {
        const agent = await runAgentTurn(db, {
          agentRunId: run.id,
          jobId: job.id,
          userId: user.id,
          workspaceId: conversation.workspaceId!,
          conversationId: conversation.id,
          userText: inboundText,
          timezone: user.timezone,
          correlationId,
          audioTranscriptHint,
        });
        reply = agent.reply;
        if (audioTranscriptHint && !/^🎧|ouvi/i.test(reply)) {
          const snippet =
            audioTranscriptHint.length > 120
              ? `${audioTranscriptHint.slice(0, 117)}…`
              : audioTranscriptHint;
          reply = `🎧 Ouvi: “${snippet}”\n\n${reply}`;
        }
        metrics = {
          provider: agent.provider,
          model: agent.model,
          inputTokens: agent.inputTokens,
          outputTokens: agent.outputTokens,
          latencyMs: agent.latencyMs,
          toolCount: agent.toolCount,
        };
      }
      }
    }

    // Arquivo com caption já foi o reply — não manda bolha de texto vazia/duplicada.
    let outboundText = String(reply || "").trim();
    if (looksLikeCodeLeak(outboundText)) {
      log.error("code_leak_blocked", { snippet: outboundText.slice(0, 180) });
      outboundText = await rescueUserReply(db, inboundText);
    }
    if (outboundText) {
      await sendOutbound(db, {
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        externalConversationId: conversation.externalConversationId,
        text: outboundText,
        correlationId,
        idempotencyKey: `job:${job.id}:reply`,
        accountId,
      });
    }

    await db
      .update(agentRuns)
      .set({
        status: "completed",
        provider: metrics.provider,
        model: metrics.model,
        outputSummary: (outboundText || "(media only)").slice(0, 1000),
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        latencyMs: metrics.latencyMs,
        toolCount: metrics.toolCount,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, run.id));

    await completeJob(db, job.id);
    log.info("agent_job_completed", {
      agent_run_id: run.id,
      tool_count: metrics.toolCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "job_failed";
    await db
      .update(agentRuns)
      .set({
        status: "failed",
        error: message,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, run.id));

    // Nunca deixar o WhatsApp em silêncio: avisa o usuário no último attempt
    // ou quando o provedor de IA está indisponível (não adianta retentar às cegas).
    const willExhaust = job.attempts + 1 >= job.maxAttempts;
    const aiDown = /AI_PROVIDER|openai|EMBEDDING_PROVIDER/i.test(message);
    if ((willExhaust || aiDown) && job.conversationId) {
      try {
        const conversation = await db.query.conversations.findFirst({
          where: eq(conversations.id, job.conversationId),
        });
        if (conversation?.externalConversationId) {
          let accountId =
            String((job.payload as { account_id?: string })?.account_id || "") ||
            undefined;
          if (!accountId && conversation.whatsappChannelId) {
            const channel = await db.query.whatsappChannels.findFirst({
              where: eq(whatsappChannels.id, conversation.whatsappChannelId),
            });
            accountId = channel?.providerAccountId || undefined;
          }
          await sendOutbound(db, {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId,
            externalConversationId: conversation.externalConversationId,
            text: aiDown
              ? "Tive um problema técnico agora e não consegui processar. Já estou restabelecendo — manda de novo em alguns segundos."
              : "Não consegui concluir agora. Pode repetir o pedido?",
            correlationId,
            idempotencyKey: `job:${job.id}:error-notice`,
            accountId,
          });
        }
      } catch (notifyErr) {
        log.error("agent_error_notice_failed", {
          error:
            notifyErr instanceof Error ? notifyErr.message : "notify_failed",
        });
      }
    }

    await failJob(db, job, message);
    log.error("agent_job_processing_error", { error: message });
  }
}

async function processReminderDelivery(
  db: Db,
  job: AgentJob,
  correlationId: string,
  log: ReturnType<typeof logger.child>
) {
  const reminderId = String(
    (job.payload as { reminder_id?: string }).reminder_id || ""
  );
  const [run] = await db
    .insert(agentRuns)
    .values({
      jobId: job.id,
      workspaceId: job.workspaceId,
      status: "running",
      provider: "scheduler",
      model: "reminder-delivery",
      correlationId,
    })
    .returning();

  try {
    const reminder = await db.query.reminders.findFirst({
      where: and(eq(reminders.id, reminderId), isNull(reminders.deletedAt)),
    });
    if (!reminder) throw new Error("reminder_not_found");
    if (reminder.status === "sent") {
      try {
        const { markOutboxDelivered, reminderOccurrenceKey } = await import(
          "@/domain/alert-delivery"
        );
        await markOutboxDelivered(db, {
          occurrenceKey: reminderOccurrenceKey(reminder.id, reminder.fireAt),
          messageId: null,
        });
      } catch {
        /* ignore */
      }
      await completeJob(db, job.id);
      await db
        .update(agentRuns)
        .set({
          status: "completed",
          outputSummary: "already_sent",
          finishedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id));
      return;
    }
    if (reminder.status === "cancelled") {
      await completeJob(db, job.id);
      return;
    }

    const { cancelUnauthorizedTeamReminder } = await import(
      "@/domain/team-reminders"
    );
    const teamReminderCancelled = await cancelUnauthorizedTeamReminder(db, {
      id: reminder.id,
      fireAt: reminder.fireAt,
      payload: (reminder.payload || {}) as Record<string, unknown>,
    });
    if (teamReminderCancelled) {
      await db
        .update(agentRuns)
        .set({
          status: "completed",
          outputSummary: "team_recipient_not_authorized",
          finishedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id));
      await completeJob(db, job.id);
      return;
    }

    // Mensagem de equipe externa: template Utility only; sem fallback de texto.
    const { tryDeliverTeamReminderExternal } = await import(
      "@/domain/team-reminders"
    );
    const teamDelivery = await tryDeliverTeamReminderExternal(db, {
      id: reminder.id,
      fireAt: reminder.fireAt,
      timezone: reminder.timezone,
      recurrenceRule: reminder.recurrenceRule,
      payload: (reminder.payload || {}) as Record<string, unknown>,
    });
    if (teamDelivery.handled) {
        await db
          .update(reminders)
          .set({
            status: teamDelivery.ok
              ? teamDelivery.nextFireAt
                ? "scheduled"
                : "sent"
              : "failed",
            ...(teamDelivery.nextFireAt
              ? {
                  fireAt: teamDelivery.nextFireAt,
                  nextAttemptAt: teamDelivery.nextFireAt,
                  attemptCount: 0,
                }
              : {}),
            lastDeliveredAt: teamDelivery.ok ? new Date() : null,
            lastError: teamDelivery.errorCode || null,
            lockedAt: null,
            lockedBy: null,
            updatedAt: new Date(),
          })
          .where(eq(reminders.id, reminder.id));
        try {
          const { ensureReminderOutbox, markOutboxDelivered, markOutboxFailed, reminderOccurrenceKey } = await import(
            "@/domain/alert-delivery"
          );
          const occurrenceKey = reminderOccurrenceKey(reminder.id, reminder.fireAt);
          if (teamDelivery.ok) {
            await markOutboxDelivered(db, { occurrenceKey, messageId: null });
            if (teamDelivery.nextFireAt) {
              const nextKey = reminderOccurrenceKey(reminder.id, teamDelivery.nextFireAt);
              await db
                .update(reminders)
                .set({ occurrenceKey: nextKey, updatedAt: new Date() })
                .where(eq(reminders.id, reminder.id));
              await ensureReminderOutbox(db, {
                id: reminder.id,
                workspaceId: reminder.workspaceId,
                userId: reminder.userId,
                title: reminder.title,
                fireAt: teamDelivery.nextFireAt,
                payload: (reminder.payload || {}) as Record<string, unknown>,
              });
            }
          } else {
            await markOutboxFailed(db, { occurrenceKey, error: teamDelivery.errorCode || "team_template_send_failed" });
          }
        } catch {
          /* outbox follows the reminder result */
        }
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            outputSummary: teamDelivery.ok
              ? "team_template_delivery_ok"
              : `team_template_delivery_failed:${teamDelivery.errorCode || "unknown"}`,
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
    }

    // One-shot família: manda pro Zap da pessoa (não pro dono)
    try {
      const { tryDeliverFamilyOneshot } = await import(
        "@/domain/family-contacts"
      );
      const oneshot = await tryDeliverFamilyOneshot(db, {
        id: reminder.id,
        title: reminder.title,
        fireAt: reminder.fireAt,
        timezone: reminder.timezone,
        payload: (reminder.payload || {}) as Record<string, unknown>,
      });
      if (oneshot.handled) {
        await db
          .update(reminders)
          .set({
            status: "sent",
            lastDeliveredAt: new Date(),
            lockedAt: null,
            lockedBy: null,
            updatedAt: new Date(),
          })
          .where(eq(reminders.id, reminder.id));
        try {
          const { markOutboxDelivered, reminderOccurrenceKey } = await import(
            "@/domain/alert-delivery"
          );
          await markOutboxDelivered(db, {
            occurrenceKey: reminderOccurrenceKey(reminder.id, reminder.fireAt),
            messageId: null,
          });
        } catch {
          /* ignore */
        }
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            outputSummary: oneshot.ok
              ? "family_oneshot_ok"
              : "family_oneshot_fail",
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await completeJob(db, job.id);
        return;
      }
    } catch {
      /* segue entrega normal */
    }

    const conversation = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.userId, reminder.userId),
        eq(conversations.workspaceId, reminder.workspaceId),
        isNull(conversations.deletedAt)
      ),
      orderBy: (c, { desc }) => [desc(c.lastMessageAt)],
    });

    if (!conversation?.externalConversationId) {
      throw new Error("no_conversation_for_reminder");
    }

    const occurrenceKey = `reminder:${reminder.id}:${reminder.fireAt.toISOString()}`;
    const outbound = await sendOutbound(db, {
      conversationId: conversation.id,
      workspaceId: reminder.workspaceId,
      externalConversationId: conversation.externalConversationId,
      text: formatReminderDelivery({
        title: reminder.title,
        fireAt: reminder.fireAt,
        timezone: reminder.timezone,
        payload: (reminder.payload || {}) as ReminderPayload,
      }),
      correlationId,
      idempotencyKey: `reminder_delivery:${reminder.id}:${reminder.fireAt.toISOString()}:msg`,
      proactive: true,
    });

    // Conta/boleto → aguarda comprovante na próxima foto / "já paguei"
    try {
      const { isBillLikeReminder, setReceiptPending } = await import(
        "@/domain/receipt-prompt"
      );
      const payload = (reminder.payload || {}) as ReminderPayload;
      if (isBillLikeReminder(reminder.title, payload)) {
        const amt =
          typeof payload.amount === "number" && Number.isFinite(payload.amount)
            ? payload.amount
            : null;
        await setReceiptPending(db, reminder.userId, {
          reminder_id: reminder.id,
          title: reminder.title,
          amount: amt,
        });
      }
    } catch {
      /* não bloqueia entrega */
    }

    const {
      markOutboxDelivered,
      ensureReminderOutbox,
      reminderOccurrenceKey,
    } = await import("@/domain/alert-delivery");
    await markOutboxDelivered(db, {
      occurrenceKey: reminderOccurrenceKey(reminder.id, reminder.fireAt),
      messageId: outbound?.id || null,
    });

    const { nextFireFromRecurrence } = await import("@/lib/recurrence");
    const nextFire = nextFireFromRecurrence(
      reminder.fireAt,
      reminder.timezone,
      reminder.recurrenceRule
    );
    if (nextFire) {
      await db
        .update(reminders)
        .set({
          status: "scheduled",
          fireAt: nextFire,
          attemptCount: 0,
          nextAttemptAt: nextFire,
          lastError: null,
          lastDeliveredAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          occurrenceKey: reminderOccurrenceKey(reminder.id, nextFire),
          updatedAt: new Date(),
        })
        .where(eq(reminders.id, reminder.id));
      await ensureReminderOutbox(db, {
        id: reminder.id,
        workspaceId: reminder.workspaceId,
        userId: reminder.userId,
        title: reminder.title,
        fireAt: nextFire,
        payload: (reminder.payload || {}) as Record<string, unknown>,
      });
      log.info("reminder_rescheduled", {
        reminder_id: reminder.id,
        next_fire: nextFire.toISOString(),
      });
    } else {
      await db
        .update(reminders)
        .set({
          status: "sent",
          lastDeliveredAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(reminders.id, reminder.id));
    }

    await db
      .update(agentRuns)
      .set({
        status: "completed",
        outputSummary: reminder.title,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, run.id));
    await completeJob(db, job.id);
    log.info("reminder_delivered", {
      reminder_id: reminder.id,
      occurrence_key: occurrenceKey,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "reminder_failed";
    await db
      .update(agentRuns)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(agentRuns.id, run.id));

    try {
      const { markOutboxFailed, reminderOccurrenceKey } = await import(
        "@/domain/alert-delivery"
      );
      if (reminderId) {
        const rem = await db.query.reminders.findFirst({
          where: eq(reminders.id, reminderId),
        });
        if (rem) {
          await markOutboxFailed(db, {
            occurrenceKey: reminderOccurrenceKey(rem.id, rem.fireAt),
            error: message,
            retryInSeconds: message === "TEMPLATE_NOT_CONFIGURED" ? 600 : 120,
          });
        }
      }
    } catch {
      /* ignore outbox mark errors */
    }

    if (message === "TEMPLATE_NOT_CONFIGURED") {
      if (reminderId) {
        await db
          .update(reminders)
          .set({
            status: "queued",
            lastError: message,
            nextAttemptAt: new Date(Date.now() + 10 * 60 * 1000),
            updatedAt: new Date(),
          })
          .where(eq(reminders.id, reminderId));
      }
      await failJob(db, job, message);
      return;
    }

    if (reminderId) {
      await db
        .update(reminders)
        .set({
          status: "failed",
          lastError: message.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + 2 * 60 * 1000),
          lockedAt: null,
          lockedBy: null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(reminders.id, reminderId), eq(reminders.status, "queued"))
        );
    }
    await failJob(db, job, message);
  }
}
