/**
 * Gera PDF texto simples (PDF 1.4) sem dependências externas.
 */
export function buildSimplePdf(input: {
  title: string;
  lines: string[];
}): Buffer {
  const escape = (s: string) =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/[^\x20-\x7EÀ-ÿ\u00A0-\u00FF]/g, "?");

  const contentLines: string[] = [];
  let y = 800;
  contentLines.push("BT /F1 16 Tf 50 820 Td (" + escape(input.title) + ") Tj ET");
  y = 790;
  for (const raw of input.lines) {
    const line = escape(raw.slice(0, 95));
    y -= 16;
    if (y < 50) break;
    contentLines.push(`BT /F1 10 Tf 50 ${y} Td (${line}) Tj ET`);
  }
  const stream = contentLines.join("\n");
  const streamBytes = Buffer.from(stream, "utf8");

  const objects: string[] = [];
  objects.push("1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n");
  objects.push("2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n");
  objects.push(
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n"
  );
  objects.push(
    `4 0 obj<< /Length ${streamBytes.length} >>stream\n${stream}\nendstream\nendobj\n`
  );
  objects.push(
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n"
  );

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}
