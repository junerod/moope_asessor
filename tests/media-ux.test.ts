import { describe, expect, it, vi } from "vitest";
import { createZernioClient } from "@/channels/zernio/client";
import { buildXlsxSheet } from "@/lib/report-sheet";
import { createHeuristicLanguageModelProvider } from "@/lib/ai/providers/heuristic";
import { evaluateToolPolicy } from "@/agent/policy/engine";
import { buildSystemPrompt } from "@/agent/context-builder";
import {
  detectVisionDocKind,
  formatVisionForAgent,
  parseVisionExtraction,
  memoryContentFromExtraction,
} from "@/domain/vision-extract";
import "@/agent/tools";
import { getTool } from "@/agent/tools";

describe("media + UX improvements", () => {
  it("uploads an XLSX document to Zernio and attaches it to an inbox message", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ url: "https://media.example/recebimentos.xlsx" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { messageId: "xlsx-sent" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = createZernioClient({
      mock: false,
      apiKey: "test-key",
      apiUrl: "https://zernio.com/api/v1",
      accountId: "test-account",
    });
    const workbook = await buildXlsxSheet({
      name: "Recebimentos",
      headers: ["Valor", "Data"],
      rows: [["R$ 25,00", "28/09/2026"]],
    });

    const upload = await client.uploadMedia({
      buffer: workbook,
      filename: "recebimentos.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(upload).toMatchObject({ ok: true, url: "https://media.example/recebimentos.xlsx" });
    const [uploadUrl, uploadRequest] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(uploadUrl).toBe("https://zernio.com/api/v1/media/upload-direct");
    expect((uploadRequest.body as FormData).get("file")).toBeTruthy();

    const sent = await client.sendMedia({
      conversationId: "dev-conversation",
      attachmentUrl: upload.url!,
      attachmentType: "file",
      attachmentName: "recebimentos.xlsx",
      message: "📊 Planilha de recebimentos",
      idempotencyKey: "receivables-xlsx-test",
      accountId: "test-account",
    });
    expect(sent.ok).toBe(true);
    const [sendUrl, sendRequest] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toContain("/inbox/conversations/dev-conversation/messages");
    expect(JSON.parse(String(sendRequest.body))).toMatchObject({
      attachmentUrl: "https://media.example/recebimentos.xlsx",
      attachmentType: "file",
      attachmentName: "recebimentos.xlsx",
    });
  });

  it("policy allows expense + coach + resend tools", () => {
    expect(evaluateToolPolicy("save_expense")).toBe("ALLOW");
    expect(evaluateToolPolicy("list_expenses")).toBe("ALLOW");
    expect(evaluateToolPolicy("coach_spending")).toBe("ALLOW");
    expect(evaluateToolPolicy("resend_document_media")).toBe("ALLOW");
    expect(getTool("list_expenses")).toBeTruthy();
    expect(getTool("coach_spending")).toBeTruthy();
    expect(getTool("resend_document_media")).toBeTruthy();
  });

  it("heuristic routes receita/médico follow-ups to documents", async () => {
    const llm = createHeuristicLanguageModelProvider();
    const r = await llm.complete({
      system: "",
      messages: [
        { role: "user", content: "qual é o nome do médico da receita?" },
      ],
      tools: [],
    });
    const names = r.toolCalls.map((t) => t.name);
    expect(names).toContain("search_documents");
    expect(names).toContain("search_memory");
  });

  it("heuristic routes mostra a foto to resend_document_media", async () => {
    const llm = createHeuristicLanguageModelProvider();
    const r = await llm.complete({
      system: "",
      messages: [{ role: "user", content: "me mostra a foto da receita" }],
      tools: [],
    });
    expect(r.toolCalls.some((t) => t.name === "resend_document_media")).toBe(
      true
    );
  });

  it("heuristic saves gasolina expense", async () => {
    const llm = createHeuristicLanguageModelProvider();
    const r = await llm.complete({
      system: "",
      messages: [
        { role: "user", content: "gastei R$ 180,50 de gasolina no posto Shell" },
      ],
      tools: [],
    });
    const expense = r.toolCalls.find((t) => t.name === "save_expense");
    expect(expense).toBeTruthy();
    expect(expense?.arguments.category).toBe("gasolina");
    expect(Number(expense?.arguments.amount)).toBeCloseTo(180.5, 1);
  });

  it("heuristic trata mercado 250 só como gasto", async () => {
    const llm = createHeuristicLanguageModelProvider();
    const r = await llm.complete({
      system: "",
      messages: [{ role: "user", content: "Mercado 250." }],
      tools: [],
    });
    const names = r.toolCalls.map((t) => t.name);
    expect(names).toEqual(["save_expense"]);
    expect(r.toolCalls[0]?.arguments.category).toBe("mercado");
    expect(Number(r.toolCalls[0]?.arguments.amount)).toBe(250);
    expect(String(r.content || "")).not.toMatch(/valor é 55|te lembro/);
  });

  it("heuristic lists expenses and coaches spending", async () => {
    const llm = createHeuristicLanguageModelProvider();
    const list = await llm.complete({
      system: "",
      messages: [{ role: "user", content: "quanto gastei esse mês?" }],
      tools: [],
    });
    expect(list.toolCalls.some((t) => t.name === "list_expenses")).toBe(true);

    const coach = await llm.complete({
      system: "",
      messages: [{ role: "user", content: "como controlo meus gastos?" }],
      tools: [],
    });
    expect(coach.toolCalls.some((t) => t.name === "coach_spending")).toBe(true);
  });

  it("system prompt asks for soft emoji and document follow-ups", () => {
    const prompt = buildSystemPrompt({
      currentDateTime: "2026-09-20T18:00:00",
      timezone: "America/Sao_Paulo",
      relevantMemories: [],
      relatedDocumentName: "imagem.jpg",
      audioTranscriptHint: "me lembra amanhã",
    });
    expect(prompt).toMatch(/emoji/i);
    expect(prompt).toMatch(/list_expenses/);
    expect(prompt).toMatch(/coach_spending/);
    expect(prompt).toMatch(/resend_document_media/);
    expect(prompt).toMatch(/Áudio transcrito/);
  });

  it("parses structured receita vision json", () => {
    const extracted = parseVisionExtraction(
      JSON.stringify({
        kind: "receita_medica",
        doctor: "Dr. Rodrigo",
        crm: "32468",
        medicine: "Patz",
        dosage: "10mg Sublingual",
        summary: "Receita de Patz 10mg",
        rawText: "Patz 10mg",
      }),
      "receita_medica"
    );
    expect(extracted.doctor).toBe("Dr. Rodrigo");
    expect(formatVisionForAgent(extracted)).toMatch(/Médico: Dr\. Rodrigo/);
    expect(memoryContentFromExtraction(extracted, "Guardar receita")).toMatch(
      /Patz/
    );
  });

  it("detects nota from caption", () => {
    expect(detectVisionDocKind("nota de gasolina", null)).toBe("nota_recibo");
    expect(detectVisionDocKind("Guardar receita de remédio", null)).toBe(
      "receita_medica"
    );
  });
});
