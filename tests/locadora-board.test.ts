import { describe, expect, it } from "vitest";
import { boardFromInvestidores, boardFromLocadora, boardFromLocatarios, boardFromRendimentos, boardFromVeiculos } from "@/domain/locadora-board";
import { sanitizeBoard } from "@/domain/visual-board";

describe("boardFromLocadora", () => {
  it("monta rosca, receita e a lista de atraso com boleto", () => {
    const board = boardFromLocadora({
      title: "Resumo da locadora",
      org: "Locadora Teste",
      text: [
        "Frota: 2 disp. · 3 alugados · 1 manut. · 6 total",
        "Inadimplência: 2 título(s)",
        "• R$ 100,00 · venc. 01/09/2026 · Ana Souza",
        "• R$ 50,00 · venc. — · Bruno Lima",
      ].join("\n"),
      snapshot: {
        frota: { total: 6, disponiveis: 2, alugados: 3, manutencao: 1 },
        contratos: { ativos: 4, pendentes: 0 },
        financeiro: { receita_mes: 1000, receita_mes_passado: 800 },
        inadimplencia: {
          qtd: 2,
          itens: [
            {
              id: 1,
              valor: 100,
              vencimento: "2026-09-01",
              status: "pendente",
              nome: "Ana Souza",
              descricao: "Aluguel setembro",
              placa: "ABC1D23",
              contrato: "88",
              boleto: "https://boletos.example/a",
            },
            { id: 2, valor: 50, vencimento: null, status: "pendente", descricao: null },
          ],
        },
      },
    });
    expect(board.donut?.map((d) => d.label)).toEqual([
      "Disponíveis",
      "Alugados",
      "Manutenção",
    ]);
    expect(board.compare?.map((c) => c.label)).toEqual(["Este mês", "Mês passado"]);
    expect(board.rows).toHaveLength(2);
    expect(board.rows[0]?.title).toBe("Ana Souza");
    expect(board.rows[0]?.detail).toContain("Aluguel setembro");
    expect(board.rows[0]?.detail).toContain("ABC1D23");
    expect(board.rows[0]?.detail).toContain("Contrato 88");
    expect(board.rows[0]?.href).toBe("https://boletos.example/a");
    expect(board.rows[1]?.title).toBe("Bruno Lima");
    expect(board.rows[1]?.href).toBeUndefined();
    expect(board.kpis.find((k) => k.label === "Em atraso")?.value).toContain("150");
    expect(board.rows[0]?.detail).toContain("Em atraso");
  });

  it("mostra a receber no mês, na semana e o valor do próximo boleto", () => {
    const board = boardFromLocadora({
      title: "Resumo da locadora",
      text: "Inadimplência: 1 título",
      snapshot: {
        financeiro: { receita_mes: 500, receita_mes_passado: 400 },
        inadimplencia: { qtd: 1, total: 80, itens: [] },
        a_receber: {
          mes: 1200,
          semana: 300,
          semana_qtd: 2,
          proximos: [
            {
              nome: "Maria Souza",
              valor: 300,
              vencimento: "2026-10-08",
              placa: "ABC1D23",
              parcela: 300,
            },
          ],
        },
      },
    });
    expect(board.kpis.map((k) => k.label)).toEqual([
      "A receber no mês",
      "Na semana",
      "Em atraso",
      "Receita do mês",
    ]);
    expect(board.kpis[0]?.value).toContain("1.200");
    expect(board.kpis[1]?.value).toContain("300");
    expect(board.rows[0]?.title).toBe("Maria Souza");
    expect(board.rows[0]?.value).toContain("300");
    expect(board.rows[0]?.detail).toContain("08/10/2026");
    expect(board.rows[0]?.detail).toContain("Parcela");
  });

  it("não deixa passar link que não é http", () => {
    const clean = sanitizeBoard({
      kind: "locadora",
      title: "X",
      kpis: [],
      bars: [],
      rows: [{ title: "Ana", href: "javascript:alert(1)" }],
      alerts: [],
    });
    expect(clean?.rows[0]?.href).toBeUndefined();
  });

  it("monta o painel de rendimentos com os quatro arquivos", () => {
    const board = boardFromRendimentos(
      {
        periodo: "setembro de 2026",
        start: "2026-09-01",
        end: "2026-09-30",
        userid: 9,
        veiculos: 10,
        alugados: 7,
        receita_locacao: 10000,
        custos: 4000,
        repasse: 2000,
        lucro: 4000,
        margem: 40,
        top: [{ nome: "Onix", placa: "ABC1D23", lucro: 800 }],
        serie: [{ label: "2026-09", receita: 10000 }],
      },
      "Locadora Teste"
    );
    expect(board.title).toBe("Rendimentos da locadora");
    expect(board.downloads?.map((d) => d.kind)).toEqual([
      "pdf",
      "contabil",
      "executivo",
      "xlsx",
    ]);
    const clean = sanitizeBoard(board);
    expect(clean?.exportRef).toEqual({
      userid: 9,
      start: "2026-09-01",
      end: "2026-09-30",
    });
    expect(clean?.kpis[0]?.label).toBe("Lucro da locadora");
    expect(clean?.links?.[0]?.href).toBe("https://frotas.moope.com.br/viewlocrend");
  });

});

describe("boardFromLocatarios", () => {
  it("separa atraso, semana, mês e pago", () => {
    const board = boardFromLocatarios({
      qtd: 3,
      em_dia: 1,
      em_atraso: 1,
      total_atraso: 1500,
      total_semana: 400,
      total_mes: 800,
      total_pago: 2200,
      itens: [
        {
          nome: "Maria Souza",
          situacao: "Em atraso",
          faturas: "Atraso R$ 1.500,00 · Semana R$ 200,00",
          atraso_valor: 1500,
          semana_valor: 200,
          mes_valor: 200,
          pago_valor: 0,
          deve: "R$ 1.500,00",
          proxima: "R$ 200,00 em 10/10/2026",
          telefone: "(61) 99999-0000",
          whatsapp: "https://wa.me/5561999990000",
          placas: ["ABC1D23"],
          contratos: 1,
          veiculos: [
            {
              placa: "ABC1D23",
              modelo: "Fiat Mobi",
              situacao: "Alugado",
              local: "Asa Norte, Brasília · online · 04/10/2026, 14:10",
              mapa: "https://www.google.com/maps?q=-15.7,-47.8",
            },
          ],
        },
      ],
    });
    expect(board.kpis.map((k) => k.label)).toEqual([
      "Em atraso",
      "Na semana",
      "No mês",
      "Pago no mês",
    ]);
    expect(board.kpis[0]?.value).toContain("1.500");
    expect(board.kpis[1]?.value).toContain("400");
    expect(board.kpis[2]?.value).toContain("800");
    expect(board.kpis[3]?.value).toContain("2.200");
    expect(board.table?.rows[0]?.nums?.valor).toBe(1500);
    expect(board.table?.rows[0]?.ficha?.semana).toContain("200");
    expect(board.table?.rows[0]?.ficha?.deve).toContain("1.500");
    expect(board.table?.rows[0]?.ficha?.proxima).toContain("10/10/2026");
    expect(board.table?.rows[0]?.ficha?.telefone_href).toContain("wa.me/5561999990000");
    expect(board.table?.rows[0]?.ficha?.ativo).toBe("Contrato ativo");
    expect(board.table?.rows[0]?.related?.[0]?.papel).toBe("veiculo");
    expect(board.table?.rows[0]?.related?.[0]?.nome).toBe("ABC1D23");
    expect(board.table?.rows[0]?.related?.[0]?.local).toContain("Asa Norte");
    const clean = sanitizeBoard(board);
    expect(clean?.table?.rows[0]?.related?.[0]?.nome).toBe("ABC1D23");
    expect(clean?.table?.rows[0]?.ficha?.ativo).toBe("Contrato ativo");
  });
});

describe("boardFromVeiculos", () => {
  it("monta card ativo com locatário, status e mapa", () => {
    const board = boardFromVeiculos({
      qtd: 2,
      alugados: 1,
      disponiveis: 1,
      manutencao: 0,
      itens: [
        {
          placa: "RTT5J81",
          modelo: "Fiat Argo",
          locatario: "Andre Lacerda",
          locatario_href: "https://frotas.moope.com.br/previewlocatario?id=9",
          locatario_ficha: {
            nome: "Andre Lacerda",
            documento: "123.456.789-00",
            telefone: "(61) 99999-0000",
            whatsapp: "https://wa.me/5561999990000",
            deve: "Em dia",
            proxima: "R$ 740,00 em 05/10/2026",
            contratos: 1,
            situacao: "A vencer",
            href: "https://frotas.moope.com.br/previewlocatario?id=9",
          },
          motorista: "Carlos Souza",
          motorista_href: "https://frotas.moope.com.br/motorista?preview=1&motorista_id=3",
          situacao: "Alugado",
          local: "Asa Norte, Brasília · online · 04/10/2026, 14:10",
          mapa: "https://www.google.com/maps?q=-15.7,-47.8",
        },
      ],
    });
    expect(board.kpis.map((k) => k.label)).toEqual([
      "Ativos",
      "Alugados",
      "Disponíveis",
      "Manutenção",
    ]);
    expect(board.table?.layout).toBe("cards");
    expect(board.table?.rows[0]?.cells.nome).toBe("RTT5J81");
    expect(board.table?.rows[0]?.cells.situacao).toBe("Alugado");
    expect(board.table?.rows[0]?.ficha?.locatario).toBe("Andre Lacerda");
    expect(board.table?.rows[0]?.ficha?.locatario_href).toBeUndefined();
    const pessoa = board.table?.rows[0]?.related?.find((item) => item.papel === "locatario");
    expect(pessoa?.nome).toBe("Andre Lacerda");
    expect(pessoa?.deve).toBe("Em dia");
    expect(pessoa?.telefone_href).toContain("wa.me/5561999990000");
    expect(pessoa?.placas).toContain("RTT5J81");
    expect(board.table?.rows[0]?.ficha?.motorista_href).toContain("motorista_id=3");
    expect(board.table?.rows[0]?.ficha?.local).toContain("Asa Norte");
    expect(board.table?.rows[0]?.ficha?.local).not.toMatch(/-15\.7/);
    expect(board.table?.rows[0]?.ficha?.mapa).toContain("google.com/maps");
    expect(board.links?.[0]?.href).toBe("https://frotas.moope.com.br/veiculos");
  });
});

describe("boardFromInvestidores", () => {
  it("ignora repasse zerado, mostra o ano e guarda a ficha", () => {
    const board = boardFromInvestidores(
      {
        qtd: 2,
        veiculos: 3,
        soma_ultimos: 3128.36,
        soma_ano: 9000,
        itens: [
          {
            nome: "Alan Franco",
            documento: "123.456.789-00",
            placas: ["UJE6J16"],
            ultimo_valor: 0,
            ultimo_data: "Fri Sep 04",
            situacao: "Sem repasse",
            ano: 0,
            href: "https://frotas.moope.com.br/previewinvestidor?id=1",
          },
          {
            nome: "Agnaldo Torres",
            documento: "987.654.321-00",
            placas: ["FIY7A41", "RVV8E34"],
            ultimo_valor: 3128.36,
            ultimo_data: "04/09/2026",
            situacao: "Pago",
            ano: 3128.36,
            href: "https://frotas.moope.com.br/previewinvestidor?id=2",
          },
        ],
      },
      "Solutt"
    );
    expect(board.kpis.map((k) => k.label)).toEqual([
      "Com veículo",
      "Veículos",
      "Último repasse",
      "No ano",
    ]);
    expect(board.table?.layout).toBe("cards");
    expect(board.table?.rows[0]?.cells.valor).toBe("Sem repasse");
    expect(board.table?.rows[0]?.cells.data).toBe("—");
    expect(board.table?.rows[1]?.cells.data).toBe("04/09/2026");
    expect(board.table?.rows[1]?.ficha?.href).toContain("previewinvestidor?id=2");
    expect(board.links?.[0]?.label).toBe("Acessar MOOPE Frotas");
    const clean = sanitizeBoard(board);
    expect(clean?.table?.rows).toHaveLength(2);
    expect(clean?.table?.rows[1]?.ficha?.documento).toBe("987.654.321-00");
  });
});
