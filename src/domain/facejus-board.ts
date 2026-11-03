import { emptyBoard, type VisualBar, type VisualBoardPayload } from "@/domain/visual-board";

export type ProcessoItem = {
  numero?: string;
  requerente?: string;
  requerido?: string;
  status?: string;
  area?: string;
  filial?: string;
  movido?: string;
};

export type AgendaItem = {
  hora?: string;
  titulo?: string;
  tipo?: string;
  local?: string;
  numero?: string;
  partes?: string;
  filial?: string;
  cliente?: string;
  advogado?: string;
  oab?: string;
};

export type EscritorioPainel = {
  titulo?: string;
  busca?: string;
  escopo?: string;
  totais?: { total?: number; ativos?: number; arquivados?: number };
  por_area?: { label: string; n: number }[];
  por_filial?: { label: string; n: number }[];
  por_natureza?: { label: string; n: number }[];
  por_status?: { label: string; n: number }[];
  amostra?: number;
  itens?: ProcessoItem[];
  modo?: "processos" | "agenda";
  dia?: string;
  natureza?: "processual" | "administrativo" | null;
  escritorio_id?: number | null;
};

function bars(rows: { label: string; n: number }[] | undefined, max: number): VisualBar[] {
  return (rows || [])
    .filter((row) => row && String(row.label || "").trim() && Number(row.n) > 0)
    .slice(0, max)
    .map((row) => ({
      label: String(row.label).slice(0, 28),
      value: Number(row.n),
      display: String(Number(row.n)),
    }));
}

export function boardFromEscritorio(
  pack: EscritorioPainel,
  org?: string
): VisualBoardPayload {
  const itens = Array.isArray(pack.itens) ? pack.itens : [];
  const rows = itens.flatMap((item) => {
    const numero = String(item.numero || "").trim();
    const partes = [item.requerente, item.requerido].filter(Boolean).join(" × ");
    if (!numero && !partes) return [];
    return [
      {
        cells: {
          numero: numero || "s/n",
          partes: partes || "—",
          status: String(item.status || "—"),
          area: String(item.area || "—"),
          filial: String(item.filial || "—"),
        },
        ficha: {
          nome: numero || "s/n",
          papel: "processo",
          partes: partes || "—",
          situacao: String(item.status || "—"),
          area: String(item.area || "—"),
          filial: String(item.filial || "—"),
          data: item.movido ? `Movido em ${item.movido}` : "",
        },
      },
    ];
  });
  const ativos = Number(pack.totais?.ativos || 0);
  const arquivados = Number(pack.totais?.arquivados || 0);
  const total = Number(pack.totais?.total || ativos + arquivados || rows.length);
  const busca = String(pack.busca || "").trim();
  const amostra = rows.length;
  const listaParcial = ativos > amostra && amostra > 0;
  const porFilial = bars(pack.por_filial, 8);
  const porStatus = bars(pack.por_status, 8);
  return emptyBoard({
    kind: "facejus",
    title: pack.titulo || "Processos",
    org,
    subtitle: busca
      ? `${total} para “${busca.slice(0, 40)}”`
      : `${ativos} ativos · ${arquivados} arquivados`,
    kpis: [
      { label: "Ativos", value: String(ativos || rows.length), tone: "ok" },
      { label: "Arquivados", value: String(arquivados), tone: arquivados ? "muted" : "ok" },
      { label: "Total", value: String(total) },
      { label: "Na lista", value: String(amostra), tone: listaParcial ? "warn" : "ok" },
    ],
    donut: bars(pack.por_area, 6),
    donutTitle: "Por área",
    bars: porFilial.length ? porFilial : porStatus,
    barsTitle: porFilial.length ? "Por filial" : "Por status",
    compare: bars(pack.por_natureza, 4).length
      ? bars(pack.por_natureza, 4)
      : bars(pack.por_status, 4),
    compareTitle: bars(pack.por_natureza, 4).length ? "Por natureza" : "Por status",
    table: rows.length
      ? {
          search: "Nome, CPF ou número do processo",
          title: pack.titulo || "Últimos 10 com movimentação",
          layout: "cards",
          columns: [
            { key: "numero", label: "Processo", sort: "text" },
            { key: "partes", label: "Partes", sort: "text" },
            { key: "status", label: "Status", sort: "text" },
            { key: "area", label: "Área", sort: "text" },
            { key: "filial", label: "Filial", sort: "text" },
          ],
          rows,
        }
      : undefined,
    note: "Últimos 10 com movimentação. Na busca, digite um nome, CPF ou número para consultar o escritório na hora. O link vale 24 horas.",
    links: [{ label: "Abrir Facejus", href: "https://web.facejus.com.br" }],
  });
}

function advogadoLinha(item: AgendaItem): string {
  const nome = String(item.advogado || "").trim();
  const oab = String(item.oab || "").replace(/\s+/g, "");
  if (nome && oab) return `${nome} · OAB ${oab}`;
  if (oab) return `OAB ${oab}`;
  return nome;
}

export function boardFromAgenda(pack: EscritorioPainel, org?: string): VisualBoardPayload {
  const atendimento =
    pack.natureza === "administrativo" || /atendimento/i.test(String(pack.titulo || ""));
  const itens = (Array.isArray(pack.itens) ? pack.itens : []) as AgendaItem[];
  const rows = itens.flatMap((item) => {
    const titulo = String(item.titulo || "").trim();
    const cliente = String(item.cliente || "").trim();
    if (!titulo && !item.hora && !cliente) return [];
    const filial = String(item.filial || "").trim() || "Sem filial";
    const quem = advogadoLinha(item);
    const nome = atendimento ? cliente || titulo || "Atendimento" : titulo || "Prazo";
    const detalhe = atendimento
      ? [quem, titulo && titulo !== nome ? titulo : "", item.local].filter(Boolean).join(" · ")
      : String(item.partes || item.local || "");
    return [
      {
        cells: {
          numero: String(item.hora || ""),
          partes: nome,
          status: String(item.tipo || ""),
          area: detalhe,
          filial,
          doc: atendimento ? "" : String(item.numero || ""),
        },
        ficha: {
          nome,
          papel: "agenda",
          data: [item.hora, pack.dia].filter(Boolean).join(" · "),
          partes: atendimento ? titulo || quem || "—" : String(item.partes || "—"),
          documento: atendimento ? (item.oab ? `OAB ${String(item.oab).replace(/\s+/g, "")}` : "") : String(item.numero || ""),
          local: String(item.local || quem || ""),
          filial,
          situacao: String(item.tipo || ""),
        },
      },
    ];
  });
  const porFilial = bars(pack.por_filial, 8);
  const dia = pack.dia ? String(pack.dia).split("-").reverse().join("/") : "";
  const comHora = rows.filter((row) => row.cells.numero).length;
  const titulo = pack.titulo || (atendimento ? "Atendimentos" : "Prazos processuais");
  return emptyBoard({
    kind: "facejus",
    title: titulo,
    org,
    subtitle: [dia ? `Dia ${dia}` : "", pack.escopo].filter(Boolean).join(" · "),
    kpis: [
      {
        label: atendimento ? "Atendimentos" : "Prazos",
        value: String(rows.length),
        tone: rows.length ? "ok" : "muted",
      },
      { label: "Filiais", value: String(porFilial.length || new Set(rows.map((row) => row.cells.filial)).size) },
      { label: "Com hora", value: String(comHora), tone: comHora ? "ok" : "muted" },
    ],
    bars: porFilial,
    barsTitle: porFilial.length ? "Por filial" : undefined,
    table: {
      search: atendimento ? "Cliente, advogado ou filial" : "Prazo, parte, processo ou filial",
      title: titulo,
      layout: "cards",
      columns: atendimento
        ? [
            { key: "filial", label: "Filial", sort: "text" },
            { key: "partes", label: "Consulta", sort: "text" },
            { key: "area", label: "Advogado", sort: "text" },
          ]
        : [
            { key: "filial", label: "Filial", sort: "text" },
            { key: "partes", label: "Prazo", sort: "text" },
            { key: "area", label: "Partes", sort: "text" },
            { key: "doc", label: "Processo", sort: "text" },
          ],
      rows,
    },
    note: atendimento
      ? "Consultas e reuniões, agrupadas por filial. Para um advogado, peça de novo com a OAB. O calendário abre outra data e o PDF baixa a lista. O link vale 24 horas."
      : comHora
        ? "Prazos processuais deste dia, no escopo que você pediu. O calendário abre outra data. O PDF baixa a lista. O link vale 24 horas."
        : "Estes prazos processuais estão sem hora no escritório. A lista segue por filial. O calendário abre outra data e o PDF baixa o dia. O link vale 24 horas.",
    links: [{ label: "Abrir Facejus", href: "https://web.facejus.com.br" }],
  });
}
