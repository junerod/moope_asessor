import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { toolCalls } from "@/db/schema";
import { evaluateToolPolicy } from "@/agent/policy/engine";
import {
  getTool,
  toolDefinitionsForLlm,
  type ToolContext,
  type ToolHandlerResult,
} from "@/agent/tools";
import "@/agent/tools";
import { buildAgentContext, buildSystemPrompt } from "@/agent/context-builder";
import { resolveLanguageModelProvider } from "@/lib/ai/providers";
import type { ChatMessage, ToolCallRequest } from "@/lib/ai/providers/types";
import { logger } from "@/lib/logger";
import { incrementUsage } from "@/domain/entitlements";
import {
  formatReminderConfirmBlock,
  type ReminderPayload,
} from "@/lib/reminder-copy";
import { checkSpendingLimitAlert } from "@/agent/tools/goals";
import { looksLikeSpend, scrubFakeValueHint } from "@/domain/receipt-undo";
import { looksLikeCodeLeak } from "@/domain/safe-reply";

export type AgentRuntimeResult = {
  reply: string;
  toolResults: Array<{ name: string; result: ToolHandlerResult }>;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  toolCount: number;
};

/** Rendimento (painel viewlocrend) ou calendário de recebimentos — sem o LLM reescrever. */
function looksLikeLocadoraMoneyDirect(text: string): boolean {
  const q = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!q.trim()) return false;
  if (/\b(me lembra|me lembre|lembrete|me avisa)\b/.test(q)) return false;
  if (/rendiment|lucro da locadora|faturamento da locadora|viewlocrend/.test(q)) return true;
  if (
    /recebiment|calendario de (pagamento|recebimento)|quanto (eu )?tenho para receber|calendario de pagamento/.test(
      q
    )
  ) {
    return true;
  }
  return false;
}

/** Painel de investidores — o Finance só libera para o gerente geral. */
function looksLikeLocatariosDirect(text: string): boolean {
  const q = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!q.trim()) return false;
  if (/investidor|cnh|atras|inadimpl|deve|vistoria|manuten/.test(q)) return false;
  if (/\b(agendar|marcar|marque|compromisso|reuniao|me lembra|lembrete)\b/.test(q)) {
    return false;
  }
  return /\blocatari/.test(q);
}

function looksLikeVeiculosDirect(text: string): boolean {
  const q = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!q.trim()) return false;
  if (/investidor|opera|filial|rendiment|onde|localiza|rastre|alerta|vistoria|checklist/.test(q)) {
    return false;
  }
  if (/\b(veiculos?|carros?|motos?|motocicleta|caminhoes?|caminhao|vans?|onibus|pickups?|bicicletas?)\b/.test(q)) {
    return true;
  }
  return /painel d[ae] frota|minha frota|frota da locadora/.test(q);
}

function looksLikeInvestidoresDirect(text: string): boolean {
  const q = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!q.trim()) return false;
  if (/rendiment|lucro da locadora|faturamento/.test(q)) return false;
  if (/\b(agendar|marcar|marque|compromisso|reuniao|me lembra|lembrete)\b/.test(q)) {
    return false;
  }
  return /investidor/.test(q);
}

/** “Como está minha locadora hoje” é o painel de números, sem manual. */
function looksLikeLocadoraStatusDirect(text: string): boolean {
  const q = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!q.trim()) return false;
  if (/\b(me lembra|me lembre|lembrete|me avisa)\b/.test(q)) return false;
  if (
    /o que (voce|o assessor|vc|tu)|ajuda (com |da |na )?(locadora|frota)|capacidades|pode fazer|tenho integracao|esta ligada|ta ligada/.test(
      q
    )
  ) {
    return false;
  }
  if (/como (esta|anda|ta|vai) (a |minha )?(locadora|frota)\b/.test(q)) return true;
  if (/como (a |minha )?(locadora|frota) (esta|anda|ta|vai)\b/.test(q)) return true;
  if (/\bstatus (da |de )?(minha )?(locadora|frota)\b/.test(q)) return true;
  return false;
}

/** IoT / carrinhos / TAGs — atalho sem LLM (evita “rota” virar compromisso). */
function looksLikeIotQuestion(text: string): boolean {
  const q = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!q.trim()) return false;
  if (/\b(anotar|anota|agendar|marcar|marque|compromisso|lembrete|reuniao|ligar)\b/.test(q)) {
    return false;
  }
  if (/^\d{1,2}h\d{0,2}\b/.test(q)) return false;
  if (
    /\b(carrinho|carrinhos|iot|tagbrgps|findtag|brgps|brtag|airtag|geocerca|supermercado)\b/.test(
      q
    )
  ) {
    return true;
  }
  if (/\btags?\b/.test(q) && !/\btag\s+do\s+carro\b/.test(q)) return true;
  if (/fora (da |de )?(loja|unidade|base|cerca)/.test(q)) return true;
  if (/por unidade|por loja|quantos carrinho/.test(q)) return true;
  if (
    /(rota|recolha|rorta|rotaia)/.test(q) &&
    /(tag|carrinho|fora|loja|unidade)/.test(q)
  ) {
    return true;
  }
  if (
    /(excel|xlsx|planilha|relatorio)/.test(q) &&
    /(tag|carrinho|fora|iot)/.test(q)
  ) {
    return true;
  }
  return false;
}

async function runToolDirect(
  toolResults: Array<{ name: string; result: ToolHandlerResult }>,
  toolCtx: ToolContext,
  name: string,
  args: Record<string, unknown>
) {
  const tool = getTool(name);
  if (!tool) {
    toolResults.push({
      name,
      result: {
        ok: false,
        summary: `Ferramenta ${name} indisponível.`,
        errorCode: "unknown_tool",
      },
    });
    return;
  }
  try {
    const result = await tool.handler(toolCtx, args);
    toolResults.push({ name, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("tool_direct_failed", { tool: name, error: message });
    toolResults.push({
      name,
      result: {
        ok: false,
        summary: looksLikeCodeLeak(message) ? "" : message,
        errorCode: "exception",
      },
    });
  }
}

const PERSONAL_LIST_TOOLS =
  /^(list_reminders|list_appointments|list_tasks|week_ahead|daily_briefing)$/;
const LOCADORA_TOOLS =
  /^(query_locadora|locadora_snapshot|check_locadora_integration)$/;

/** Agenda pessoal e locadora no mesmo turno: mostra as duas, pessoal primeiro. */
export function mergeStructuredToolResults<
  T extends { name: string }
>(structured: T[]): T[] {
  const locadora = structured.filter((t) => LOCADORA_TOOLS.test(t.name));
  const personal = structured.filter((t) => PERSONAL_LIST_TOOLS.test(t.name));
  if (locadora.length && personal.length) return [...personal, ...locadora];
  if (locadora.length) return locadora;
  return structured;
}

function buildNaturalReply(
  toolResults: Array<{ name: string; result: ToolHandlerResult }>,
  modelContent: string | null
): string {
  const oks = toolResults.filter((t) => t.result.ok);
  // Listagens / dados estruturados SEMPRE vencem paráfrase do modelo
  const listTools = [
    "list_reminders",
    "list_appointments",
    "list_tasks",
    "week_ahead",
    "daily_briefing",
    "list_expenses",
    "monthly_balance",
    "spending_insight",
    "generate_report_pdf",
    "export_agenda_ics",
    "export_expenses_sheet",
    "complete_reminder",
    "query_locadora",
    "locadora_snapshot",
    "check_locadora_integration",
    "query_escritorio",
    "check_escritorio_integration",
    // Google: summary com link curto — nunca deixar o modelo colar URL OAuth longa
    "connect_google",
    "google_status",
    "sync_google_calendar",
    "sync_google_sheets",
    "disconnect_google",
  ];
  const structuredNames = new Set(listTools);
  const structured = oks.filter((t) => structuredNames.has(t.name));
  if (structured.length) {
    const pick = mergeStructuredToolResults(structured);
    // Media tools may return empty summary (caption already on the file).
    const remindersListed = pick.some((t) => t.name === "list_reminders");
    const parts = pick
      .filter((t) => {
        if (remindersListed && t.name === "list_appointments") return false;
        return true;
      })
      .map((t) => String(t.result.summary || "").trim())
      .filter(Boolean);
    return parts.filter((part, index) => part !== parts[index - 1]).join("\n\n");
  }

  if (modelContent && modelContent.trim()) return modelContent.trim();
  if (!oks.length) {
    const err = toolResults.find((t) => !t.result.ok);
    const summary = String(err?.result.summary || "");
    if (
      !summary ||
      err?.result.errorCode === "exception" ||
      looksLikeCodeLeak(summary)
    ) {
      return "";
    }
    return summary;
  }
  if (oks.length === 1) {
    const one = oks[0];
    if (
      one.name === "save_expense" ||
      one.name === "coach_spending" ||
      one.name === "resend_document_media" ||
      one.name === "web_research" ||
      one.name === "export_expenses_pdf" ||
      one.name === "connect_google" ||
      one.name === "google_status" ||
      one.name === "sync_google_calendar" ||
      one.name === "sync_google_sheets" ||
      one.name === "set_spending_goal" ||
      one.name === "check_spending_goal"
    ) {
      if (one.name === "web_research") {
        const body = String(one.result.summary || "").trim();
        return body
          ? `🔎 O que encontrei:\n${body}`
          : "Pesquisei, mas não trouxe resultado útil agora.";
      }
      return one.result.summary;
    }
    return one.result.summary
      .replace(/^Memória salva:\s*/i, "Anotei ✅: ")
      .replace(/^Lembrete criado:\s*/i, "Pronto ✅, te lembro: ");
  }
  return oks
    .map((t) => t.result.summary)
    .join(" ")
    .replace(/Memória salva:/gi, "Anotei ✅");
}

function executionKeyFor(
  jobId: string | undefined,
  name: string,
  args: Record<string, unknown>
) {
  const stable = JSON.stringify(args, Object.keys(args).sort());
  return createHash("sha256")
    .update(`${jobId || "noj"}:${name}:${stable}`)
    .digest("hex")
    .slice(0, 64);
}

export async function runAgentTurn(
  db: Db,
  input: {
    agentRunId: string;
    jobId?: string;
    userId: string;
    workspaceId: string;
    conversationId: string;
    userText: string;
    timezone: string;
    correlationId?: string;
    audioTranscriptHint?: string | null;
  }
): Promise<AgentRuntimeResult> {
  const started = Date.now();
  const ctxBuilt = await buildAgentContext(db, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    userText: input.userText,
    timezone: input.timezone,
  });

  // Atalho: dar baixa 1 / concluí o que passou / ainda não
  {
    const { parseBaixaIntent, applyBaixaIntent } = await import(
      "@/domain/reminder-baixa"
    );
    const intent = parseBaixaIntent(String(input.userText || ""));
    if (intent) {
      try {
        const reply = await applyBaixaIntent(db, {
          workspaceId: input.workspaceId,
          timezone: input.timezone,
          intent,
        });
        return {
          reply,
          toolResults: [],
          provider: "deterministic",
          model: "reminder-baixa",
          latencyMs: Date.now() - started,
          toolCount: 0,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "baixa_failed";
        logger.warn("baixa_intent_failed", { error: message });
        return {
          reply:
            "Não consegui dar baixa agora. Diga de novo *baixa 1* ou o nome, tipo *baixar Falar com Adan*.",
          toolResults: [],
          provider: "deterministic",
          model: "reminder-baixa",
          latencyMs: Date.now() - started,
          toolCount: 0,
        };
      }
    }
  }

  {
    const { parseDisplayNameChange, applyDisplayNameChange } = await import(
      "@/domain/display-name"
    );
    const nextName = parseDisplayNameChange(String(input.userText || ""));
    if (nextName && input.userId) {
      const reply = await applyDisplayNameChange(db, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        name: nextName,
      });
      return {
        reply,
        toolResults: [],
        provider: "deterministic",
        model: "display-name",
        latencyMs: Date.now() - started,
        toolCount: 0,
      };
    }
  }

  // Atalho determinístico: trocar/onde estou / escolha 1-N (sem LLM)
  if (ctxBuilt.phoneE164) {
    const {
      isContextSwitchIntent,
      matchBusinessChoice,
      resolveBusinessForPhone,
      setActiveBusinessContext,
      formatChooser,
      formatActiveStatus,
      CONTEXT_SWITCH_HINT,
      askedBusinessKind,
      businessChoiceList,
      dedupeBusinessOptions,
    } = await import("@/domain/business-context");
    const text = String(input.userText || "").trim();
    const biz = await resolveBusinessForPhone(db, ctxBuilt.phoneE164);

    if (isContextSwitchIntent(text)) {
      const matched = matchBusinessChoice(text, biz.options);
      if (matched) {
        await setActiveBusinessContext(db, ctxBuilt.phoneE164, matched);
        const world = matched.kind === "locadora" ? "Locadora" : "Facejus";
        return {
          reply: [
            `Pronto ✅ Assumi *${world} · ${matched.label}* (${matched.papel}).`,
            "Pessoal continua igual — gastos, lembretes e agenda sua não mudam.",
            "",
            CONTEXT_SWITCH_HINT,
          ].join("\n"),
          toolResults: [],
          provider: "deterministic",
          model: "business-context",
          latencyMs: Date.now() - started,
          toolCount: 0,
        };
      }
      return {
        reply: formatActiveStatus(biz.active, biz.options),
        toolResults: [],
        provider: "deterministic",
        model: "business-context",
        latencyMs: Date.now() - started,
        toolCount: 0,
      };
    }

    if (biz.needsChoice && biz.options.length > 1) {
      const { isPersonalLifeCommand, isBusinessWorldCommand } = await import(
        "@/domain/command-world"
      );
      if (isPersonalLifeCommand(text)) {
        // Agenda, lembrete e gasto não pedem empresa.
      } else {
        const { isLocadoraDraftConfirm } = await import("@/domain/locadora-draft");
        const lastAssistant = [...(ctxBuilt.recentMessages || [])]
          .reverse()
          .find((m) => m.role === "assistant");
        const answeringLocadora = isLocadoraDraftConfirm(
          text,
          String(lastAssistant?.content || "")
        );
        const matched = answeringLocadora
          ? null
          : matchBusinessChoice(text, biz.options);
        if (matched) {
          await setActiveBusinessContext(db, ctxBuilt.phoneE164, matched);
          const world = matched.kind === "locadora" ? "Locadora" : "Facejus";
          return {
            reply: [
              `Pronto ✅ Assumi *${world} · ${matched.label}* (${matched.papel}).`,
              "Pessoal continua igual.",
              "",
              CONTEXT_SWITCH_HINT,
            ].join("\n"),
            toolResults: [],
            provider: "deterministic",
            model: "business-context",
            latencyMs: Date.now() - started,
            toolCount: 0,
          };
        }
        if (isBusinessWorldCommand(text)) {
          const choice = businessChoiceList(text, biz.options);
          if (choice) {
            return {
              reply: formatChooser(choice),
              toolResults: [],
              provider: "deterministic",
              model: "business-context",
              latencyMs: Date.now() - started,
              toolCount: 0,
            };
          }
          const asked = askedBusinessKind(text);
          const one = dedupeBusinessOptions(
            biz.options.filter((option) => !asked || option.kind === asked)
          )[0];
          if (
            one &&
            (biz.active?.kind !== one.kind || biz.active?.tenantId !== one.tenantId)
          ) {
            await setActiveBusinessContext(db, ctxBuilt.phoneE164, one);
          }
        }
      }
    }

    // Agenda/compromisso/lembrete = SEMPRE pessoal.
    // Jurídico só com frase explícita (agenda jurídica / OAB / atendimentos Facejus) → heuristic/LLM.
  }

  const system = buildSystemPrompt({
    ...ctxBuilt,
    audioTranscriptHint: input.audioTranscriptHint || null,
  });
  const tools = toolDefinitionsForLlm();

  const messages: ChatMessage[] = [
    ...ctxBuilt.recentMessages
      .filter((m) => m.content)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: input.userText },
  ];

  const toolResults: Array<{ name: string; result: ToolHandlerResult }> = [];

  const toolCtx: ToolContext = {
    db,
    userId: input.userId,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    agentRunId: input.agentRunId,
    correlationId: input.correlationId,
    timezone: input.timezone,
    userText: input.userText,
    relatedDocumentId: ctxBuilt.relatedDocumentId,
  };

  const { isPersonalLifeCommand } = await import("@/domain/command-world");
  const { classifyTurnAct } = await import("@/domain/turn-act");
  const personalLife = isPersonalLifeCommand(input.userText);
  const turnAct = classifyTurnAct(input.userText);

  // Rendimento e calendário da locadora: o modelo troca um pelo outro.
  if (!personalLife && looksLikeLocadoraMoneyDirect(input.userText)) {
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(ctxBuilt.phoneE164)) {
      return {
        reply: PERSONAL_FOCUS_REPLY,
        toolResults: [],
        provider: "deterministic",
        model: "personal-focus",
        latencyMs: Date.now() - started,
        toolCount: 0,
      };
    }
    await runToolDirect(toolResults, toolCtx, "query_locadora", {
      question: String(input.userText || "").trim(),
    });
    const reply = buildNaturalReply(toolResults, null);
    await incrementUsage(db, {
      workspaceId: input.workspaceId,
      metric: "messages",
    });
    return {
      reply,
      toolResults,
      provider: "deterministic",
      model: "locadora-money-direct",
      latencyMs: Date.now() - started,
      toolCount: toolResults.length,
    };
  }

  if (!personalLife && looksLikeInvestidoresDirect(input.userText)) {
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(ctxBuilt.phoneE164)) {
      return {
        reply: PERSONAL_FOCUS_REPLY,
        toolResults: [],
        provider: "deterministic",
        model: "personal-focus",
        latencyMs: Date.now() - started,
        toolCount: 0,
      };
    }
    await runToolDirect(toolResults, toolCtx, "query_locadora", {
      question: String(input.userText || "").trim() || "investidores da locadora",
    });
    const reply = buildNaturalReply(toolResults, null);
    await incrementUsage(db, {
      workspaceId: input.workspaceId,
      metric: "messages",
    });
    return {
      reply,
      toolResults,
      provider: "deterministic",
      model: "locadora-investidores-direct",
      latencyMs: Date.now() - started,
      toolCount: toolResults.length,
    };
  }

  if (!personalLife && looksLikeVeiculosDirect(input.userText)) {
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(ctxBuilt.phoneE164)) {
      return {
        reply: PERSONAL_FOCUS_REPLY,
        toolResults: [],
        provider: "deterministic",
        model: "personal-focus",
        latencyMs: Date.now() - started,
        toolCount: 0,
      };
    }
    await runToolDirect(toolResults, toolCtx, "query_locadora", {
      question: String(input.userText || "").trim() || "veículos da locadora",
    });
    const reply = buildNaturalReply(toolResults, null);
    await incrementUsage(db, {
      workspaceId: input.workspaceId,
      metric: "messages",
    });
    return {
      reply,
      toolResults,
      provider: "deterministic",
      model: "locadora-veiculos-direct",
      latencyMs: Date.now() - started,
      toolCount: toolResults.length,
    };
  }

  if (!personalLife && looksLikeLocatariosDirect(input.userText)) {
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(ctxBuilt.phoneE164)) {
      return {
        reply: PERSONAL_FOCUS_REPLY,
        toolResults: [],
        provider: "deterministic",
        model: "personal-focus",
        latencyMs: Date.now() - started,
        toolCount: 0,
      };
    }
    await runToolDirect(toolResults, toolCtx, "query_locadora", {
      question: String(input.userText || "").trim() || "locatários da locadora",
    });
    const reply = buildNaturalReply(toolResults, null);
    await incrementUsage(db, {
      workspaceId: input.workspaceId,
      metric: "messages",
    });
    return {
      reply,
      toolResults,
      provider: "deterministic",
      model: "locadora-locatarios-direct",
      latencyMs: Date.now() - started,
      toolCount: toolResults.length,
    };
  }

  // Status da locadora: números primeiro. O manual só em “ajuda locadora”.
  if (!personalLife && looksLikeLocadoraStatusDirect(input.userText)) {
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(ctxBuilt.phoneE164)) {
      return {
        reply: PERSONAL_FOCUS_REPLY,
        toolResults: [],
        provider: "deterministic",
        model: "personal-focus",
        latencyMs: Date.now() - started,
        toolCount: 0,
      };
    }
    await runToolDirect(toolResults, toolCtx, "query_locadora", {
      question: "resumo da locadora",
    });
    const reply = buildNaturalReply(toolResults, null);
    await incrementUsage(db, {
      workspaceId: input.workspaceId,
      metric: "messages",
    });
    return {
      reply,
      toolResults,
      provider: "deterministic",
      model: "locadora-status-direct",
      latencyMs: Date.now() - started,
      toolCount: toolResults.length,
    };
  }

  // Ação da locadora (vistoria numerada, agendar, sim do rascunho) vai inteira ao Finance.
  {
    const { isLocadoraAcaoPhrase, isLocadoraInclusaoPhrase } = await import(
      "@/domain/locadora-intent"
    );
    const { isLocadoraDraftConfirm } = await import("@/domain/locadora-draft");
    const lastAssistant = [...(ctxBuilt.recentMessages || [])]
      .reverse()
      .find((m) => m.role === "assistant");
    const confirmaRascunho = isLocadoraDraftConfirm(
      input.userText,
      String(lastAssistant?.content || "")
    );
    if (
      !personalLife &&
      ((typeof isLocadoraAcaoPhrase === "function" &&
        isLocadoraAcaoPhrase(input.userText)) ||
        (typeof isLocadoraInclusaoPhrase === "function" &&
          isLocadoraInclusaoPhrase(input.userText)) ||
        confirmaRascunho)
    ) {
      const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
        "@/domain/personal-focus"
      );
      if (isPersonalFocusPhone(ctxBuilt.phoneE164)) {
        return {
          reply: PERSONAL_FOCUS_REPLY,
          toolResults: [],
          provider: "deterministic",
          model: "personal-focus",
          latencyMs: Date.now() - started,
          toolCount: 0,
        };
      }
      await runToolDirect(toolResults, toolCtx, "query_locadora", {
        question: String(input.userText || "").trim(),
      });
      const reply = buildNaturalReply(toolResults, null);
      const broke = toolResults.some(
        (item) =>
          item.result.errorCode === "exception" ||
          looksLikeCodeLeak(String(item.result.summary || "")) ||
          looksLikeCodeLeak(reply)
      );
      if (!broke && reply.trim()) {
        await incrementUsage(db, {
          workspaceId: input.workspaceId,
          metric: "messages",
        });
        return {
          reply,
          toolResults,
          provider: "deterministic",
          model: "locadora-acao-direct",
          latencyMs: Date.now() - started,
          toolCount: toolResults.length,
        };
      }
      toolResults.splice(0, toolResults.length);
    }
  }

  // IoT: pula o LLM — texto estruturado do Finance, sem paráfrase / agenda errada
  // (números em personal-focus ignoram locadora/IoT)
  if (!personalLife && looksLikeIotQuestion(input.userText)) {
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(ctxBuilt.phoneE164)) {
      return {
        reply: PERSONAL_FOCUS_REPLY,
        toolResults: [],
        provider: "deterministic",
        model: "personal-focus",
        latencyMs: Date.now() - started,
        toolCount: 0,
      };
    }
    await runToolDirect(toolResults, toolCtx, "query_locadora", {
      question: String(input.userText || "").trim(),
    });
    const reply = buildNaturalReply(toolResults, null);
    await incrementUsage(db, {
      workspaceId: input.workspaceId,
      metric: "messages",
    });
    return {
      reply,
      toolResults,
      provider: "deterministic",
      model: "iot-direct",
      latencyMs: Date.now() - started,
      toolCount: toolResults.length,
    };
  }

  // Facejus: atendimento e prazos processuais, cada um com a própria frase.
  // Não passa pelo modelo, para não cair na agenda pessoal nem misturar as duas.
  {
    const { facejusAgendaKind, facejusAgendaQuestion } = await import(
      "@/domain/facejus-commands"
    );
    const agendaKind = facejusAgendaKind(input.userText);
    if (agendaKind) {
      const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
        "@/domain/personal-focus"
      );
      if (ctxBuilt.phoneE164 && isPersonalFocusPhone(ctxBuilt.phoneE164)) {
        return {
          reply: PERSONAL_FOCUS_REPLY,
          toolResults: [],
          provider: "deterministic",
          model: "personal-focus",
          latencyMs: Date.now() - started,
          toolCount: 0,
        };
      }
      await runToolDirect(toolResults, toolCtx, "query_escritorio", {
        question: facejusAgendaQuestion(input.userText, agendaKind),
      });
      const reply = buildNaturalReply(toolResults, null);
      await incrementUsage(db, {
        workspaceId: input.workspaceId,
        metric: "messages",
      });
      return {
        reply,
        toolResults,
        provider: "deterministic",
        model: "facejus-agenda",
        latencyMs: Date.now() - started,
        toolCount: toolResults.length,
      };
    }
  }

  // Gravar compromisso/lembrete ANTES de recado, rota, livre ou empresa.
  {
    const { buildCreateReminderArgs, looksLikeReminderCreate } = await import(
      "@/domain/reminder-intent"
    );
    const { buildCreateAppointmentArgs, looksLikeAppointmentCreate } =
      await import("@/domain/appointment-intent");
    const { hasExplicitClockTime, suggestReminderHour } = await import(
      "@/lib/datetime"
    );
    if (looksLikeReminderCreate(input.userText) || turnAct === "registrar_pessoal") {
      if (
        looksLikeReminderCreate(input.userText) &&
        !hasExplicitClockTime(input.userText) &&
        !/dias? antes|todo m[eê]s|boleto|conta de|fatura/i.test(input.userText)
      ) {
        const title =
          input.userText
            .replace(/^.*?\b(me lembra|me lembre|lembrar)\b/i, "")
            .trim() || "Lembrete";
        const sug = suggestReminderHour(title + " " + input.userText);
        return {
          reply: `Que horário te lembro de *${title.slice(0, 80)}*? Posso deixar às ${sug}h se preferir.`,
          toolResults: [],
          provider: "deterministic",
          model: "reminder-ask-time",
          latencyMs: Date.now() - started,
          toolCount: 0,
        };
      }
      const reminderArgs = looksLikeReminderCreate(input.userText)
        ? buildCreateReminderArgs(input.userText, input.timezone)
        : null;
      if (reminderArgs) {
        await runToolDirect(toolResults, toolCtx, "create_reminder", reminderArgs);
        const reply = buildNaturalReply(toolResults, null);
        await incrementUsage(db, {
          workspaceId: input.workspaceId,
          metric: "messages",
        });
        return {
          reply,
          toolResults,
          provider: "deterministic",
          model: "reminder-direct",
          latencyMs: Date.now() - started,
          toolCount: toolResults.length,
        };
      }
      const apptArgs = buildCreateAppointmentArgs(input.userText, input.timezone);
      if (apptArgs) {
        await runToolDirect(toolResults, toolCtx, "create_appointment", apptArgs);
        const reply = buildNaturalReply(toolResults, null);
        await incrementUsage(db, {
          workspaceId: input.workspaceId,
          metric: "messages",
        });
        return {
          reply,
          toolResults,
          provider: "deterministic",
          model: "appointment-direct",
          latencyMs: Date.now() - started,
          toolCount: toolResults.length,
        };
      }
    }
    if (looksLikeAppointmentCreate(input.userText)) {
      const args = buildCreateAppointmentArgs(input.userText, input.timezone);
      if (args) {
        await runToolDirect(toolResults, toolCtx, "create_appointment", args);
        const reply = buildNaturalReply(toolResults, null);
        await incrementUsage(db, {
          workspaceId: input.workspaceId,
          metric: "messages",
        });
        return {
          reply,
          toolResults,
          provider: "deterministic",
          model: "appointment-direct",
          latencyMs: Date.now() - started,
          toolCount: toolResults.length,
        };
      }
    }
  }

  // Lembrete com horário: NUNCA confiar só no LLM (ele confirma sem gravar)
  const { mentionsOtherPeople, routeDeskTurn } = await import("@/domain/desk-router");
  const routed = mentionsOtherPeople(input.userText);
  {
    const deskReply = await routeDeskTurn(db, {
      userId: input.userId,
      text: input.userText,
      timezone: input.timezone,
      toolCtx,
    });
    if (deskReply) {
      await incrementUsage(db, {
        workspaceId: input.workspaceId,
        metric: "messages",
      });
      return {
        reply: deskReply,
        toolResults,
        provider: "deterministic",
        model: "desk-router",
        latencyMs: Date.now() - started,
        toolCount: toolResults.length,
      };
    }
  }
  {
    const { looksLikeCalendarSync, looksLikeDayList } = await import("@/domain/desk-router");
    if (looksLikeCalendarSync(input.userText)) {
      await runToolDirect(toolResults, toolCtx, "sync_google_calendar", {});
      const reply =
        toolResults.map((item) => String(item.result.summary || "").trim()).filter(Boolean).pop() ||
        "Não consegui sincronizar a agenda agora.";
      await incrementUsage(db, {
        workspaceId: input.workspaceId,
        metric: "messages",
      });
      return {
        reply,
        toolResults,
        provider: "deterministic",
        model: "google-sync",
        latencyMs: Date.now() - started,
        toolCount: toolResults.length,
      };
    }
    {
      const { answerPersonalIou } = await import("@/domain/personal-iou");
      const iou = await answerPersonalIou(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        text: input.userText,
        timezone: input.timezone,
      });
      if (iou) {
        await incrementUsage(db, { workspaceId: input.workspaceId, metric: "messages" });
        return {
          reply: iou,
          toolResults,
          provider: "deterministic",
          model: "personal-iou",
          latencyMs: Date.now() - started,
          toolCount: 0,
        };
      }
    }
    {
      const { answerRecurringMoney } = await import("@/domain/recurring-money");
      const money = await answerRecurringMoney(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        text: input.userText,
        timezone: input.timezone,
        toolCtx,
      });
      if (money) {
        await incrementUsage(db, { workspaceId: input.workspaceId, metric: "messages" });
        return {
          reply: money,
          toolResults,
          provider: "deterministic",
          model: "recurring-money",
          latencyMs: Date.now() - started,
          toolCount: 0,
        };
      }
    }
    {
      const { answerMeetingNotes } = await import("@/domain/meeting-notes");
      const ata = await answerMeetingNotes(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        text: input.userText,
      });
      if (ata) {
        await incrementUsage(db, { workspaceId: input.workspaceId, metric: "messages" });
        return {
          reply: ata,
          toolResults,
          provider: "deterministic",
          model: "meeting-notes",
          latencyMs: Date.now() - started,
          toolCount: 0,
        };
      }
    }
    {
      const { answerPublicSlotAsk, looksLikeTaskReport } = await import("@/domain/public-slots");
      const livre = await answerPublicSlotAsk(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        text: input.userText,
        timezone: input.timezone,
      });
      if (livre) {
        await incrementUsage(db, { workspaceId: input.workspaceId, metric: "messages" });
        return {
          reply: livre,
          toolResults,
          provider: "deterministic",
          model: "public-slots",
          latencyMs: Date.now() - started,
          toolCount: 0,
        };
      }
      {
        const { answerSpendAnomaly } = await import("@/domain/spend-anomaly");
        const odd = await answerSpendAnomaly(db, {
          workspaceId: input.workspaceId,
          timezone: input.timezone,
          text: input.userText,
        });
        if (odd) {
          await incrementUsage(db, { workspaceId: input.workspaceId, metric: "messages" });
          return {
            reply: odd,
            toolResults,
            provider: "deterministic",
            model: "spend-anomaly",
            latencyMs: Date.now() - started,
            toolCount: 0,
          };
        }
      }
      {
        const { answerDocFolder } = await import("@/domain/doc-folders");
        const docs = await answerDocFolder(db, {
          workspaceId: input.workspaceId,
          text: input.userText,
          timezone: input.timezone,
        });
        if (docs) {
          await incrementUsage(db, { workspaceId: input.workspaceId, metric: "messages" });
          return {
            reply: docs,
            toolResults,
            provider: "deterministic",
            model: "doc-folders",
            latencyMs: Date.now() - started,
            toolCount: 0,
          };
        }
      }
      {
        const { answerTaskProjects } = await import("@/domain/task-projects");
        const task = await answerTaskProjects(db, {
          workspaceId: input.workspaceId,
          userId: input.userId,
          text: input.userText,
          timezone: input.timezone,
        });
        if (task) {
          await incrementUsage(db, { workspaceId: input.workspaceId, metric: "messages" });
          return {
            reply: task,
            toolResults,
            provider: "deterministic",
            model: "task-projects",
            latencyMs: Date.now() - started,
            toolCount: 0,
          };
        }
      }
      if (looksLikeTaskReport(input.userText)) {
        await runToolDirect(toolResults, toolCtx, "generate_report_pdf", { kind: "tarefas" });
        const reply =
          toolResults.map((item) => String(item.result.summary || "").trim()).filter(Boolean).pop() ||
          "Não consegui montar o relatório de tarefas.";
        await incrementUsage(db, { workspaceId: input.workspaceId, metric: "messages" });
        return {
          reply,
          toolResults,
          provider: "deterministic",
          model: "task-report",
          latencyMs: Date.now() - started,
          toolCount: toolResults.length,
        };
      }
    }
    if (looksLikeDayList(input.userText)) {
      const { parseNaturalDateTime } = await import("@/lib/datetime");
      const when =
        parseNaturalDateTime(input.userText, input.timezone) ||
        parseNaturalDateTime("hoje", input.timezone);
      await runToolDirect(toolResults, toolCtx, "list_reminders", {
        ...(when?.toISODate() ? { date_iso: when.toISODate() } : {}),
        timezone: input.timezone,
      });
      const reply =
        toolResults.map((item) => String(item.result.summary || "").trim()).filter(Boolean).pop() ||
        "Não consegui ver a agenda agora.";
      await incrementUsage(db, {
        workspaceId: input.workspaceId,
        metric: "messages",
      });
      return {
        reply,
        toolResults,
        provider: "deterministic",
        model: "day-list",
        latencyMs: Date.now() - started,
        toolCount: toolResults.length,
      };
    }
  }
  {
    const { answerAgendaGap } = await import("@/domain/agenda-gaps");
    if (turnAct === "registrar_pessoal" || turnAct === "listar_dia") {
      // Horário livre não rouba compromisso nem lista do dia.
    } else {
    const agendaReply = await answerAgendaGap(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      text: input.userText,
      timezone: input.timezone,
    });
    if (agendaReply) {
      await incrementUsage(db, {
        workspaceId: input.workspaceId,
        metric: "messages",
      });
      return {
        reply: agendaReply,
        toolResults,
        provider: "deterministic",
        model: "agenda-gaps",
        latencyMs: Date.now() - started,
        toolCount: 0,
      };
    }
    }
  }
  {
    const {
      findNewestReceipt,
      looksLikeSpend,
      looksLikeUndo,
      looksLikeValueFix,
    } = await import("@/domain/receipt-undo");
    const spend = looksLikeSpend(input.userText);
    const undo = spend ? null : looksLikeUndo(input.userText);
    const fix = spend || undo ? null : looksLikeValueFix(input.userText);
    if (spend || undo || fix) {
      if (spend) {
        await runToolDirect(toolResults, toolCtx, "save_expense", {
          amount: spend.amount,
          category: spend.category,
          merchant: spend.label,
          note: spend.label,
        });
        const saved = toolResults.find((item) => item.name === "save_expense" && item.result.ok);
        if (saved) {
          const alert = await checkSpendingLimitAlert(toolCtx);
          if (alert) saved.result.summary = `${saved.result.summary}\n\n${alert}`;
          try {
            const { detectSpendAnomaly } = await import("@/domain/spend-anomaly");
            const odd = await detectSpendAnomaly(db, {
              workspaceId: input.workspaceId,
              timezone: input.timezone,
            });
            if (odd) saved.result.summary = `${saved.result.summary}\n${odd}`;
          } catch {
            /* best-effort */
          }
          try {
            const { syncWorkspaceToGoogleSheets } = await import(
              "@/integrations/google/sheets"
            );
            const sheet = await syncWorkspaceToGoogleSheets(db, {
              workspaceId: input.workspaceId,
              timezone: input.timezone,
            });
            if (sheet.ok && !sheet.mock && sheet.rows > 0) {
              saved.result.summary = `${saved.result.summary}\n📊 Planilha Google atualizada.`;
            }
          } catch {
            /* best-effort */
          }
        }
      } else if (undo) {
        const hit = await findNewestReceipt(db, input.workspaceId, undo.phrase);
        if (!hit) {
          toolResults.push({
            name: "undo_last_expense",
            result: {
              ok: false,
              summary: undo.phrase
                ? `Não achei *${undo.phrase}* nas últimas 24h.`
                : "Não achei nada das últimas 24h para desfazer.",
            },
          });
        } else if (hit.kind === "expense") {
          await runToolDirect(toolResults, toolCtx, "undo_last_expense", {
            expense_id: hit.id,
          });
        } else if (hit.kind === "income") {
          await runToolDirect(toolResults, toolCtx, "undo_last_income", {
            income_id: hit.id,
          });
        } else if (hit.kind === "appointment") {
          await runToolDirect(toolResults, toolCtx, "undo_last_appointment", {
            appointment_id: hit.id,
          });
        } else {
          await runToolDirect(toolResults, toolCtx, "undo_last_reminder", {
            reminder_id: hit.id,
          });
        }
      } else if (fix) {
        const hit = await findNewestReceipt(db, input.workspaceId, fix.phrase, [
          "expense",
          "income",
        ]);
        if (!hit) {
          toolResults.push({
            name: "update_expense",
            result: {
              ok: false,
              summary: fix.phrase
                ? `Não achei *${fix.phrase}* nas últimas 24h.`
                : "Não achei nada das últimas 24h para corrigir.",
            },
          });
        } else if (hit.kind === "income") {
          await runToolDirect(toolResults, toolCtx, "update_income", {
            income_id: hit.id,
            amount: fix.amount,
          });
        } else {
          await runToolDirect(toolResults, toolCtx, "update_expense", {
            expense_id: hit.id,
            amount: fix.amount,
          });
        }
      }
      const receiptReply = scrubFakeValueHint(
        [...toolResults]
          .reverse()
          .map((item) => String(item.result.summary || "").trim())
          .find(Boolean) || "Não consegui concluir."
      );
      await incrementUsage(db, {
        workspaceId: input.workspaceId,
        metric: "messages",
      });
      return {
        reply: receiptReply,
        toolResults,
        provider: "deterministic",
        model: "receipt-24h",
        latencyMs: Date.now() - started,
        toolCount: toolResults.length,
      };
    }
  }
  {
    const { answerGoogleInvite } = await import("@/integrations/google/rsvp");
    const googleReply = await answerGoogleInvite(db, {
      workspaceId: input.workspaceId,
      text: input.userText,
      timezone: input.timezone,
    });
    if (googleReply) {
      await incrementUsage(db, {
        workspaceId: input.workspaceId,
        metric: "messages",
      });
      return {
        reply: googleReply,
        toolResults,
        provider: "deterministic",
        model: "google-rsvp",
        latencyMs: Date.now() - started,
        toolCount: 0,
      };
    }
    const { answerInvitePull } = await import("@/integrations/google/gmail-invites");
    const invitePull = await answerInvitePull(db, {
      workspaceId: input.workspaceId,
      timezone: input.timezone,
      text: input.userText,
    });
    if (invitePull) {
      await incrementUsage(db, { workspaceId: input.workspaceId, metric: "messages" });
      return {
        reply: invitePull,
        toolResults,
        provider: "deterministic",
        model: "gmail-invites",
        latencyMs: Date.now() - started,
        toolCount: 0,
      };
    }
  }
  {
    const { buildCreateReminderArgs, looksLikeReminderCreate } = await import(
      "@/domain/reminder-intent"
    );
    const { hasExplicitClockTime, suggestReminderHour } = await import(
      "@/lib/datetime"
    );
    if (looksLikeReminderCreate(input.userText) && !routed) {
      if (
        !hasExplicitClockTime(input.userText) &&
        !/dias? antes|todo m[eê]s|boleto|conta de|fatura/i.test(input.userText)
      ) {
        const title =
          input.userText
            .replace(/^.*?\b(me lembra|me lembre|lembrar)\b/i, "")
            .trim() || "Lembrete";
        const sug = suggestReminderHour(title + " " + input.userText);
        return {
          reply: `Que horário te lembro de *${title.slice(0, 80)}*? Posso deixar às ${sug}h se preferir.`,
          toolResults: [],
          provider: "deterministic",
          model: "reminder-ask-time",
          latencyMs: Date.now() - started,
          toolCount: 0,
        };
      }
      const args = buildCreateReminderArgs(input.userText, input.timezone);
      if (args) {
        await runToolDirect(toolResults, toolCtx, "create_reminder", args);
        const reply = buildNaturalReply(toolResults, null);
        await incrementUsage(db, {
          workspaceId: input.workspaceId,
          metric: "messages",
        });
        return {
          reply,
          toolResults,
          provider: "deterministic",
          model: "reminder-direct",
          latencyMs: Date.now() - started,
          toolCount: toolResults.length,
        };
      }
    }
  }

  // Compromisso com horário: mesma garantia anti-phantom do lembrete
  {
    const { buildCreateAppointmentArgs, looksLikeAppointmentCreate } =
      await import("@/domain/appointment-intent");
    if (looksLikeAppointmentCreate(input.userText) && !routed) {
      const args = buildCreateAppointmentArgs(input.userText, input.timezone);
      if (args) {
        await runToolDirect(toolResults, toolCtx, "create_appointment", args);
        const reply = buildNaturalReply(toolResults, null);
        await incrementUsage(db, {
          workspaceId: input.workspaceId,
          metric: "messages",
        });
        return {
          reply,
          toolResults,
          provider: "deterministic",
          model: "appointment-direct",
          latencyMs: Date.now() - started,
          toolCount: toolResults.length,
        };
      }
    }
  }

  const llm = await resolveLanguageModelProvider(db, input.timezone);
  let completion;
  try {
    completion = await llm.complete({
      system,
      messages,
      tools,
      model: routed ? "gpt-4o" : undefined,
    });
  } catch (err) {
    if (!routed) throw err;
    logger.warn("router_model_fallback", {
      error: err instanceof Error ? err.message.slice(0, 160) : "llm_failed",
    });
    completion = await llm.complete({ system, messages, tools });
  }

  async function executeOne(call: ToolCallRequest) {
    const startedAt = new Date();
    const policy = evaluateToolPolicy(call.name);
    const safeArgs = { ...call.arguments };
    delete safeArgs.workspace_id;
    delete safeArgs.workspaceId;
    delete safeArgs.user_id;
    delete safeArgs.userId;

    const executionKey = executionKeyFor(input.jobId, call.name, safeArgs);
    const prior = await db.query.toolCalls.findFirst({
      where: eq(toolCalls.executionKey, executionKey),
    });
    if (prior && prior.status === "succeeded") {
      toolResults.push({
        name: call.name,
        result: {
          ok: true,
          summary: prior.resultSummary || "Já executado.",
          data: { idempotent: true },
        },
      });
      return;
    }

    let audit;
    try {
      const [row] = await db
        .insert(toolCalls)
        .values({
          agentRunId: input.agentRunId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          toolName: call.name,
          policyDecision: policy,
          status:
            policy === "ALLOW"
              ? "allowed"
              : policy === "REQUIRE_CONFIRMATION"
                ? "awaiting_confirmation"
                : "denied",
          args: sanitizeArgs(safeArgs),
          executionKey,
          startedAt,
          correlationId: input.correlationId,
        })
        .returning();
      audit = row;
    } catch {
      const again = await db.query.toolCalls.findFirst({
        where: eq(toolCalls.executionKey, executionKey),
      });
      if (again?.status === "succeeded") {
        toolResults.push({
          name: call.name,
          result: {
            ok: true,
            summary: again.resultSummary || "Já executado.",
            data: { idempotent: true },
          },
        });
        return;
      }
      throw new Error("tool_execution_key_conflict");
    }

    if (policy !== "ALLOW") {
      const result: ToolHandlerResult = {
        ok: false,
        summary:
          policy === "REQUIRE_CONFIRMATION"
            ? "Essa ação precisa de confirmação."
            : "Ação não permitida.",
        errorCode: policy === "DENY" ? "policy_deny" : "policy_confirm",
      };
      await db
        .update(toolCalls)
        .set({
          status: "denied",
          resultSummary: result.summary,
          errorCode: result.errorCode,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(toolCalls.id, audit.id));
      toolResults.push({ name: call.name, result });
      return;
    }

    const tool = getTool(call.name);
    if (!tool) {
      const result: ToolHandlerResult = {
        ok: false,
        summary: "Tool desconhecida",
        errorCode: "unknown_tool",
      };
      await db
        .update(toolCalls)
        .set({
          status: "failed",
          error: result.summary,
          errorCode: result.errorCode,
          completedAt: new Date(),
        })
        .where(eq(toolCalls.id, audit.id));
      toolResults.push({ name: call.name, result });
      return;
    }

    try {
      const result = await tool.handler(toolCtx, safeArgs);
      await db
        .update(toolCalls)
        .set({
          status: result.ok ? "succeeded" : "failed",
          resultSummary: result.summary.slice(0, 2000),
          errorCode: result.errorCode || null,
          error: result.ok ? null : result.summary,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(toolCalls.id, audit.id));
      toolResults.push({ name: call.name, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "tool_failed";
      logger.error("tool_execution_failed", {
        tool_call_id: audit.id,
        error: message,
      });
      await db
        .update(toolCalls)
        .set({
          status: "failed",
          error: message,
          errorCode: "exception",
          completedAt: new Date(),
        })
        .where(eq(toolCalls.id, audit.id));
      toolResults.push({
        name: call.name,
        result: { ok: false, summary: message, errorCode: "exception" },
      });
    }
  }

  const maxTools = 8;
  const spendUtterance = looksLikeSpend(input.userText);
  for (const call of completion.toolCalls.slice(0, maxTools)) {
    if (
      spendUtterance &&
      (call.name === "create_reminder" || call.name === "create_appointment")
    ) {
      continue;
    }
    await executeOne(call);
  }

  // Rede de segurança: pedido de lembrete + modelo “confirmou” sem tool → grava de verdade
  {
    const {
      looksLikeReminderCreate,
      looksLikePhantomReminderConfirm,
      buildCreateReminderArgs,
    } = await import("@/domain/reminder-intent");
    const created = toolResults.some(
      (t) => t.name === "create_reminder" && t.result.ok
    );
    if (
      !created &&
      looksLikeReminderCreate(input.userText) &&
      (looksLikePhantomReminderConfirm(completion.content || "") ||
        !completion.toolCalls.length)
    ) {
      const args = buildCreateReminderArgs(input.userText, input.timezone);
      if (args) {
        logger.warn("phantom_reminder_confirm_blocked", {
          workspace_id: input.workspaceId,
          user_text: String(input.userText).slice(0, 160),
        });
        await runToolDirect(toolResults, toolCtx, "create_reminder", args);
      }
    }
  }

  // Rede de segurança: compromisso phantom → grava de verdade
  {
    const {
      looksLikeAppointmentCreate,
      looksLikePhantomAppointmentConfirm,
      buildCreateAppointmentArgs,
    } = await import("@/domain/appointment-intent");
    const created = toolResults.some(
      (t) => t.name === "create_appointment" && t.result.ok
    );
    if (
      !created &&
      looksLikeAppointmentCreate(input.userText) &&
      (looksLikePhantomAppointmentConfirm(completion.content || "") ||
        !completion.toolCalls.length)
    ) {
      const args = buildCreateAppointmentArgs(input.userText, input.timezone);
      if (args) {
        logger.warn("phantom_appointment_confirm_blocked", {
          workspace_id: input.workspaceId,
          user_text: String(input.userText).slice(0, 160),
        });
        await runToolDirect(toolResults, toolCtx, "create_appointment", args);
      }
    }
  }

  // Alerta de meta após registrar gasto + Sheets ao vivo
  for (const t of toolResults) {
    if (t.name === "save_expense" && t.result.ok) {
      const alert = await checkSpendingLimitAlert(toolCtx);
      if (alert) {
        t.result.summary = `${t.result.summary}\n\n${alert}`;
      }
      try {
        const { syncWorkspaceToGoogleSheets } = await import(
          "@/integrations/google/sheets"
        );
        const sheet = await syncWorkspaceToGoogleSheets(db, {
          workspaceId: input.workspaceId,
          timezone: input.timezone,
        });
        if (sheet.ok && !sheet.mock && sheet.rows > 0) {
          t.result.summary = `${t.result.summary}\n📊 Planilha Google atualizada.`;
        }
      } catch {
        /* best-effort */
      }
    }
  }

  let reply = buildNaturalReply(toolResults, completion.content);
  const reminderOks = toolResults.filter(
    (t) => t.name === "create_reminder" && t.result.ok
  );
  const appointmentOks = toolResults.filter(
    (t) => t.name === "create_appointment" && t.result.ok
  );
  // Se criamos lembrete/compromisso, a confirmação estruturada vence o blá-blá do modelo
  if (reminderOks.length >= 1 || appointmentOks.length >= 1) {
    reply = composeFriendlyMulti(toolResults);
  }
  const listOks = toolResults.filter(
    (t) =>
      t.result.ok &&
      /^(list_reminders|list_appointments|list_tasks|week_ahead|daily_briefing|get_weather|get_exchange_rate)$/.test(
        t.name
      )
  );
  const multiStructured =
    reminderOks.length >= 2 ||
    appointmentOks.length >= 2 ||
    listOks.length >= 1 ||
    toolResults.filter((t) => t.result.ok).length >= 2;

  if (
    reminderOks.length === 0 &&
    appointmentOks.length === 0 &&
    completion.toolCalls.length &&
    (!completion.content || multiStructured)
  ) {
    // Lista formatada vence parágrafo "E / Também" do modelo
    const locadoraOks = toolResults.filter(
      (t) =>
        t.result.ok &&
        /^(query_locadora|locadora_snapshot|check_locadora_integration)$/.test(
          t.name
        )
    );
    if (locadoraOks.length >= 1) {
      reply = locadoraOks.map((t) => t.result.summary).join("\n\n");
    } else if (listOks.length >= 1) {
      reply = listOks.map((t) => t.result.summary).join("\n\n");
    } else if (!completion.content) {
      reply = composeFriendlyMulti(toolResults);
    }
  } else if (reminderOks.length === 0 && appointmentOks.length === 0) {
    // Se o modelo respondeu sem colar os dados da pesquisa, anexa o summary
    const research = toolResults.find(
      (t) => t.name === "web_research" && t.result.ok && t.result.summary
    );
    if (research) {
      const body = String(research.result.summary);
      const replyLooksEmpty =
        !reply ||
        reply.length < 40 ||
        /montei o que encontrei|fiz a pesquisa|encontrei na pesquisa/i.test(reply);
      const alreadyHasData =
        body.length > 20 &&
        (reply.includes(body.slice(0, 40)) ||
          /https?:\/\//i.test(reply) ||
          /\n\s*1\./.test(reply));
      if (replyLooksEmpty || !alreadyHasData) {
        reply = replyLooksEmpty
          ? `🔎 O que encontrei:\n${body}`
          : `${reply.trim()}\n\n🔎 ${body}`;
      }
    }
  }

  await incrementUsage(db, {
    workspaceId: input.workspaceId,
    metric: "messages",
  });
  if (completion.inputTokens) {
    await incrementUsage(db, {
      workspaceId: input.workspaceId,
      metric: "input_tokens",
      amount: completion.inputTokens,
    });
  }
  if (completion.outputTokens) {
    await incrementUsage(db, {
      workspaceId: input.workspaceId,
      metric: "output_tokens",
      amount: completion.outputTokens,
    });
  }

  // Hard gate: nunca enviar “Pronto, te lembro” sem reminder no banco
  {
    const {
      looksLikeReminderCreate,
      looksLikePhantomReminderConfirm,
    } = await import("@/domain/reminder-intent");
    const createdOk = toolResults.some(
      (t) => t.name === "create_reminder" && t.result.ok
    );
    if (
      !createdOk &&
      looksLikeReminderCreate(input.userText) &&
      looksLikePhantomReminderConfirm(reply)
    ) {
      logger.error("phantom_reminder_reply_blocked", {
        workspace_id: input.workspaceId,
        reply: reply.slice(0, 160),
      });
      reply =
        "Não consegui *gravar* esse lembrete agora. Manda de novo com o horário (ex.: *amanhã às 9h*) que eu confirmo só depois de salvar.";
    }
  }

  // Hard gate: nunca confirmar compromisso sem INSERT
  {
    const {
      looksLikeAppointmentCreate,
      looksLikePhantomAppointmentConfirm,
    } = await import("@/domain/appointment-intent");
    const createdOk = toolResults.some(
      (t) => t.name === "create_appointment" && t.result.ok
    );
    if (
      !createdOk &&
      looksLikeAppointmentCreate(input.userText) &&
      looksLikePhantomAppointmentConfirm(reply)
    ) {
      logger.error("phantom_appointment_reply_blocked", {
        workspace_id: input.workspaceId,
        reply: reply.slice(0, 160),
      });
      reply =
        "Não consegui *gravar* esse compromisso agora. Manda de novo com o horário (ex.: *amanhã às 14h*) que eu confirmo só depois de salvar.";
    }
  }

  if (spendUtterance) {
    const expense = [...toolResults]
      .reverse()
      .find((item) => item.name === "save_expense" && item.result.ok);
    if (expense?.result.summary) reply = String(expense.result.summary);
  }
  reply = scrubFakeValueHint(reply);

  return {
    reply,
    toolResults,
    provider: completion.provider,
    model: completion.model,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    latencyMs: Date.now() - started,
    toolCount: toolResults.length,
  };
}

function sanitizeArgs(args: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (/secret|token|password|credential|api_key/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function composeFriendlyMulti(
  toolResults: Array<{ name: string; result: ToolHandlerResult }>
): string {
  const reminderItems: Array<{
    title: string;
    fireAt: Date;
    timezone: string;
    payload?: ReminderPayload | null;
  }> = [];
  const otherParts: string[] = [];

  for (const t of toolResults) {
    if (!t.result.ok) continue;

    if (t.name === "create_reminder") {
      const data = (t.result.data || {}) as {
        title?: string;
        fire_at?: string;
        timezone?: string;
        payload?: ReminderPayload;
      };
      const title =
        data.title ||
        t.result.summary.replace(/^[\s\S]*?\*([^*]+)\*.*/, "$1").trim() ||
        "Lembrete";
      const fireAt = data.fire_at ? new Date(data.fire_at) : null;
      if (fireAt && !Number.isNaN(fireAt.getTime())) {
        reminderItems.push({
          title,
          fireAt,
          timezone: data.timezone || "America/Sao_Paulo",
          payload: data.payload || null,
        });
        continue;
      }
      // fallback: usa summary já formatado como bullet
      otherParts.push(
        t.result.summary
          .replace(/^.*?Vou te lembrar:\s*/i, "• ")
          .replace(/^Lembrete criado:\s*/i, "• ")
      );
      continue;
    }

    if (t.name === "save_memory") {
      otherParts.push(
        t.result.summary.replace(/^Memória salva:\s*/i, "Anotei ✅ que ")
      );
    } else if (
      t.name === "save_expense" ||
      t.name === "list_expenses" ||
      t.name === "coach_spending" ||
      t.name === "export_expenses_sheet" ||
      t.name === "export_expenses_pdf" ||
      t.name === "export_agenda_ics" ||
      t.name === "week_ahead" ||
      t.name === "generate_report_pdf" ||
      t.name === "daily_briefing" ||
      t.name === "monthly_balance" ||
      t.name === "spending_insight" ||
      t.name === "connect_google" ||
      t.name === "google_status" ||
      t.name === "sync_google_calendar" ||
      t.name === "sync_google_sheets" ||
      t.name === "set_spending_goal" ||
      t.name === "check_spending_goal"
    ) {
      otherParts.push(t.result.summary);
    } else if (t.name === "resend_document_media") {
      otherParts.push(t.result.summary);
    } else if (t.name === "create_appointment") {
      otherParts.push(
        t.result.summary.replace(/^Compromisso agendado:\s*/i, "📅 Agendei: ")
      );
    } else if (t.name === "update_user_profile") {
      otherParts.push(
        t.result.summary.replace(/^Cadastro atualizado:\s*/i, "Atualizei ✅: ")
      );
    } else if (t.name === "web_research") {
      const body = String(t.result.summary || "").trim();
      otherParts.push(
        body
          ? `🔎 O que encontrei:\n${body}`
          : "Pesquisei, mas não trouxe resultado útil agora. Me dá cidade, data e destino que eu tento de novo."
      );
    } else if (t.name === "search_documents" || t.name === "summarize_document") {
      otherParts.push(t.result.summary);
    } else {
      otherParts.push(t.result.summary);
    }
  }

  const blocks: string[] = [];
  if (reminderItems.length) {
    blocks.push(formatReminderConfirmBlock(reminderItems));
  }
  if (otherParts.length) {
    blocks.push(otherParts.join("\n\n"));
  }
  if (!blocks.length) return "Não consegui concluir o pedido.";
  return blocks.join("\n\n");
}
