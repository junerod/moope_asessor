/**
 * Relatório PDF visual (PDF 1.4) sem deps — cabeçalho colorido, KPIs, seções e tabela.
 * Texto em Latin1/WinAnsi aproximado (acentos viram forma ASCII segura no PDF).
 */

export type ReportKpi = { label: string; value: string };
export type ReportSection = {
  title: string;
  rows: string[];
};
export type ReportPdfInput = {
  brand?: string;
  title: string;
  subtitle?: string;
  generatedAt?: string;
  kpis?: ReportKpi[];
  sections?: ReportSection[];
  footerNote?: string;
};

function pdfSafe(raw: string): string {
  const s = String(raw || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
  return s.slice(0, 110);
}

function wrap(text: string, max = 88): string[] {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > max) {
      if (cur) lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

type Op = string;

function pageOps(input: ReportPdfInput, pageIndex: number, pageCount: number): string {
  const ops: Op[] = [];
  const brand = pdfSafe(input.brand || "Assessor MOOPE");
  const title = pdfSafe(input.title);
  const subtitle = pdfSafe(input.subtitle || "");
  const when = pdfSafe(
    input.generatedAt ||
      new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
  );

  // Header bar — teal/navy (nao roxo)
  ops.push("0.05 0.28 0.36 rg");
  ops.push("0 780 612 62 re f");
  ops.push("0.12 0.62 0.58 rg");
  ops.push("0 775 612 5 re f");

  ops.push("1 1 1 rg");
  ops.push(`BT /F1 11 Tf 36 812 Td (${brand}) Tj ET`);
  ops.push(`BT /F1 18 Tf 36 790 Td (${title}) Tj ET`);

  let y = 755;
  if (subtitle) {
    ops.push("0.25 0.32 0.38 rg");
    ops.push(`BT /F1 10 Tf 36 ${y} Td (${subtitle}) Tj ET`);
    y -= 16;
  }
  ops.push("0.45 0.5 0.55 rg");
  ops.push(`BT /F1 9 Tf 36 ${y} Td (Gerado em ${when}  |  pagina ${pageIndex}/${pageCount}) Tj ET`);
  y -= 22;

  // KPI cards
  const kpis = (input.kpis || []).slice(0, 4);
  if (kpis.length && pageIndex === 1) {
    const cardW = 130;
    const gap = 10;
    const startX = 36;
    kpis.forEach((k, i) => {
      const x = startX + i * (cardW + gap);
      ops.push("0.93 0.96 0.97 rg");
      ops.push(`${x} ${y - 48} ${cardW} 52 re f`);
      ops.push("0.12 0.62 0.58 rg");
      ops.push(`${x} ${y - 48} 4 52 re f`);
      ops.push("0.35 0.4 0.45 rg");
      ops.push(`BT /F1 8 Tf ${x + 12} ${y - 10} Td (${pdfSafe(k.label)}) Tj ET`);
      ops.push("0.08 0.18 0.24 rg");
      ops.push(`BT /F1 12 Tf ${x + 12} ${y - 30} Td (${pdfSafe(k.value)}) Tj ET`);
    });
    y -= 70;
  }

  const sections = input.sections || [];
  for (const sec of sections) {
    if (y < 90) break;
    ops.push("0.05 0.28 0.36 rg");
    ops.push(`BT /F1 12 Tf 36 ${y} Td (${pdfSafe(sec.title)}) Tj ET`);
    y -= 6;
    ops.push("0.12 0.62 0.58 rg");
    ops.push(`36 ${y} 540 1.5 re f`);
    y -= 16;

    for (const row of sec.rows) {
      for (const line of wrap(row, 92)) {
        if (y < 70) break;
        ops.push("0.2 0.24 0.28 rg");
        ops.push(`BT /F1 9 Tf 40 ${y} Td (${pdfSafe(line)}) Tj ET`);
        y -= 13;
      }
      y -= 2;
      if (y < 70) break;
    }
    y -= 10;
  }

  // Footer
  ops.push("0.9 0.92 0.94 rg");
  ops.push("0 0 612 42 re f");
  ops.push("0.4 0.45 0.5 rg");
  const foot = pdfSafe(
    input.footerNote ||
      "Assessor MOOPE  ·  WhatsApp  ·  moope.com.br  ·  Documento informativo"
  );
  ops.push(`BT /F1 8 Tf 36 18 Td (${foot}) Tj ET`);

  return ops.join("\n");
}

/**
 * Monta PDF multipágina a partir de seções (paginação simples por altura estimada).
 */
export function buildReportPdf(input: ReportPdfInput): Buffer {
  // Split sections into pages (~40 lines usable)
  const pages: ReportPdfInput[] = [];
  const base = {
    brand: input.brand,
    title: input.title,
    subtitle: input.subtitle,
    generatedAt: input.generatedAt,
    footerNote: input.footerNote,
  };

  const allRows: Array<{ title: string; row: string }> = [];
  for (const sec of input.sections || []) {
    if (!sec.rows.length) allRows.push({ title: sec.title, row: "(sem itens)" });
    for (const r of sec.rows) allRows.push({ title: sec.title, row: r });
  }

  if (!allRows.length) {
    pages.push({
      ...base,
      kpis: input.kpis,
      sections: [{ title: "Resumo", rows: ["Nenhum dado para listar neste periodo."] }],
    });
  } else {
    const perPage = 28;
    for (let i = 0; i < allRows.length; i += perPage) {
      const chunk = allRows.slice(i, i + perPage);
      const sectionMap = new Map<string, string[]>();
      for (const c of chunk) {
        if (!sectionMap.has(c.title)) sectionMap.set(c.title, []);
        sectionMap.get(c.title)!.push(c.row);
      }
      pages.push({
        ...base,
        kpis: i === 0 ? input.kpis : undefined,
        sections: [...sectionMap.entries()].map(([title, rows]) => ({ title, rows })),
      });
    }
  }

  const pageStreams = pages.map((p, idx) => pageOps(p, idx + 1, pages.length));
  const objects: string[] = [];
  // 1 catalog, 2 pages, then each page + content, then font
  const pageCount = pages.length;
  const kids: string[] = [];
  let objId = 3;
  const pageObjIds: number[] = [];
  const contentObjIds: number[] = [];

  for (let i = 0; i < pageCount; i++) {
    pageObjIds.push(objId++);
    contentObjIds.push(objId++);
  }
  const fontId = objId;

  objects.push("1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n");
  for (let i = 0; i < pageCount; i++) kids.push(`${pageObjIds[i]} 0 R`);
  objects.push(
    `2 0 obj<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>endobj\n`
  );

  for (let i = 0; i < pageCount; i++) {
    objects.push(
      `${pageObjIds[i]} 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents ${contentObjIds[i]} 0 R /Resources<< /Font<< /F1 ${fontId} 0 R >> >> >>endobj\n`
    );
    const stream = pageStreams[i];
    const len = Buffer.byteLength(stream, "utf8");
    objects.push(
      `${contentObjIds[i]} 0 obj<< /Length ${len} >>stream\n${stream}\nendstream\nendobj\n`
    );
  }
  objects.push(
    `${fontId} 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n`
  );

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  const size = objects.length + 1;
  pdf += `xref\n0 ${size}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${size} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

export function suggestReportLine(kind = "relatório"): string {
  return `_Quer ${kind} em *PDF + Excel*?_ Digite *“me manda o relatório”*.`;
}

/** Heurística: resposta longa demais no WhatsApp → sugerir PDF. */
export function maybeAppendReportOffer(text: string, threshold = 900): string {
  const t = String(text || "");
  const lines = t.split("\n").length;
  if (t.length < threshold && lines < 16) return t;
  if (/me manda o relat[oó]rio|quer um relat[oó]rio/i.test(t)) return t;
  return `${t}\n\n${suggestReportLine()}`;
}
