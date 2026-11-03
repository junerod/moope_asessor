/**
 * Painel da locadora a partir do snapshot do Gestão.
 * O WhatsApp continua com o texto. Aqui entram gráfico e a lista de títulos.
 */
import {
  boardFromReply,
  emptyBoard,
  type VisualBar,
  type VisualBoardPayload,
  type VisualKpi,
  type VisualRow,
} from "@/domain/visual-board";

type DebtItem = {
  id?: number;
  valor?: number;
  vencimento?: string | null;
  status?: string | null;
  descricao?: string | null;
  placa?: string | null;
  contrato?: string | number | null;
  boleto?: string | null;
  url?: string | null;
  link?: string | null;
  nome?: string | null;
  parcela?: number | null;
};

type AReceber = {
  mes?: number;
  mes_qtd?: number;
  semana?: number;
  semana_qtd?: number;
  proximos?: DebtItem[];
};

type LocadoraSnapshot = {
  frota?: {
    total?: number;
    disponiveis?: number;
    alugados?: number;
    manutencao?: number;
  };
  contratos?: { ativos?: number; pendentes?: number };
  financeiro?: {
    receita_mes?: number;
    receita_mes_passado?: number;
    fonte?: string;
    fonte_label?: string;
  };
  inadimplencia?: { qtd?: number; total?: number; itens?: DebtItem[] };
  a_receber?: AReceber;
};

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(String(v).replace(/\./g, "").replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
}

function moneyBr(n: number) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function asSnapshot(raw: unknown): LocadoraSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as LocadoraSnapshot;
  if (!o.frota && !o.financeiro && !o.inadimplencia && !o.contratos) return null;
  return o;
}

function formatDue(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
    }
  }
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t || t === "—" || t === "-") return undefined;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  if (/^\d{2}\/\d{2}/.test(t)) return t;
  return undefined;
}

function safeUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/[),.;]+$/, "");
  if (!/^https?:\/\/\S+$/i.test(t)) return undefined;
  return t;
}

type ParsedDebt = {
  name?: string;
  plate?: string;
  contract?: string;
  due?: string;
  href?: string;
};

/** Linha do Zap: • R$ 1.234,00 · venc. 01/09/2026 · Nome */
function parseDebtLines(text: string): ParsedDebt[] {
  const out: ParsedDebt[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\*/g, "").trim();
    if (!/^[•-]/.test(line) || !/R\$/.test(line)) continue;
    const href = safeUrl(line.match(/https?:\/\/\S+/)?.[0]);
    const plate = line.match(/\b[A-Z]{3}\d[A-Z0-9]\d{2}\b/)?.[0];
    const contract = line.match(/contrato\s*#?\s*([A-Za-z0-9-]+)/i)?.[1];
    const dueRaw = line.match(/venc\.?\s*([^·]+)/i)?.[1]?.trim();
    const due = dueRaw && dueRaw !== "—" && dueRaw !== "-" ? dueRaw : undefined;
    const tail = line.split("·").pop()?.replace(href || "", "").trim();
    const name =
      tail && !/^R\$/.test(tail) && tail !== "—" && !/^venc/i.test(tail)
        ? tail
        : undefined;
    out.push({ name, plate, contract, due, href });
  }
  return out;
}

function debtRows(snap: LocadoraSnapshot, text: string): VisualRow[] {
  const parsed = parseDebtLines(text);
  const itens = Array.isArray(snap.inadimplencia?.itens) ? snap.inadimplencia.itens : [];
  if (!itens.length && !parsed.length) return [];

  const source: DebtItem[] = itens.length
    ? itens
    : parsed.map(() => ({}));

  return source.slice(0, 20).flatMap((item, i) => {
    const fromText = parsed[i];
    const valor = num(item.valor);
    const descricao =
      typeof item.descricao === "string" && item.descricao.trim()
        ? item.descricao.trim()
        : "";
    const name =
      (typeof item.nome === "string" && item.nome.trim()) || fromText?.name || "";
    if (!name) return [];
    const plate =
      (typeof item.placa === "string" && item.placa.trim()) || fromText?.plate;
    const contractRaw = item.contrato ?? fromText?.contract;
    const contract =
      contractRaw != null && String(contractRaw).trim()
        ? String(contractRaw).trim()
        : undefined;
    const due = formatDue(item.vencimento) || fromText?.due;
    const href =
      safeUrl(item.boleto) || safeUrl(item.url) || safeUrl(item.link) || fromText?.href;
    const parcela = num(item.parcela);
    const detail = [
      "Em atraso",
      descricao && descricao.toLowerCase() !== name.toLowerCase() ? descricao : "",
      plate ? `Placa ${plate}` : "",
      contract ? `Contrato ${contract}` : "",
      due ? `Venc. ${due}` : "",
      parcela != null && parcela > 0 ? `Parcela ${moneyBr(parcela)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return [{
      title: name,
      detail: detail || undefined,
      value: valor != null && valor > 0 ? moneyBr(valor) : undefined,
      tone: "warn" as const,
      href,
      hrefLabel: href ? "Abrir boleto" : undefined,
    }];
  });
}

function boletoRows(items: DebtItem[], tone: "ok" | "warn"): VisualRow[] {
  return items.flatMap((item) => {
    const nome = String(item.nome || "").trim();
    const valor = num(item.valor);
    if (!nome || valor == null || valor <= 0) return [];
    const due = formatDue(item.vencimento);
    const plate = String(item.placa || "").trim();
    const parcela = num(item.parcela);
    const href = safeUrl(item.boleto) || safeUrl(item.url) || safeUrl(item.link);
    const detail = [
      tone === "ok" ? "A vencer" : "Em atraso",
      plate ? `Placa ${plate}` : "",
      due ? `Venc. ${due}` : "",
      parcela != null && parcela > 0 ? `Parcela ${moneyBr(parcela)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return [{
      title: nome,
      detail,
      value: moneyBr(valor),
      tone,
      href,
      hrefLabel: href ? "Abrir boleto" : undefined,
    }];
  });
}

function countBar(label: string, value: number | null): VisualBar | null {
  if (value == null || value < 0) return null;
  return { label, value, display: String(value) };
}

export function boardFromLocadora(input: {
  title: string;
  org?: string;
  text: string;
  snapshot?: unknown;
}): VisualBoardPayload {
  const snap = asSnapshot(input.snapshot);
  if (!snap) {
    return boardFromReply({
      kind: "locadora",
      title: input.title,
      org: input.org,
      text: input.text,
    });
  }

  const frota = snap.frota || {};
  const fin = snap.financeiro || {};
  const contratos = snap.contratos || {};
  const ativosFrota = num((frota as { ativos?: number }).ativos);
  const disp = num(frota.disponiveis);
  const alug = num(frota.alugados);
  const manut = num(frota.manutencao);
  const total = num(frota.total);
  const receita = num(fin.receita_mes);
  const passado = num(fin.receita_mes_passado);
  const ativos = num(contratos.ativos);
  const debts = debtRows(snap, input.text);
  const atraso =
    num(snap.inadimplencia?.total) ??
    (snap.inadimplencia?.itens || []).reduce((s, item) => s + (num(item.valor) || 0), 0);
  const qtd = num(snap.inadimplencia?.qtd) ?? (debts.length || null);
  const receber = snap.a_receber;
  const aMes = num(receber?.mes);
  const aSemana = num(receber?.semana);
  const semanaQtd = num(receber?.semana_qtd) ?? 0;
  const proximos = boletoRows(receber?.proximos || [], "ok");

  const kpis: VisualKpi[] = [];
  if (aMes != null) {
    kpis.push({ label: "A receber no mês", value: moneyBr(aMes), tone: "ok" });
  }
  if (semanaQtd > 0) {
    kpis.push({ label: "Na semana", value: moneyBr(aSemana || 0), tone: "ok" });
  }
  if (qtd != null && (qtd > 0 || aMes != null)) {
    kpis.push({
      label: "Em atraso",
      value: atraso > 0 ? moneyBr(atraso) : "Nenhum",
      tone: atraso > 0 ? "warn" : "muted",
    });
  }
  if (receita != null) kpis.push({ label: "Receita do mês", value: moneyBr(receita), tone: "ok" });
  if (kpis.length < 4 && disp != null) kpis.push({ label: "Disponíveis", value: String(disp), tone: "ok" });
  if (kpis.length < 4 && alug != null) kpis.push({ label: "Alugados", value: String(alug) });
  if (kpis.length < 4 && ativos != null && !(qtd != null && qtd > 0)) {
    kpis.push({ label: "Contratos", value: String(ativos) });
  }

  const donut = [countBar("Disponíveis", disp), countBar("Alugados", alug), countBar("Manutenção", manut)].filter(
    (b): b is VisualBar => Boolean(b)
  );
  const donutLive = donut.some((b) => b.value > 0);

  const compare = [
    receita != null ? { label: "Este mês", value: receita, display: moneyBr(receita) } : null,
    passado != null ? { label: "Mês passado", value: passado, display: moneyBr(passado) } : null,
  ].filter((b): b is VisualBar => Boolean(b));

  const showDebts = /resumo|inadimpl|título|titulo/i.test(`${input.title}\n${input.text}`);

  return emptyBoard({
    kind: "locadora",
    title: input.title,
    org: input.org,
    subtitle:
      ativosFrota != null
        ? `${ativosFrota} veículos ativos${ativos != null ? ` · ${ativos} contratos ativos` : ""}`
        : total != null
          ? `${total} veículos na frota${ativos != null ? ` · ${ativos} contratos ativos` : ""}`
          : "Números desta consulta",
    kpis: kpis.slice(0, 6),
    donut: donutLive ? donut : [],
    donutTitle: donutLive ? "Frota" : undefined,
    compare: compare.length >= 2 ? compare : [],
    compareTitle: compare.length >= 2 ? "Receita já recebida" : undefined,
    bars: [],
    rows: [...proximos, ...(showDebts ? debts : [])],
    rowsTitle: proximos.length && showDebts && debts.length
      ? "Próximos e em atraso"
      : proximos.length
        ? "Próximos boletos"
        : showDebts && debts.length
          ? "Em atraso"
          : undefined,
    alerts: [],
    note: [
      fin.fonte_label ? `Valores: ${fin.fonte_label}.` : "",
      "O link vale 24 horas e não abre dados de outra pessoa.",
    ]
      .filter(Boolean)
      .join(" "),
  });
}

export type RendimentosPack = {
  empresa?: string;
  periodo?: string;
  start?: string;
  end?: string;
  userid?: number;
  veiculos?: number;
  alugados?: number;
  receita_locacao?: number;
  outras?: number;
  custos?: number;
  repasse?: number;
  lucro?: number;
  margem?: number;
  top?: { nome?: string; placa?: string; lucro?: number }[];
  bottom?: { nome?: string; placa?: string; lucro?: number }[];
  serie?: { label?: string; receita?: number }[];
};

/** Painel do mesmo cálculo da tela Rendimentos da frota. */
export function boardFromRendimentos(
  pack: RendimentosPack,
  org?: string
): VisualBoardPayload {
  const lucro = num(pack.lucro) ?? 0;
  const receita = num(pack.receita_locacao) ?? 0;
  const outras = num(pack.outras) ?? 0;
  const custos = num(pack.custos) ?? 0;
  const repasse = num(pack.repasse) ?? 0;
  const margem = num(pack.margem) ?? 0;
  const kpis: VisualKpi[] = [
    {
      label: "Lucro da locadora",
      value: moneyBr(lucro),
      tone: lucro >= 0 ? "ok" : "warn",
    },
    { label: "Receita locação", value: moneyBr(receita), tone: "ok" },
    { label: "Custos", value: moneyBr(custos), tone: "warn" },
    { label: "Margem", value: `${margem.toFixed(1)}%` },
  ];
  const compare = [
    { label: "Receita", value: Math.max(0, receita), display: moneyBr(receita) },
    outras > 0
      ? { label: "Outras receitas", value: outras, display: moneyBr(outras) }
      : null,
    { label: "Custos", value: Math.max(0, custos), display: moneyBr(custos) },
    { label: "Repasse", value: Math.max(0, repasse), display: moneyBr(repasse) },
  ].filter((b): b is VisualBar => Boolean(b));
  const bars = (pack.serie || [])
    .slice(-6)
    .map((p) => {
      const value = Math.max(0, num(p.receita) ?? 0);
      const label = String(p.label || "").slice(0, 7);
      if (!label) return null;
      return { label, value, display: moneyBr(value) };
    })
    .filter((b): b is VisualBar => Boolean(b));
  const rowOf = (
    item: { nome?: string; placa?: string; lucro?: number },
    tone: VisualRow["tone"]
  ): VisualRow => ({
    title: item.nome || item.placa || "Veículo",
    detail: item.placa ? `Placa ${item.placa}` : undefined,
    value: moneyBr(num(item.lucro) ?? 0),
    tone,
  });
  const rows = [
    ...(pack.top || []).slice(0, 3).map((v) => rowOf(v, "ok")),
    ...(pack.bottom || []).slice(0, 3).map((v) => rowOf(v, "warn")),
  ];
  const userid = num(pack.userid);
  const start = String(pack.start || "");
  const end = String(pack.end || "");
  const canExport =
    userid != null &&
    userid > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(start) &&
    /^\d{4}-\d{2}-\d{2}$/.test(end);
  return emptyBoard({
    kind: "locadora",
    title: "Rendimentos da locadora",
    org: org || pack.empresa,
    subtitle: [
      pack.periodo || "",
      pack.veiculos != null ? `${pack.veiculos} veículos` : "",
      pack.alugados != null ? `${pack.alugados} alugados` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    kpis,
    compare,
    compareTitle: "Resultado do mês",
    bars,
    barsTitle: bars.length ? "Receita por mês" : undefined,
    rows,
    rowsTitle: rows.length ? "Destaques da frota" : undefined,
    note: "Mesmos números da tela Rendimentos da frota. Baixe o PDF, o PDF contábil ou o Excel aqui embaixo. O link vale 24 horas.",
    links: [
      {
        label: "Mais detalhes no sistema",
        href: "https://frotas.moope.com.br/viewlocrend",
      },
    ],
    downloads: canExport
      ? [
          { kind: "pdf", label: "PDF da frota" },
          { kind: "contabil", label: "PDF contábil" },
          { kind: "executivo", label: "PDF executivo" },
          { kind: "xlsx", label: "Excel" },
        ]
      : undefined,
    exportRef: canExport ? { userid: userid!, start, end } : undefined,
  });
}

function dataBr(v: unknown): string {
  const t = String(v || "").trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(t)) return t;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : "";
}

function placasTxt(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map((p) => String(p || "").trim()).filter(Boolean).join(", ");
  return String(raw || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ");
}

function placasCurta(full: string): string {
  const parts = full.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 3) return parts.join(", ") || "—";
  return `${parts.slice(0, 3).join(", ")} +${parts.length - 3}`;
}

function moneyOr(n: number): string {
  return n > 0 ? moneyBr(n) : "";
}

function fichaLocatario(item: {
  nome?: string;
  documento?: string;
  email?: string;
  telefone?: string;
  whatsapp?: string;
  deve?: string;
  proxima?: string;
  placas?: string[] | string;
  contratos?: number;
  contratos_cod?: string;
  situacao?: string;
  faturas?: string;
  parcela?: number | null;
  semana_valor?: number | null;
  mes_valor?: number | null;
  pago_valor?: number | null;
  vencer_valor?: number | null;
  href?: string;
}): Record<string, string> {
  const nome = String(item.nome || "").trim();
  const placas = placasTxt(item.placas);
  const contratos = Number(item.contratos || 0);
  const situacao = String(item.situacao || "Em dia");
  const parcela = num(item.parcela);
  const semanaValor = num(item.semana_valor) ?? 0;
  const mesValor = num(item.mes_valor) ?? num(item.vencer_valor) ?? 0;
  const pagoValor = num(item.pago_valor) ?? 0;
  return {
    papel: "locatario",
    nome,
    documento: String(item.documento || "").trim(),
    email: String(item.email || "").trim(),
    telefone: String(item.telefone || "").trim(),
    telefone_href: String(item.whatsapp || "").trim(),
    placas: placas || (contratos > 0 ? "Contrato ativo sem veículo vinculado" : ""),
    contratos: String(item.contratos_cod || "").trim() || (contratos ? String(contratos) : ""),
    faturas: String(item.faturas || "").trim() || situacao,
    parcela: parcela != null && parcela > 0 ? moneyBr(parcela) : "",
    semana: moneyOr(semanaValor),
    mes: moneyOr(mesValor),
    pago: moneyOr(pagoValor),
    deve: String(item.deve || "").trim(),
    proxima: String(item.proxima || "").trim(),
    situacao,
    ativo: contratos > 0 ? "Contrato ativo" : "",
    href: String(item.href || "").trim(),
  };
}

function fichaVeiculo(
  item: {
    placa?: string;
    modelo?: string;
    situacao?: string;
    local?: string;
    mapa?: string;
    motorista?: string;
    motorista_href?: string;
    contrato?: string;
    locatario?: string;
  },
  locatarioNome: string
): Record<string, string> {
  const placa = String(item.placa || "").trim();
  return {
    papel: "veiculo",
    nome: placa,
    modelo: String(item.modelo || "").trim() || "—",
    locatario: String(item.locatario || locatarioNome || "").trim(),
    motorista: String(item.motorista || "").trim(),
    motorista_href: String(item.motorista_href || "").trim(),
    contratos: String(item.contrato || "").trim(),
    situacao: String(item.situacao || "Alugado"),
    local: String(item.local || "").trim(),
    mapa: String(item.mapa || "").trim(),
  };
}

export type InvestidoresPack = {
  qtd?: number;
  veiculos?: number;
  soma_ultimos?: number;
  soma_ano?: number;
  pagos?: number;
  abertos?: number;
  sem_repasse?: number;
  busca?: string;
  itens?: Array<{
    id?: number;
    nome?: string;
    documento?: string;
    email?: string;
    placas?: string[];
    qtd_placas?: number;
    ultimo_valor?: number | null;
    ultimo_data?: string;
    ano?: number | null;
    situacao?: string;
    href?: string;
  }>;
};

export type LocatariosPack = {
  qtd?: number;
  em_dia?: number;
  em_atraso?: number;
  total_atraso?: number;
  total_semana?: number;
  total_mes?: number;
  total_pago?: number;
  total_vencer?: number;
  busca?: string;
  itens?: Array<{
    id?: number;
    nome?: string;
    documento?: string;
    email?: string;
    telefone?: string;
    whatsapp?: string;
    deve?: string;
    proxima?: string;
    placas?: string[];
    veiculos?: Array<{
      placa?: string;
      modelo?: string;
      situacao?: string;
      local?: string;
      mapa?: string;
      motorista?: string;
      motorista_href?: string;
      contrato?: string;
    }>;
    contratos?: number;
    contratos_cod?: string;
    situacao?: string;
    faturas?: string;
    parcela?: number | null;
    atraso_valor?: number | null;
    semana_valor?: number | null;
    mes_valor?: number | null;
    pago_valor?: number | null;
    vencer_valor?: number | null;
    href?: string;
  }>;
};

export type VeiculosPack = {
  qtd?: number;
  alugados?: number;
  disponiveis?: number;
  manutencao?: number;
  busca?: string;
  itens?: Array<{
    id?: number;
    placa?: string;
    modelo?: string;
    locatario?: string;
    contrato?: string;
    situacao?: string;
    local?: string;
    mapa?: string;
    motorista?: string;
    motorista_href?: string;
    locatario_href?: string;
    locatario_ficha?: {
      nome?: string;
      documento?: string;
      email?: string;
      telefone?: string;
      whatsapp?: string;
      deve?: string;
      proxima?: string;
      placas?: string[];
      contratos?: number;
      contratos_cod?: string;
      situacao?: string;
      faturas?: string;
      parcela?: number | null;
      semana_valor?: number | null;
      mes_valor?: number | null;
      pago_valor?: number | null;
      href?: string;
    };
  }>;
};

export function boardFromInvestidores(
  pack: InvestidoresPack,
  org?: string
): VisualBoardPayload {
  const itens = Array.isArray(pack.itens) ? pack.itens : [];
  const rows = itens.flatMap((item) => {
    const nome = String(item.nome || "").trim();
    if (!nome) return [];
    const placas = placasTxt(item.placas);
    const valor = item.ultimo_valor == null ? null : num(item.ultimo_valor);
    const pago = valor != null && valor > 0;
    const data = pago ? dataBr(item.ultimo_data) : "";
    const ano = num(item.ano);
    const situacao = pago
      ? String(item.situacao || "Pago")
      : String(item.situacao || "") === "Em aberto"
        ? "Em aberto"
        : "Sem repasse";
    const documento = String(item.documento || "").trim();
    return [
      {
        cells: {
          nome,
          placas: placasCurta(placas),
          valor: pago ? moneyBr(valor) : "Sem repasse",
          data: data || "—",
          situacao,
          doc: documento || "—",
        },
        nums: { valor: pago ? valor : -1 },
        ficha: {
          nome,
          documento,
          placas: placas || "Sem placa ativa",
          ultimo: pago ? moneyBr(valor) : "Sem repasse",
          data: data || "—",
          ano: ano != null && ano > 0 ? moneyBr(ano) : "Nenhum neste ano",
          situacao,
          email: String(item.email || "").trim(),
          href: String(item.href || "").trim(),
        },
      },
    ];
  });
  const qtd = pack.qtd ?? rows.length;
  const veiculos = pack.veiculos ?? 0;
  const soma = num(pack.soma_ultimos);
  const ano = num(pack.soma_ano);
  const kpis: VisualBoardPayload["kpis"] = [
    { label: "Com veículo", value: String(qtd) },
    { label: "Veículos", value: String(veiculos) },
    {
      label: "Último repasse",
      value: soma != null && soma > 0 ? moneyBr(soma) : "Nenhum",
      tone: soma != null && soma > 0 ? "ok" : "muted",
    },
    {
      label: "No ano",
      value: ano != null && ano > 0 ? moneyBr(ano) : "Nenhum",
      tone: ano != null && ano > 0 ? "ok" : "muted",
    },
  ];
  const busca = String(pack.busca || "").trim();
  return emptyBoard({
    kind: "locadora",
    title: "Investidores",
    org,
    subtitle: busca
      ? `${qtd} para “${busca}” · ${veiculos} veículos`
      : `${qtd} com veículo · ${veiculos} placas`,
    kpis,
    table: {
      search: "Nome, placa, CPF ou e-mail",
      title: "Investidores",
      layout: "cards",
      columns: [
        { key: "nome", label: "Nome", sort: "text" },
        { key: "placas", label: "Placas", sort: "text" },
        { key: "valor", label: "Último repasse", sort: "number" },
        { key: "data", label: "Data", sort: "text" },
        { key: "situacao", label: "Situação", sort: "text" },
        { key: "doc", label: "Documento", sort: "text" },
      ],
      rows,
    },
    note: "Só entra quem tem veículo ativo. Toque no CPF ou CNPJ para abrir a ficha. Repasse zerado conta como sem repasse. O link vale 24 horas.",
    links: [
      {
        label: "Acessar MOOPE Frotas",
        href: "https://frotas.moope.com.br/repasseinvestidores",
      },
    ],
  });
}

export function boardFromLocatarios(
  pack: LocatariosPack,
  org?: string
): VisualBoardPayload {
  const itens = Array.isArray(pack.itens) ? pack.itens : [];
  const rows = itens.flatMap((item) => {
    const nome = String(item.nome || "").trim();
    if (!nome) return [];
    const placas = placasTxt(item.placas);
    const situacao = String(item.situacao || "Em dia");
    const documento = String(item.documento || "").trim();
    const faturas = String(item.faturas || "").trim();
    const contratos = Number(item.contratos || 0);
    const atrasoValor = num(item.atraso_valor) ?? 0;
    const semanaValor = num(item.semana_valor) ?? 0;
    const mesValor = num(item.mes_valor) ?? num(item.vencer_valor) ?? 0;
    const pagoValor = num(item.pago_valor) ?? 0;
    const ficha = fichaLocatario({ ...item, nome, situacao });
    const porPlaca = new Map(
      (Array.isArray(item.veiculos) ? item.veiculos : []).map((v) => [
        String(v.placa || "").trim().toUpperCase(),
        v,
      ])
    );
    const related = placas
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((placa) => fichaVeiculo({ ...(porPlaca.get(placa.toUpperCase()) || {}), placa }, nome));
    return [
      {
        cells: {
          nome,
          placas: placasCurta(placas),
          valor: faturas || situacao,
          data: contratos ? `${contratos} contrato${contratos === 1 ? "" : "s"}` : "—",
          situacao,
          doc: documento || "—",
        },
        nums: {
          valor: atrasoValor > 0 ? atrasoValor : semanaValor > 0 ? semanaValor : mesValor > 0 ? mesValor : pagoValor,
        },
        ficha,
        related,
      },
    ];
  });
  const qtd = pack.qtd ?? rows.length;
  const emDia = pack.em_dia ?? 0;
  const totalAtraso = num(pack.total_atraso) ?? 0;
  const totalSemana = num(pack.total_semana) ?? 0;
  const totalMes = num(pack.total_mes) ?? num(pack.total_vencer) ?? 0;
  const totalPago = num(pack.total_pago) ?? 0;
  const moneyKpi = (n: number, tone: "warn" | "ok" | "muted") =>
    n > 0 ? { value: moneyBr(n), tone } : { value: "Nenhum", tone: "muted" as const };
  const busca = String(pack.busca || "").trim();
  return emptyBoard({
    kind: "locadora",
    title: "Locatários",
    org,
    subtitle: busca
      ? `${qtd} para “${busca}”`
      : `${qtd} com contrato ativo · ${emDia} em dia`,
    kpis: [
      { label: "Em atraso", ...moneyKpi(totalAtraso, "warn") },
      { label: "Na semana", ...moneyKpi(totalSemana, "ok") },
      { label: "No mês", ...moneyKpi(totalMes, "ok") },
      { label: "Pago no mês", ...moneyKpi(totalPago, "ok") },
    ],
    table: {
      search: "Nome, placa, CPF ou CNPJ",
      title: "Locatários",
      layout: "cards",
      columns: [
        { key: "nome", label: "Nome", sort: "text" },
        { key: "placas", label: "Placas", sort: "text" },
        { key: "valor", label: "Faturas", sort: "text" },
        { key: "data", label: "Contratos", sort: "text" },
        { key: "situacao", label: "Situação", sort: "text" },
        { key: "doc", label: "Documento", sort: "text" },
      ],
      rows,
    },
    note: "Toque no nome ou em Abrir ficha. A placa abre o carro neste painel. Atraso, semana e mês só entram boletos ativos. O link vale 24 horas.",
    links: [
      {
        label: "Acessar MOOPE Frotas",
        href: "https://frotas.moope.com.br/gerenciarlocatarios",
      },
    ],
  });
}

function postoStatus(situacao: string) {
  if (situacao === "Em manutenção") return 4;
  if (situacao === "Alugado") return 3;
  if (situacao === "Reservado") return 2;
  return 1;
}

export function boardFromVeiculos(pack: VeiculosPack, org?: string): VisualBoardPayload {
  const itens = Array.isArray(pack.itens) ? pack.itens : [];
  const rows = itens.flatMap((item) => {
    const placa = String(item.placa || "").trim();
    if (!placa) return [];
    const situacao = String(item.situacao || "Ativo");
    const locatario = String(item.locatario || "").trim();
    const modelo = String(item.modelo || "").trim();
    const pessoa = item.locatario_ficha?.nome
      ? fichaLocatario({
          ...item.locatario_ficha,
          placas: item.locatario_ficha.placas?.length
            ? item.locatario_ficha.placas
            : placa
              ? [placa]
              : [],
        })
      : null;
    const related = [
      ...(pessoa ? [pessoa] : []),
      fichaVeiculo(
        {
          placa,
          modelo,
          situacao,
          local: String(item.local || "").trim(),
          mapa: String(item.mapa || "").trim(),
          motorista: String(item.motorista || "").trim(),
          motorista_href: String(item.motorista_href || "").trim(),
          contrato: String(item.contrato || "").trim(),
          locatario,
        },
        locatario
      ),
    ];
    return [
      {
        cells: {
          nome: placa,
          placas: locatario || "Sem locatário",
          valor: situacao,
          data: modelo || "—",
          situacao,
          doc: pessoa?.documento || "—",
        },
        nums: { valor: postoStatus(situacao) },
        ficha: {
          papel: "veiculo",
          nome: placa,
          modelo: modelo || "—",
          locatario: locatario || "Sem locatário no contrato ativo",
          motorista: String(item.motorista || "").trim(),
          motorista_href: String(item.motorista_href || "").trim(),
          contratos: String(item.contrato || "").trim(),
          situacao,
          local: String(item.local || "").trim(),
          mapa: String(item.mapa || "").trim(),
        },
        related,
      },
    ];
  });
  const qtd = pack.qtd ?? rows.length;
  const alugados = pack.alugados ?? 0;
  const disponiveis = pack.disponiveis ?? 0;
  const manutencao = pack.manutencao ?? 0;
  const busca = String(pack.busca || "").trim();
  return emptyBoard({
    kind: "locadora",
    title: "Veículos",
    org,
    subtitle: busca ? `${qtd} para “${busca}”` : `${qtd} ativos`,
    kpis: [
      { label: "Ativos", value: String(qtd) },
      { label: "Alugados", value: String(alugados), tone: "ok" },
      { label: "Disponíveis", value: String(disponiveis) },
      {
        label: "Manutenção",
        value: String(manutencao),
        tone: manutencao > 0 ? "warn" : "muted",
      },
    ],
    table: {
      search: "Placa, modelo ou locatário",
      title: "Veículos",
      layout: "cards",
      columns: [
        { key: "nome", label: "Placa", sort: "text" },
        { key: "placas", label: "Locatário", sort: "text" },
        { key: "valor", label: "Status", sort: "number" },
        { key: "data", label: "Veículo", sort: "text" },
        { key: "situacao", label: "Situação", sort: "text" },
      ],
      rows,
    },
    note: "Só entram veículos ativos. Toque no locatário para abrir a ficha dele neste painel, com o que ele deve e a próxima parcela. O endereço é a última posição do rastreador. O link vale 24 horas.",
    links: [
      {
        label: "Acessar MOOPE Frotas",
        href: "https://frotas.moope.com.br/veiculos",
      },
    ],
  });
}

