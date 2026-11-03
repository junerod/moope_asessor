import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { emptyBoard, type VisualBoardPayload } from "@/domain/visual-board";

/** Preço público gpt-4o-mini, set/2026: US$ por 1 milhão de tokens. Sem desconto de cache. */
const USD_PER_MILLION_INPUT = 0.15;
const USD_PER_MILLION_OUTPUT = 0.6;
/** Câmbio de referência para o Zap. Não é cotação do dia. */
const BRL_PER_USD = 5.4;
/** Acima disto no mês, o relatório pede para olhar cobrança de uso. */
const FOLGA_BRL = 30;

type Conta = {
  tipo: string;
  nome: string;
  inTok: number;
  outTok: number;
  msgs: number;
};

function asRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown[] })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function usd(inTok: number, outTok: number): number {
  return (
    (inTok / 1_000_000) * USD_PER_MILLION_INPUT +
    (outTok / 1_000_000) * USD_PER_MILLION_OUTPUT
  );
}

function moneyBrl(n: number): string {
  const sign = n < 0 ? "-" : "";
  const [i, d] = Math.abs(n).toFixed(2).split(".");
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}R$ ${grouped},${d}`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${(v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(".", ",")} mi`;
  }
  if (n >= 10_000) {
    const mil = Math.round((n / 1000) * 10) / 10;
    const text = Number.isInteger(mil) ? String(mil) : mil.toFixed(1).replace(".", ",");
    return `${text} mil`;
  }
  return Math.round(n).toLocaleString("pt-BR");
}

export type AiConsumoDia = { dia: string; label: string; inTok: number; outTok: number };

export type AiConsumoSnapshot = {
  titulo: string;
  subtitulo: string;
  gastoBrl: number;
  ritmoBrl: number;
  inTok: number;
  outTok: number;
  veredito: string;
  detalhe: string;
  dias: AiConsumoDia[];
  linhas: { title: string; value: string }[];
};

function saoPauloDay(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shiftDay(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function labelDia(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

export async function loadAiConsumo(db: Db, now = new Date()): Promise<AiConsumoSnapshot> {
  const hoje = saoPauloDay(now);
  const inicio = shiftDay(hoje, -6);
  const fimExclusivo = shiftDay(hoje, 1);
  const desde = `${inicio}T00:00:00-03:00`;
  const ate = `${fimExclusivo}T00:00:00-03:00`;

  const diaRaw = await db.execute(sql`
    SELECT to_char((started_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS dia,
           COALESCE(SUM(input_tokens), 0)::bigint AS in_tok,
           COALESCE(SUM(output_tokens), 0)::bigint AS out_tok
    FROM agent_runs
    WHERE model = 'gpt-4o-mini'
      AND started_at >= ${desde}::timestamptz
      AND started_at < ${ate}::timestamptz
    GROUP BY 1
    ORDER BY 1
  `);
  const porDia = new Map(
    asRows(diaRaw).map((r) => [
      String(r.dia).slice(0, 10),
      { inTok: num(r.in_tok), outTok: num(r.out_tok) },
    ])
  );
  const dias: AiConsumoDia[] = [];
  for (let i = 0; i < 7; i++) {
    const dia = shiftDay(inicio, i);
    const slot = porDia.get(dia) || { inTok: 0, outTok: 0 };
    dias.push({ dia, label: labelDia(dia), inTok: slot.inTok, outTok: slot.outTok });
  }

  const contasRaw = await db.execute(sql`
    SELECT COALESCE(NULLIF(u.usage_type, ''), 'sem tipo') AS tipo,
           w.name AS nome,
           COALESCE(SUM(ar.input_tokens), 0)::bigint AS in_tok,
           COALESCE(SUM(ar.output_tokens), 0)::bigint AS out_tok
    FROM agent_runs ar
    JOIN workspaces w ON w.id = ar.workspace_id AND w.deleted_at IS NULL
    JOIN users u ON u.id = w.owner_user_id
    WHERE ar.model = 'gpt-4o-mini'
      AND ar.started_at >= ${desde}::timestamptz
      AND ar.started_at < ${ate}::timestamptz
    GROUP BY 1, w.name
    ORDER BY in_tok DESC
  `);
  const contas: Conta[] = asRows(contasRaw).map((r) => ({
    tipo: String(r.tipo || "sem tipo"),
    nome: String(r.nome || "—"),
    inTok: num(r.in_tok),
    outTok: num(r.out_tok),
    msgs: 0,
  }));

  const inTok = dias.reduce((s, d) => s + d.inTok, 0);
  const outTok = dias.reduce((s, d) => s + d.outTok, 0);
  const gastoBrl = usd(inTok, outTok) * BRL_PER_USD;
  const ritmoBrl = gastoBrl * (30 / 7);
  const comUso = dias.filter((d) => d.inTok + d.outTok > 0);
  const ultimo = comUso[comUso.length - 1];
  const hojeVazio = (porDia.get(hoje)?.inTok || 0) + (porDia.get(hoje)?.outTok || 0) === 0;

  const pessoal = contas.filter((c) => c.tipo === "pessoal" && c.inTok + c.outTok > 0);
  const semOMaior = pessoal.slice(1);
  const base = semOMaior.length ? semOMaior : pessoal.slice(0, 1);
  const tipicoIn = base.length ? base.reduce((s, c) => s + c.inTok, 0) / base.length : 0;
  const tipicoOut = base.length ? base.reduce((s, c) => s + c.outTok, 0) / base.length : 0;
  const tipicoMesBrl = usd(tipicoIn, tipicoOut) * (30 / 7) * BRL_PER_USD;

  const titulo =
    inTok + outTok === 0
      ? "Sem chamada de IA nestes 7 dias"
      : ritmoBrl < FOLGA_BRL
        ? "A franquia de IA cabe neste mês"
        : ritmoBrl < 150
          ? "A franquia ainda cabe, o ritmo subiu"
          : "O ritmo de IA passou do confortável";
  const veredito =
    inTok + outTok === 0
      ? "Nenhuma chamada nestes 7 dias"
      : ritmoBrl < FOLGA_BRL
        ? "Não cobre o uso por causa de token"
        : ritmoBrl < 150
          ? "Ainda cabe, mas olhe de novo no fim do mês"
          : "O ritmo pede olhar a cobrança de uso";
  const detalhe =
    inTok + outTok === 0
      ? "Quando voltar a ter chamada no gpt-4o-mini, este painel mostra o gasto de 7 dias e o ritmo para 30."
      : `No ritmo desta semana o mês inteiro fica perto de ${moneyBrl(ritmoBrl)} de IA. R$ 9,90 no pessoal e R$ 19,90 no profissional são preço de produto: a IA de um cliente comum sai por cerca de ${moneyBrl(tipicoMesBrl)} no mês.`;

  const linhas = contas.slice(0, 5).map((c) => ({
    title: c.nome,
    value: `${tokens(c.inTok)} · ${moneyBrl(usd(c.inTok, c.outTok) * BRL_PER_USD)}`,
  }));

  return {
    titulo,
    subtitulo: [
      `Meu Assessor em produção, ${labelDia(inicio)} a ${labelDia(ultimo?.dia || hoje)}.`,
      "Modelo gpt-4o-mini.",
      hojeVazio && inTok + outTok > 0
        ? `O dia ${labelDia(hoje)} ainda não tinha chamada quando a conta foi fechada.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    gastoBrl,
    ritmoBrl,
    inTok,
    outTok,
    veredito,
    detalhe,
    dias,
    linhas,
  };
}

export function boardFromAiConsumo(s: AiConsumoSnapshot): VisualBoardPayload {
  return emptyBoard({
    kind: "dev",
    title: s.titulo,
    subtitle: s.subtitulo,
    org: "Consumo de IA",
    kpis: [
      { label: "Gasto medido em 7 dias", value: moneyBrl(s.gastoBrl), tone: "ok" },
      { label: "Ritmo para 30 dias", value: moneyBrl(s.ritmoBrl) },
      { label: "Tokens de entrada", value: tokens(s.inTok) },
      { label: "Tokens de saída", value: tokens(s.outTok) },
    ],
    bars: s.dias.map((d) => ({
      label: d.label,
      value: d.inTok,
      display: tokens(d.inTok),
    })),
    barsTitle: "Tokens de entrada por dia",
    alerts: [{ title: s.veredito, detail: s.detalhe }],
    rows: s.linhas.map((l) => ({ title: l.title, value: l.value })),
    rowsTitle: "Quem mais gasta",
    note: "Preço público do gpt-4o-mini, sem desconto de cache. Câmbio de referência R$ 5,40. Áudio, foto e embedding ficam de fora. O link vale 24 horas.",
  });
}

export function formatAiConsumoWhatsapp(s: AiConsumoSnapshot): string {
  return [
    "💰 *Consumo de IA*",
    "_gpt-4o-mini · últimos 7 dias · só o seu número_",
    "",
    `• Gasto medido: *${moneyBrl(s.gastoBrl)}*`,
    `• Ritmo para 30 dias: *${moneyBrl(s.ritmoBrl)}*`,
    `• Entrada: *${tokens(s.inTok)}* · Saída: *${tokens(s.outTok)}*`,
    "",
    s.titulo,
  ].join("\n");
}

export async function formatAiConsumoReport(db: Db): Promise<string> {
  return formatAiConsumoWhatsapp(await loadAiConsumo(db));
}

export async function buildAiConsumoBoard(db: Db): Promise<VisualBoardPayload> {
  return boardFromAiConsumo(await loadAiConsumo(db));
}
