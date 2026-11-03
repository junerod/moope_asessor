import { describe, expect, it } from "vitest";
import { boardFromAiConsumo } from "@/domain/ai-consumo";
import { sanitizeBoard } from "@/domain/visual-board";

describe("painel de consumo de IA", () => {
  it("monta o painel escuro com os 7 dias e o veredito", () => {
    const board = sanitizeBoard(
      boardFromAiConsumo({
        titulo: "A franquia de IA cabe neste mês",
        subtitulo: "Meu Assessor em produção, 01/10 a 07/10. Modelo gpt-4o-mini.",
        gastoBrl: 1.09,
        ritmoBrl: 4.67,
        inTok: 1_300_000,
        outTok: 11_000,
        veredito: "Não cobre o uso por causa de token",
        detalhe: "No ritmo desta semana o mês inteiro fica perto de R$ 4,67 de IA.",
        dias: [
          { dia: "2026-10-01", label: "01/10", inTok: 173000, outTok: 1000 },
          { dia: "2026-10-02", label: "02/10", inTok: 0, outTok: 0 },
        ],
        linhas: [{ title: "Pessoal", value: "173 mil · R$ 0,14" }],
      })
    );
    expect(board?.kind).toBe("dev");
    expect(board?.title).toMatch(/franquia/);
    expect(board?.kpis[0]?.value).toBe("R$ 1,09");
    expect(board?.kpis[2]?.value).toBe("1,30 mi");
    expect(board?.barsTitle).toBe("Tokens de entrada por dia");
    expect(board?.bars[0]?.display).toBe("173 mil");
    expect(board?.alerts[0]?.title).toMatch(/Não cobre/);
    expect(board?.rows[0]?.title).toBe("Pessoal");
  });
});
