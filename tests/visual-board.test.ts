import { describe, expect, it } from "vitest";
import { boardFromReply } from "@/domain/visual-board";

describe("boardFromReply", () => {
  it("separa números e alertas do texto da locadora", () => {
    const board = boardFromReply({
      kind: "locadora",
      title: "Frota",
      org: "Locadora Centro",
      text: [
        "Disponíveis: 18",
        "Alugados: 42",
        "Manutenção: 3",
        "⚠️ 2 fora há 24h",
        "João Silva devolve sexta",
      ].join("\n"),
    });
    expect(board.kpis.map((k) => k.value)).toEqual(["18", "42", "3"]);
    expect(board.kpis[2]?.tone).toBe("warn");
    expect(board.alerts.length).toBe(1);
    expect(board.rows.some((r) => /João/.test(r.title))).toBe(true);
    expect(board.bars.map((b) => b.value)).toEqual([18, 42, 3]);
  });
});
