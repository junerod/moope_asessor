import { describe, expect, it } from "vitest";
import { boardFromAgenda, boardFromEscritorio } from "@/domain/facejus-board";
import { sanitizeBoard } from "@/domain/visual-board";

describe("painel jurídico", () => {
  it("monta busca, gráficos e ficha do processo", () => {
    const board = sanitizeBoard(
      boardFromEscritorio(
        {
          titulo: "Processos do escritório",
          totais: { total: 10, ativos: 8, arquivados: 2 },
          por_area: [{ label: "civil", n: 5 }, { label: "trabalhista", n: 3 }],
          por_filial: [{ label: "Sede", n: 8 }],
          por_natureza: [{ label: "Ação", n: 4 }],
          itens: [
            {
              numero: "0001234-55.2024.8.24.0023",
              requerente: "Maria",
              requerido: "INSS",
              status: "Ativo",
              area: "civil",
              filial: "Sede",
            },
          ],
        },
        "Rodrigues Advogados"
      )
    );
    expect(board?.kind).toBe("facejus");
    expect(board?.org).toBe("Rodrigues Advogados");
    expect(board?.kpis.map((k) => k.label)).toEqual([
      "Ativos",
      "Arquivados",
      "Total",
      "Na lista",
    ]);
    expect(board?.donut?.[0]?.label).toBe("civil");
    expect(board?.table?.search).toMatch(/Nome, CPF/);
    expect(board?.note).toMatch(/Últimos 10 com movimentação/);
    expect(board?.table?.layout).toBe("cards");
    expect(board?.table?.rows[0]?.ficha?.nome).toBe("0001234-55.2024.8.24.0023");
    expect(board?.table?.rows[0]?.ficha?.papel).toBe("processo");
    expect(board?.table?.rows[0]?.ficha?.partes).toBe("Maria × INSS");
    expect(board?.table?.rows[0]?.cells.partes).toBe("Maria × INSS");
  });

  it("separa painel de atendimento e de prazos processuais", () => {
    const prazos = boardFromAgenda(
      {
        modo: "agenda",
        natureza: "processual",
        titulo: "Prazos de 17/10/2026",
        dia: "2026-10-17",
        itens: [
          {
            hora: "09:30",
            titulo: "Audiência",
            partes: "Maria × INSS",
            numero: "0001234-55.2024.8.24.0023",
            filial: "Içara",
          },
        ],
      },
      "Rodrigues"
    );
    const atendimento = boardFromAgenda(
      {
        modo: "agenda",
        natureza: "administrativo",
        titulo: "Atendimentos de 17/10/2026",
        dia: "2026-10-17",
        por_filial: [{ label: "Içara", n: 1 }],
        itens: [
          {
            hora: "14:00",
            titulo: "Consulta inicial",
            cliente: "Marilene",
            advogado: "Ana",
            oab: "15444",
            filial: "Içara",
          },
        ],
      },
      "Rodrigues"
    );
    expect(prazos?.kpis[0]?.label).toBe("Prazos");
    expect(prazos?.table?.columns.map((col) => col.label)).toContain("Processo");
    expect(prazos?.table?.rows[0]?.cells.doc).toMatch(/0001234/);
    expect(atendimento?.kpis[0]?.label).toBe("Atendimentos");
    expect(atendimento?.table?.search).toMatch(/Cliente/);
    expect(atendimento?.table?.rows[0]?.cells.partes).toBe("Marilene");
    expect(atendimento?.table?.rows[0]?.cells.filial).toBe("Içara");
    expect(atendimento?.table?.rows[0]?.cells.area).toMatch(/OAB 15444/);
    expect(atendimento?.note).toMatch(/filial/);
    expect(atendimento?.note).toMatch(/OAB/);
  });
});
