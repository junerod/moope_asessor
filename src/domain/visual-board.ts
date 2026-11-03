/**
 * Página HTML no celular: um token por consulta, some em 24 horas.
 * O PDF/Excel do relatório não passa por aqui — esses arquivos vão direto ao WhatsApp.
 */
import { randomBytes } from "crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import { visualBoards } from "@/db/schema";
import { logger } from "@/lib/logger";
import { publicAppBaseUrl } from "@/lib/public-url";

export type BoardTone = "ok" | "warn" | "muted";

export type VisualKpi = { label: string; value: string; tone?: BoardTone };
export type VisualBar = { label: string; value: number; display: string };
export type VisualRow = {
  title: string;
  detail?: string;
  value?: string;
  tone?: BoardTone;
  /** Link do boleto desta linha. Abre em outra página. */
  href?: string;
  hrefLabel?: string;
};
export type VisualAlert = { title: string; detail?: string };
export type VisualFicha = Record<string, string>;

export type VisualTable = {
  search: string;
  title?: string;
  /** cards = lista com busca, feita para o celular. */
  layout?: "table" | "cards";
  columns: { key: string; label: string; sort?: "text" | "number" }[];
  rows: {
    cells: Record<string, string>;
    nums?: Record<string, number>;
    ficha?: VisualFicha;
    /** Outra ficha que este card abre no mesmo painel (carro ou locatário). */
    related?: VisualFicha[];
  }[];
};

export type VisualBoardPayload = {
  kind: "pessoal" | "locadora" | "facejus" | "geral" | "dev";
  title: string;
  subtitle?: string;
  org?: string;
  kpis: VisualKpi[];
  /** Barras de quantidade (frota, categorias). */
  bars: VisualBar[];
  barsTitle?: string;
  /** Segunda escala, em geral dinheiro (este mês × passado). */
  compare?: VisualBar[];
  compareTitle?: string;
  /** Fatias do gráfico de rosca. */
  donut?: VisualBar[];
  donutTitle?: string;
  rows: VisualRow[];
  rowsTitle?: string;
  table?: VisualTable;
  alerts: VisualAlert[];
  note?: string;
  /** Atalho para o sistema, aberto no painel. */
  links?: { label: string; href: string }[];
  /** Arquivos da mesma consulta. O token da página autoriza o download. */
  downloads?: { kind: string; label: string }[];
  /** Só no servidor: período e conta para gerar o arquivo. */
  exportRef?: { userid: number; start: string; end: string };
  /** Só no servidor. A página não recebe o telefone. */
  live?: {
    source: "facejus";
    modo: "processos" | "agenda";
    tenantId: number;
    phone: string;
    dia?: string;
    natureza?: "processual" | "administrativo" | null;
    escritorioId?: number | null;
  };
};

const TTL_MS = 24 * 60 * 60 * 1000;

function clip(raw: string, max: number): string {
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function asTone(v: unknown): BoardTone | undefined {
  return v === "ok" || v === "warn" || v === "muted" ? v : undefined;
}

function safeHref(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(t) || t.length > 400) return undefined;
  return t;
}

export function emptyBoard(
  partial: Pick<VisualBoardPayload, "kind" | "title"> &
    Partial<VisualBoardPayload>
): VisualBoardPayload {
  return {
    kind: partial.kind,
    title: clip(partial.title || "Painel", 80),
    subtitle: partial.subtitle ? clip(partial.subtitle, 120) : undefined,
    org: partial.org ? clip(partial.org, 80) : undefined,
    kpis: partial.kpis || [],
    bars: partial.bars || [],
    barsTitle: partial.barsTitle ? clip(partial.barsTitle, 40) : undefined,
    compare: partial.compare || [],
    compareTitle: partial.compareTitle ? clip(partial.compareTitle, 40) : undefined,
    donut: partial.donut || [],
    donutTitle: partial.donutTitle ? clip(partial.donutTitle, 40) : undefined,
    rows: partial.rows || [],
    rowsTitle: partial.rowsTitle ? clip(partial.rowsTitle, 40) : undefined,
    table: partial.table,
    alerts: partial.alerts || [],
    note: partial.note ? clip(partial.note, 520) : undefined,
    links: partial.links,
    downloads: partial.downloads,
    exportRef: partial.exportRef,
  };
}

function stripMark(line: string): string {
  return line
    .replace(/\*/g, "")
    .replace(/^[-•]\s*/, "")
    .replace(/^(?:\p{Extended_Pictographic}\uFE0F?\s*)+/u, "")
    .trim();
}

/** Lê o texto do WhatsApp e separa números, alertas e lista. */
export function boardFromReply(input: {
  kind: VisualBoardPayload["kind"];
  title: string;
  org?: string;
  text: string;
}): VisualBoardPayload {
  const lines = input.text
    .split("\n")
    .map(stripMark)
    .filter((l) => l && !/^_/.test(l));

  const kpis: VisualKpi[] = [];
  const alerts: VisualAlert[] = [];
  const rows: VisualRow[] = [];

  for (const line of lines) {
    if (kpis.length + alerts.length + rows.length > 40) break;
    if (/^(ver no celular|abra no celular)/i.test(line)) continue;
    if (/fora .{0,12}\d+\s*h|alerta|inadimpl|a vencer|atenção|em atraso/i.test(line)) {
      if (alerts.length < 8) alerts.push({ title: clip(line, 140) });
      continue;
    }
    const kv = line.match(/^(.{2,32}?)\s*[:–—]\s*(.{1,28})$/);
    if (kv && kpis.length < 6 && !/https?:/i.test(line)) {
      const value = kv[2].trim();
      const tone: BoardTone | undefined = /manuten|multa|sinistro|inadimpl|alerta|aberto/i.test(
        kv[1]
      )
        ? "warn"
        : undefined;
      kpis.push({ label: clip(kv[1], 32), value: clip(value, 28), tone });
      continue;
    }
    if (rows.length < 18) {
      rows.push({ title: clip(line, 140) });
    }
  }

  const numeric = kpis
    .map((k) => {
      const m = k.value.replace(/\./g, "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
      if (!m || /r\$/i.test(k.value)) return null;
      const value = Number(m[0]);
      if (!Number.isFinite(value) || value < 0 || value > 100000) return null;
      return { label: k.label, value, display: k.value };
    })
    .filter((b): b is VisualBar => Boolean(b));

  const bars =
    numeric.length >= 2 && numeric.length === kpis.filter((k) => !/r\$/i.test(k.value)).length
      ? numeric.slice(0, 6)
      : [];

  return emptyBoard({
    kind: input.kind,
    title: input.title,
    org: input.org,
    subtitle: "Aberto a partir do WhatsApp",
    kpis,
    bars,
    rows,
    alerts,
    note: "Só os números desta consulta. O link vale 24 horas e não abre dados de outra pessoa.",
  });
}

export function sanitizeBoard(raw: unknown): VisualBoardPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind =
    o.kind === "pessoal" ||
    o.kind === "locadora" ||
    o.kind === "facejus" ||
    o.kind === "geral" ||
    o.kind === "dev"
      ? o.kind
      : null;
  if (!kind || typeof o.title !== "string") return null;
  const kpis = Array.isArray(o.kpis)
    ? o.kpis.slice(0, 8).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const k = item as Record<string, unknown>;
        if (typeof k.label !== "string" || typeof k.value !== "string") return [];
        return [
          {
            label: clip(k.label, 40),
            value: clip(k.value, 40),
            tone: asTone(k.tone),
          },
        ];
      })
    : [];
  const readBars = (raw: unknown, max: number): VisualBar[] =>
    Array.isArray(raw)
      ? raw.slice(0, max).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const b = item as Record<string, unknown>;
          const value = Number(b.value);
          if (typeof b.label !== "string" || typeof b.display !== "string") return [];
          if (!Number.isFinite(value) || value < 0) return [];
          return [{ label: clip(b.label, 40), value, display: clip(b.display, 40) }];
        })
      : [];
  const bars = readBars(o.bars, 8);
  const compare = readBars(o.compare, 4);
  const donut = readBars(o.donut, 6);
  const rows = Array.isArray(o.rows)
    ? o.rows.slice(0, 24).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const r = item as Record<string, unknown>;
        if (typeof r.title !== "string") return [];
        const href = safeHref(r.href);
        return [
          {
            title: clip(r.title, 160),
            detail: typeof r.detail === "string" ? clip(r.detail, 160) : undefined,
            value: typeof r.value === "string" ? clip(r.value, 40) : undefined,
            tone: asTone(r.tone),
            href,
            hrefLabel:
              href && typeof r.hrefLabel === "string"
                ? clip(r.hrefLabel, 40)
                : undefined,
          },
        ];
      })
    : [];
  const alerts = Array.isArray(o.alerts)
    ? o.alerts.slice(0, 8).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const a = item as Record<string, unknown>;
        if (typeof a.title !== "string") return [];
        return [
          {
            title: clip(a.title, 160),
            detail: typeof a.detail === "string" ? clip(a.detail, 520) : undefined,
          },
        ];
      })
    : [];
  return emptyBoard({
    kind,
    title: o.title,
    subtitle: typeof o.subtitle === "string" ? o.subtitle : undefined,
    org: typeof o.org === "string" ? o.org : undefined,
    kpis,
    bars,
    barsTitle: typeof o.barsTitle === "string" ? o.barsTitle : undefined,
    compare,
    compareTitle: typeof o.compareTitle === "string" ? o.compareTitle : undefined,
    donut,
    donutTitle: typeof o.donutTitle === "string" ? o.donutTitle : undefined,
    rows,
    rowsTitle: typeof o.rowsTitle === "string" ? o.rowsTitle : undefined,
    table: readTable(o.table),
    alerts,
    note: typeof o.note === "string" ? o.note : undefined,
    links: Array.isArray(o.links)
      ? o.links.slice(0, 3).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const l = item as Record<string, unknown>;
          const href = safeHref(l.href);
          if (!href || typeof l.label !== "string") return [];
          return [{ label: clip(l.label, 40), href }];
        })
      : undefined,
    downloads: Array.isArray(o.downloads)
      ? o.downloads.slice(0, 4).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const d = item as Record<string, unknown>;
          if (typeof d.kind !== "string" || typeof d.label !== "string") return [];
          if (!["pdf", "contabil", "xlsx", "executivo"].includes(d.kind)) return [];
          return [{ kind: d.kind, label: clip(d.label, 40) }];
        })
      : undefined,
    exportRef: readExportRef(o.exportRef),
  });
}

function readTable(raw: unknown): VisualTable | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  const columns: VisualTable["columns"] = Array.isArray(t.columns)
    ? t.columns.slice(0, 6).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const c = item as Record<string, unknown>;
        if (typeof c.key !== "string" || typeof c.label !== "string") return [];
        const sort = c.sort === "text" || c.sort === "number" ? c.sort : undefined;
        return [{ key: clip(c.key, 24), label: clip(c.label, 24), sort }];
      })
    : [];
  if (!columns.length) return undefined;
  const keys = new Set(columns.map((c) => c.key));
  const rows = Array.isArray(t.rows)
    ? t.rows.slice(0, 400).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const r = item as Record<string, unknown>;
        const src = r.cells;
        if (!src || typeof src !== "object") return [];
        const cells: Record<string, string> = {};
        for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
          if (!keys.has(k) || typeof v !== "string") continue;
          cells[k] = clip(v, 120);
        }
        if (!Object.keys(cells).length) return [];
        const nums: Record<string, number> = {};
        if (r.nums && typeof r.nums === "object") {
          for (const [k, v] of Object.entries(r.nums as Record<string, unknown>)) {
            const n = Number(v);
            if (keys.has(k) && Number.isFinite(n)) nums[k] = n;
          }
        }
        const ficha = readFicha(r.ficha);
        const related = Array.isArray(r.related)
          ? r.related.slice(0, 12).flatMap((item) => {
              const outra = readFicha(item);
              return outra ? [outra] : [];
            })
          : undefined;
        return [{
          cells,
          nums: Object.keys(nums).length ? nums : undefined,
          ficha,
          related: related?.length ? related : undefined,
        }];
      })
    : [];
  const layout = t.layout === "cards" || t.layout === "table" ? t.layout : undefined;
  return {
    search: typeof t.search === "string" ? clip(t.search, 48) : "Buscar",
    title: typeof t.title === "string" ? clip(t.title, 40) : undefined,
    layout,
    columns,
    rows,
  };
}

const FICHA_KEYS = [
  "nome",
  "documento",
  "placas",
  "ultimo",
  "data",
  "ano",
  "situacao",
  "contratos",
  "faturas",
  "parcela",
  "email",
  "locatario",
  "modelo",
  "local",
  "semana",
  "mes",
  "pago",
  "deve",
  "proxima",
  "telefone",
  "telefone_href",
  "mapa",
  "papel",
  "partes",
  "area",
  "filial",
  "ativo",
  "locatario_href",
  "motorista_href",
  "motorista",
  "href",
];

function readFicha(raw: unknown): VisualFicha | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  const ficha: VisualFicha = {};
  for (const key of FICHA_KEYS) {
    const v = src[key];
    if (typeof v !== "string" || !v.trim()) continue;
    if (key === "href" || key === "mapa" || key === "locatario_href" || key === "motorista_href" || key === "telefone_href") {
      const href = safeHref(v);
      if (href) ficha[key] = href;
      continue;
    }
    ficha[key] = clip(v, key === "placas" || key === "email" || key === "local" ? 500 : 160);
  }
  return Object.keys(ficha).length ? ficha : undefined;
}

function readExportRef(raw: unknown): VisualBoardPayload["exportRef"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const userid = Number(r.userid);
  const start = typeof r.start === "string" ? r.start.slice(0, 10) : "";
  const end = typeof r.end === "string" ? r.end.slice(0, 10) : "";
  if (!Number.isFinite(userid) || userid <= 0) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return undefined;
  }
  return { userid, start, end };
}

export async function createVisualBoard(
  db: Db,
  input: {
    workspaceId: string;
    userId?: string | null;
    payload: VisualBoardPayload;
  }
): Promise<string> {
  const token = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.delete(visualBoards).where(lt(visualBoards.expiresAt, new Date()));
  await db.insert(visualBoards).values({
    token,
    workspaceId: input.workspaceId,
    userId: input.userId || null,
    payload: input.payload as unknown as Record<string, unknown>,
    expiresAt,
  });
  return `${publicAppBaseUrl()}/v/${token}`;
}

export async function loadVisualBoard(
  db: Db,
  token: string
): Promise<VisualBoardPayload | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const row = await db.query.visualBoards.findFirst({
    where: and(eq(visualBoards.token, token)),
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(visualBoards).where(eq(visualBoards.id, row.id));
    return null;
  }
  return sanitizeBoard(row.payload);
}

export type FacejusLiveRef = NonNullable<VisualBoardPayload["live"]>;

export function readLiveRef(raw: unknown): FacejusLiveRef | null {
  if (!raw || typeof raw !== "object") return null;
  const live = (raw as { live?: unknown }).live;
  if (!live || typeof live !== "object") return null;
  const item = live as Record<string, unknown>;
  if (item.source !== "facejus") return null;
  if (item.modo !== "processos" && item.modo !== "agenda") return null;
  const tenantId = Number(item.tenantId);
  const phone = typeof item.phone === "string" ? item.phone : "";
  if (!Number.isFinite(tenantId) || tenantId <= 0 || phone.replace(/\D/g, "").length < 10) return null;
  const natureza =
    item.natureza === "processual" || item.natureza === "administrativo" ? item.natureza : null;
  const escritorioId = Number(item.escritorioId);
  return {
    source: "facejus",
    modo: item.modo,
    tenantId,
    phone,
    dia: typeof item.dia === "string" ? item.dia.slice(0, 10) : undefined,
    natureza,
    escritorioId: Number.isFinite(escritorioId) && escritorioId > 0 ? escritorioId : null,
  };
}

async function visualBoardRow(db: Db, token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const row = await db.query.visualBoards.findFirst({
    where: and(eq(visualBoards.token, token)),
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(visualBoards).where(eq(visualBoards.id, row.id));
    return null;
  }
  return row;
}

export async function readFacejusLive(db: Db, token: string): Promise<FacejusLiveRef | null> {
  const row = await visualBoardRow(db, token);
  return row ? readLiveRef(row.payload) : null;
}

export async function openVisualBoard(
  db: Db,
  token: string
): Promise<{
  board: VisualBoardPayload | null;
  facejus: {
    modo: "processos" | "agenda";
    dia?: string;
    natureza?: "processual" | "administrativo" | null;
  } | null;
}> {
  const row = await visualBoardRow(db, token);
  if (!row) return { board: null, facejus: null };
  const live = readLiveRef(row.payload);
  return {
    board: sanitizeBoard(row.payload),
    facejus: live
      ? { modo: live.modo, dia: live.dia, natureza: live.natureza }
      : null,
  };
}

export function visualBoardFooter(url: string): string {
  return `📊 *Ver no celular*\n${url}\n_Link só desta consulta. Vale 24 horas. Outra pessoa não abre._`;
}

export async function appendVisualBoard(
  ctx: { db: Db; workspaceId: string; userId: string },
  summary: string,
  payload: VisualBoardPayload
): Promise<string> {
  try {
    const url = await createVisualBoard(ctx.db, {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      payload,
    });
    const foot = visualBoardFooter(url);
    const base = summary
      .split(/📊 \*Ver no celular\*/)[0]
      .split("\n")
      .map((line) =>
        line.replace(/https?:\/\/(www\.)?frotas\.moope\.com\.br\S*/gi, "").trim()
      )
      .filter((line) => {
        if (!line || /^[_*\s.:\-–—]+$/.test(line)) return false;
        const words = line
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
        if (words === "painel" || words === "ver") return false;
        if (/o que o assessor pode fazer/.test(words)) return false;
        if (/peca .* para ver tudo/.test(words)) return false;
        return true;
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return base ? `${base}\n\n${foot}` : foot;
  } catch (err) {
    logger.warn("visual_board_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return summary;
  }
}
