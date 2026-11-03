import { randomUUID } from "crypto";
import { DateTime } from "luxon";
import type {
  LanguageModelProvider,
  LanguageModelResult,
  ToolCallRequest,
} from "./types";
import { parseNaturalDateTime, hasExplicitClockTime, isBillStyleReminder, suggestReminderHour } from "@/lib/datetime";
import { isLocadoraAcaoPhrase } from "@/domain/locadora-phrases";
import { looksLikeSpend } from "@/domain/receipt-undo";
import { parseRecurrenceFromText } from "@/lib/recurrence";

function tool(
  name: string,
  args: Record<string, unknown>
): ToolCallRequest {
  return { id: `call_${randomUUID().slice(0, 8)}`, name, arguments: args };
}

function splitParts(text: string): string[] {
  return text
    .split(/[\n.]+|(?:\se\s(?=me lembra))|(?:\se\s(?=anota))|(?:\se\s(?=guarda))/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

/**
 * Deterministic Portuguese intent → tool calls for tests/dev without OpenAI.
 */
export function createHeuristicLanguageModelProvider(
  timezone = "America/Sao_Paulo"
): LanguageModelProvider {
  return {
    name: "heuristic",
    async complete({ messages }) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const text = (lastUser?.content || "").trim();
      const lower = text.toLowerCase();
      const toolCalls: ToolCallRequest[] = [];
      const parts = splitParts(text);
      let askTimeReply: string | null = null;

      const handlePart = (part: string) => {
        const p = part.toLowerCase();
        const escritorioQuery =
          /(escrit[oó]rio|facejus|meus processos|andamento do processo|processos? (do|da|de)|kpi|indicadores?|agenda jur[ií]dica|agenda oab|prazos? judiciais?|prazos? processua(?:l|is)|agenda de (atendimento|prazos|consultas)|atendimentos? (de|da|do) (hoje|amanh|semana|m[eê]s|filial)|compromissos? (da|de) (filial|regional)|audi[eê]ncia|pdf (processos?|agenda)|listagem|painel do escrit[oó]rio|painel (do )?facejus)/i.test(
            p + " " + text
          ) ||
          (/\b(processo|cpf|cnpj|filial|regional|previdenci[aá]rio|oab)\b/i.test(p) &&
            /(lista|mostra|busca|quantos|quais|meus|agenda|pdf)/i.test(p));
        const reminder = /\b(me lembra|me lembre|lembrar|lembrete)\b/.test(p);
        const vistoriaAcao = isLocadoraAcaoPhrase(part) || isLocadoraAcaoPhrase(text);
        const appointment =
          !vistoriaAcao &&
          !escritorioQuery &&
          /\b(agenda|agendar|marque|marcar)\b/.test(p) &&
          !/\btarefa\b/.test(p) &&
          !/\b(hoje|amanh|semana|m[eê]s|compromisso)\b/.test(p);
        const memorySave =
          /\b(guarda|anota|lembra que|salva que|anotar que)\b/.test(p) ||
          /\bmeu .+ (é|e|se chama|chama)\b/.test(p) ||
          /\b(pediu|disse|falou|combinamos|fiquei de|ficou de)\b/.test(p);
        const memoryAsk =
          /(quem é|como se chama|qual é|quais são|quais sao)/i.test(p);
        const listDay =
          !vistoriaAcao &&
          !escritorioQuery &&
          (/(o que (eu )?tenho|o que (eu )?tenho para fazer|para fazer (hoje|amanh)|compromissos?|lembretes?|minha agenda)/i.test(
            p
          ) ||
            (/\bagenda\b/i.test(p) &&
              !/\bagenda\s+jur[ií]dica\b/i.test(p) &&
              !/\bagenda\s+oab\b/i.test(p)));
        const taskList =
          /(pendências|pendencias|minhas tarefas|tarefas abertas|o que (eu )?tenho para fazer)/i.test(
            p
          );
        const taskCreate =
          /(tenho que|preciso)/i.test(p) && !reminder && !appointment && !listDay;
        const imageAsk =
          /(mostra|mostrar|envie|manda|reenvie).{0,40}(imagem|foto|receita|nota|recibo|documento)/i.test(
            p
          ) ||
          /(o que tinha|o que tem|tinha na|nessa).{0,20}(foto|imagem|receita|nota)/i.test(
            p
          ) ||
          /(nome do m[eé]dico|m[eé]dico|crm|rem[eé]dio|medicamento|dosagem|posologia)/i.test(
            p
          );
        const resendMedia =
          /(mostra|mostrar|envie|manda|reenvie|manda de novo).{0,40}(imagem|foto)/i.test(
            p
          ) ||
          /(mostra|mostrar).{0,20}(a )?receita/i.test(p);
        const docSearch =
          imageAsk ||
          ((/(contrato|pdf|documento|nota fiscal|valor|recibo|cupom)/i.test(p) &&
            /(qual|onde|procura|busca|daquele|mostra)/i.test(p)));
        const summarize =
          /(resume|resuma|sumariz)/i.test(p) ||
          (imageAsk && /(resumo|resuma|o que)/i.test(p));
        const parsedSpend = looksLikeSpend(part);
        const expenseSave =
          Boolean(parsedSpend) ||
          /(gastei|paguei|despesa|anota.*(gasto|despesa)|guarda.*(nota|recibo|cupom))/i.test(
            p
          ) ||
          (/(gasolina|posto|mercado|correio|sedex)/i.test(p) &&
            /(r\$|\d+[.,]\d{2}|reais)/i.test(p));
        const expenseList =
          /(quanto (eu )?gastei|gastos? do m[eê]s|meus gastos|extrato|total.*(gasto|despesa)|lista.*(gasto|despesa))/i.test(
            p
          );
        const coachSpend =
          /(como (eu )?(controlo|controlo|anoto|guardo|fa[cç]o).{0,30}(gasto|despesa|financeiro)|como controlo meus gastos|como anotar (gasto|despesa)|como guardar (receita|nota))/i.test(
            p
          );
        const helpAsk =
          /(o que (voc[eê]|vc) (faz|pode)|como (pode|voc[eê]|vc) me ajudar|suas fun[cç][oõ]es|menu|ajuda|capacidades|o que (voc[eê]|vc).{0,40}(dar|informa)|informa[cç][oõ]es sobre)/i.test(
            p
          );
        const locadoraQuery =
          (/(minha locadora|locadora:|carros? dispon|receita (deste|do) m[eê]s|(faturamento|rendimento) da locadora|inadimpl|alugu[eé]is? (atrasad|em atraso)|quem falta pagar|quem (est[aá]|ta) atrasad|alertas?( da locadora| de rastre)|vistoria|manuten[cç]|faturas? da placa|extrato do contrato|onde est[aá] (o |um )?(carro|ve[ií]culo)|localiza[cç][aã]o (da |de )?placa|placa [A-Z]{3}\d|ve[ií]culo (meu|da locadora)|minhas loca[cç]|frota|quem pagou|cnpj (da |de )?(locadora|empresa|jk)|loca[cç][oõ]es|painel d[ae] locadora|painel da frota)/i.test(
            p
          ) ||
            /(carrinhos?|tags?\b|tagbrgps|findtag|brgps|fora (da |de )?(loja|unidade|base|cerca)|por unidade|por loja|rota de recolha|rorta|rotaia|geocerca|iot|supermercado|empilhadeira|manda excel.*(tag|carrinho|fora)|excel.*(tag|carrinho|fora)|onde est[aá].{0,20}(tag|carrinho|lj\d)|(rota|recolha).{0,20}(tag|carrinho|fora))/i.test(
              p
            )) &&
          !escritorioQuery &&
          !(
            /(o que (eu )?tenho|compromissos?|lembretes?|meu dia|amanh[ãa]|google agenda)/i.test(
              p
            ) &&
            !/(locadora|frota|placa|inadimpl)/i.test(p)
          );
        const fxAsk =
          /(cota[cç][aã]o|c[aâ]mbio|d[oó]lar|euro|libra|bitcoin|\busd\b|\beur\b|\bgbp\b|\bbtc\b)/i.test(
            p
          ) &&
          !/(passagem|voo|a[eé]reo|hotel|di[aá]ria)/i.test(p);
        const webAsk =
          /(pre[cç]o|cota[cç][aã]o|passagem|voo|a[eé]reo|hotel|quanto custa|pesquisa|cotar)/i.test(
            p
          ) &&
          !fxAsk &&
          !expenseSave &&
          !expenseList &&
          !/(planilha|csv|excel|sheets|ics|calend[aá]rio|outlook|hotmail)/i.test(p);
        const exportSheet =
          /(planilha|csv|excel|exportar.*(gasto|despesa)|manda.*(planilha|csv))/i.test(
            p
          ) &&
          !/(sincroniz|conectar).{0,20}(google|sheets)/i.test(p) &&
          !/(relat[oó]rio|pdf)/i.test(p);
        const exportIcs =
          /(ics|outlook|hotmail|exportar.*(agenda|calend)|manda.*(arquivo).{0,10}(agenda|calend))/i.test(
            p
          ) && !/(sincroniz|conectar).{0,20}google/i.test(p);
        const weekAhead =
          !escritorioQuery &&
          /(o que (eu )?tenho (essa|esta) semana|pr[oó]ximos vencimentos|agenda (pessoal )?da semana|vencimentos (da|dessa) semana|o que vem por a[ií])/i.test(
            p
          );
        const dailyBrief =
          /^(bom dia|boa tarde|boa noite)\b/i.test(p.trim()) ||
          /(como est[aá] (o )?meu dia|me atualiza|briefing|resumo do dia|o que tenho (hoje|agora))/i.test(
            p
          );
        const weatherAsk =
          /(previs[aã]o( do tempo)?|como est[aá] o tempo|como t[aá] o tempo|tempo (hoje|agora|da semana)|vai chover|clima (hoje|agora)|temperatura)/i.test(
            p
          ) ||
          /^(tempo|clima)\??$/i.test(p.trim()) ||
          /(liga|desliga).{0,30}(previs[aã]o|tempo|clima)/i.test(p);
        const reportPdf =
          /(me manda|manda|gera|gerar|quero).{0,40}(relat[oó]rio|pdf|excel|planilha)/i.test(
            p
          ) ||
          /(relat[oó]rio|pdf).{0,30}(gastos?|despesas?|semana|agenda|locadora|alertas?|faturas?)/i.test(
            p
          ) ||
          /^pdf\b/i.test(p.trim()) ||
          /me manda o relat[oó]rio/i.test(p);
        const monthlyBalance =
          /(balan[cç]o|quanto sobrou|saldo do m[eê]s|fechamento (do )?m[eê]s|receitas? (vs|versus|menos) despesas?|painel pessoal|gr[aá]fico de gastos)/i.test(
            p
          );
        const spendingInsight =
          /(como (eu )?estou de gastos|insight|onde (eu )?estou gastando|an[aá]lise de gastos|gastos vs m[eê]s)/i.test(
            p
          );
        const connectGoogle =
          /(conectar google|conecta (o )?google|ligar google|autorizar google)/i.test(
            p
          );
        const pullCal =
          /(trazer|puxar|importar|baixar|sincroniz).{0,40}(agenda|google agenda|calend[aá]rio)|agenda google para (o |meu )?assessor|do google para (o |meu )?(assessor|mim)/i.test(
            p
          ) && !/planilha|sheets/i.test(p);
        const syncCal =
          !pullCal &&
          /(manda (pro|para o) google agenda|enviar para o google|sync (google )?calendar)/i.test(
            p
          );
        const syncSheets =
          /(sincroniz(ar|a)? (a )?planilha|sync (google )?sheets|manda (pro|para o) google sheets)/i.test(
            p
          );
        const setGoal =
          /(meta de gasto|limite de (gasto|r\$)|quero gastar no m[aá]ximo|no m[aá]ximo r\$|definir meta)/i.test(
            p
          );
        const checkGoal =
          /(como (eu )?estou na meta|progresso da meta|limite do m[eê]s|status da meta)/i.test(
            p
          );

        if (memorySave && !reminder && !memoryAsk) {
          const content = part
            .replace(/^(guarda|anota|salva que|lembra que|anotar que)\s*/i, "")
            .trim();
          toolCalls.push(
            tool("save_memory", {
              content: content || part,
              type: /contador|chama|se chama/.test(p) ? "person" : "fact",
            })
          );
        }

        if (reminder) {
          // Also save preceding fact in same utterance if present
          if (/\b(pediu|disse|falou|desconto|combinamos)\b/.test(lower) && !toolCalls.some((t) => t.name === "save_memory")) {
            const fact = text
              .split(/\n|(?:me lembra)/i)[0]
              .replace(/^(guarda|anota)\s*/i, "")
              .trim();
            if (fact.length > 5) {
              toolCalls.push(
                tool("save_memory", { content: fact, type: "fact" })
              );
            }
          }
          const title =
            part
              .replace(/^.*?\b(me lembra|me lembre|lembrar)\b/i, "")
              .replace(/\b(amanh[ãa]|hoje|ter[cç]a|sexta|às?\s*\d{1,2}.*)/gi, "")
              .replace(/^\s*de\s+/i, "")
              .trim() || "Lembrete";

          // Sem horário em pedido genérico → pergunta com sugestão (não inventa)
          if (!hasExplicitClockTime(part) && !hasExplicitClockTime(text) && !isBillStyleReminder(part + " " + text)) {
            const sug = suggestReminderHour(title + " " + part);
            askTimeReply =
              `Que horário te lembro de *${title}*? Posso deixar às ${sug}h se preferir.`;
            return;
          }

          const when = parseNaturalDateTime(part, timezone) || parseNaturalDateTime(text, timezone);
          const amountMatch = (part + " " + text).match(/r\$\s*([\d.]+(?:,\d{2})?)/i);
          const amount = amountMatch
            ? Number(amountMatch[1].replace(/\./g, "").replace(",", "."))
            : undefined;
          const recurrence_rule =
            parseRecurrenceFromText(part) || parseRecurrenceFromText(text) || undefined;
          toolCalls.push(
            tool("create_reminder", {
              title,
              fire_at_iso: (when || parseNaturalDateTime("amanhã às 9h", timezone))!
                .toUTC()
                .toISO(),
              timezone,
              ...(recurrence_rule ? { recurrence_rule } : {}),
              ...(amount && Number.isFinite(amount) ? { amount, kind: "conta" } : {}),
              ...(isBillStyleReminder(part + " " + text) ? { kind: "conta" } : {}),
              ...(/\b(final do dia|lista|preciso|verificar|cobrar|falar com)\b/i.test(
                text
              )
                ? { also_task: true }
                : {}),
            })
          );
        }

        if (appointment) {
          const title =
            part
              .replace(/^(agenda|agendar|marque|marcar)\s*/i, "")
              .replace(/\b(amanh[ãa]|ter[cç]a|sexta|às?\s*\d{1,2}.*)/gi, "")
              .trim() || "Compromisso";
          if (!hasExplicitClockTime(part) && !hasExplicitClockTime(text)) {
            askTimeReply =
              askTimeReply ||
              `Que horário é *${title}*? Me fala (ex.: 14h) e eu agendo — depois posso te lembrar 15 ou 30 min antes.`;
            return;
          }
          const when =
            parseNaturalDateTime(part, timezone) ||
            parseNaturalDateTime(text, timezone);
          toolCalls.push(
            tool("create_appointment", {
              title,
              starts_at_iso: (when || parseNaturalDateTime("terça às 14h", timezone))!
                .toUTC()
                .toISO(),
              timezone,
            })
          );
        }

        if (listDay) {
          const when =
            parseNaturalDateTime(part, timezone) ||
            parseNaturalDateTime(text, timezone) ||
            parseNaturalDateTime("hoje", timezone);
          const dateIso = when?.toISODate() || undefined;
          toolCalls.push(
            tool("list_reminders", {
              ...(dateIso ? { date_iso: dateIso } : {}),
              timezone,
            })
          );
          if (/(para fazer|tarefas?|pend[eê]ncias?)/i.test(p + " " + text)) {
            toolCalls.push(tool("list_tasks", {}));
          }
        }

        if (taskCreate) {
          toolCalls.push(
            tool("create_task", {
              title: part.replace(/^(tenho que|preciso)\s*/i, "").trim(),
            })
          );
        }
        if (taskList && !toolCalls.some((t) => t.name === "list_tasks")) {
          toolCalls.push(tool("list_tasks", {}));
        }
        if (locadoraQuery && !toolCalls.some((t) => t.name === "query_locadora")) {
          const raw = part.trim() || text.trim();
          const qNorm =
            /painel d[ae] (locadora|frota)/i.test(raw)
              ? "resumo da locadora"
              : /(inadimpl|alugu[eé]is?|falta pagar|atrasad|quem deve)/i.test(raw)
                ? "inadimplência"
                : raw;
          toolCalls.push(tool("query_locadora", { question: qNorm }));
        }
        if (
          escritorioQuery &&
          !toolCalls.some((t) => t.name === "query_escritorio")
        ) {
          const escritorioQ = /painel/i.test(part)
            ? "resumo do escritório"
            : part.trim() || text.trim();
          toolCalls.push(
            tool("query_escritorio", {
              question: escritorioQ,
            })
          );
        }
        if (coachSpend || helpAsk) {
          const locadoraHelp =
            /(locadora|frota|moope finance|rastreamento|vistoria|contrato|assessor.*(locadora|frota)|pela locadora|informa[cç].{0,30}locadora|iot|carrinho|supermercado|tagbrgps|findtag)/i.test(
              p + " " + text
            );
          if (
            (locadoraHelp ||
              (helpAsk && /locadora|frota|iot|carrinho|supermercado/i.test(p + text))) &&
            !toolCalls.some((t) => t.name === "query_locadora")
          ) {
            toolCalls.push(
              tool("query_locadora", { question: "capacidades" })
            );
          } else if (
            (coachSpend || helpAsk) &&
            !toolCalls.some((t) => t.name === "query_locadora" || t.name === "coach_spending")
          ) {
            toolCalls.push(
              tool("coach_spending", {
                topic: helpAsk ? "geral" : part,
              })
            );
          }
        }
        if (exportSheet) toolCalls.push(tool("export_expenses_sheet", {}));
        if (exportIcs) toolCalls.push(tool("export_agenda_ics", {}));
        if (weekAhead) toolCalls.push(tool("week_ahead", { days: 7 }));
        if (dailyBrief && !reportPdf) {
          toolCalls.push(tool("daily_briefing", { include_locadora: true }));
        }
        if (weatherAsk && !dailyBrief) {
          toolCalls.push(
            tool("get_weather", {
              week: /(semana|7 dias|pr[oó]ximos)/i.test(p + " " + text),
            })
          );
        }
        if (monthlyBalance) {
          toolCalls.push(tool("monthly_balance", {}));
        }
        if (spendingInsight) {
          toolCalls.push(tool("spending_insight", {}));
        }
        if (reportPdf) {
          let kind = "auto";
          if (/alerta/i.test(p)) kind = "locadora_alertas";
          else if (/fatura/i.test(p)) kind = "locadora_faturas";
          else if (/locadora|frota/i.test(p)) kind = "locadora_resumo";
          else if (/semana|agenda/i.test(p)) kind = "semana";
          else if (/gasto|despesa|excel|planilha/i.test(p)) kind = "gastos";
          const placaMatch = (part + " " + text).match(
            /placa\s+([A-Z]{3}\d[A-Z0-9]\d{2}|[A-Z]{3}-?\d{4})/i
          );
          toolCalls.push(
            tool("generate_report_pdf", {
              kind,
              ...(placaMatch ? { placa: placaMatch[1].toUpperCase() } : {}),
            })
          );
        }
        if (connectGoogle) toolCalls.push(tool("connect_google", {}));
        if (syncCal || pullCal) toolCalls.push(tool("sync_google_calendar", {}));
        if (syncSheets) toolCalls.push(tool("sync_google_sheets", {}));
        if (checkGoal) toolCalls.push(tool("check_spending_goal", {}));
        if (setGoal) {
          const m = part.match(/r\$\s*([\d.]+(?:,\d{2})?)/i) ||
            part.match(/(\d+[.,]\d{2}|\d{3,})/);
          const monthly_limit = m
            ? Number(String(m[1]).replace(/\./g, "").replace(",", "."))
            : undefined;
          if (monthly_limit && Number.isFinite(monthly_limit)) {
            toolCalls.push(tool("set_spending_goal", { monthly_limit }));
          }
        }
        if (fxAsk) {
          toolCalls.push(tool("get_exchange_rate", {}));
        }
        if (webAsk) {
          toolCalls.push(tool("web_research", { query: part, locale_hint: "Brasil" }));
        }
        if (expenseList) {
          // Não trate pergunta de locadora como gasto pessoal
          if (locadoraQuery) {
            /* handled above */
          } else {
          let category: string | undefined;
          if (/gasolina|posto|combust/i.test(p)) category = "gasolina";
          else if (/mercado|supermercado|padaria/i.test(p)) category = "mercado";
          else if (/correio|sedex/i.test(p)) category = "correio";
          else if (/farm[aá]cia/i.test(p)) category = "farmacia";
          toolCalls.push(
            tool("list_expenses", category ? { category } : {})
          );
          }
        }
        if (resendMedia) {
          toolCalls.push(tool("resend_document_media", {}));
        }
        if (docSearch && !resendMedia) {
          toolCalls.push(tool("search_documents", { query: part }));
        }
        if ((summarize || imageAsk) && !resendMedia) {
          toolCalls.push(tool("summarize_document", {}));
        }
        if (expenseSave && !expenseList && !reminder) {
          const amount = parsedSpend?.amount;
          const category = parsedSpend?.category;
          const merchant = parsedSpend?.label;
          if (parsedSpend && amount && category) {
            toolCalls.push(
              tool("save_expense", {
                amount,
                category,
                merchant,
                note: merchant,
              })
            );
          } else {
            const amountMatch = part.match(/r\$\s*([\d.]+,\d{2}|\d+,\d{2}|\d+\.\d{2}|\d+)/i);
            const raw = amountMatch?.[1] || "";
            const fallbackAmount = raw.includes(",")
              ? Number(raw.replace(/\./g, "").replace(",", "."))
              : Number(raw);
            let fallbackCategory = "outro";
            if (/gasolina|posto|combust/i.test(p)) fallbackCategory = "gasolina";
            else if (/mercado|supermercado|padaria/i.test(p)) fallbackCategory = "mercado";
            else if (/correio|sedex|pac\b/i.test(p)) fallbackCategory = "correio";
            else if (/farm[aá]cia|rem[eé]dio/i.test(p)) fallbackCategory = "farmacia";
            if (Number.isFinite(fallbackAmount) && fallbackAmount > 0) {
              toolCalls.push(
                tool("save_expense", {
                  amount: fallbackAmount,
                  category: fallbackCategory,
                  note: part,
                })
              );
            }
          }
        }
        if ((memoryAsk || imageAsk) && !resendMedia && !coachSpend) {
          toolCalls.push(tool("search_memory", { query: part }));
        }
      };

      if (parts.length > 1) {
        for (const part of parts) handlePart(part);
      } else {
        handlePart(text);
      }

      // Dedupe identical tool names with same JSON args
      const seen = new Set<string>();
      const unique = toolCalls.filter((t) => {
        const key = `${t.name}:${JSON.stringify(t.arguments)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      let content: string | null = null;
      if (askTimeReply && !unique.length) {
        content = askTimeReply;
      } else if (!unique.length) {
        content =
          "Posso: 💸 gastos · ☀️ briefing do dia · 📄 relatórios PDF · 📅 agenda · 🚗 locadora · 🔎 preços. O que você precisa agora?";
      }

      const result: LanguageModelResult = {
        provider: "heuristic",
        model: "heuristic-pt-v1",
        content,
        toolCalls: unique,
        inputTokens: Math.ceil(text.length / 4),
        outputTokens: 32,
      };
      return result;
    },
  };
}
