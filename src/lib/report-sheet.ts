/**
 * Planilha Excel-friendly (CSV UTF-8 com BOM + ;).
 * Abre direto no Excel / Numbers / Google Sheets sem deps.
 */
import ExcelJS from "exceljs";

export function buildCsvSheet(input: {
  headers: string[];
  rows: Array<Array<string | number>>;
  extraLines?: string[][];
}): Buffer {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [
    input.headers.map(esc).join(";"),
    ...input.rows.map((r) => r.map(esc).join(";")),
    ...(input.extraLines || []).map((r) => r.map(esc).join(";")),
  ];
  return Buffer.from(`\uFEFF${lines.join("\n")}\n`, "utf8");
}

export async function buildXlsxSheet(input: {
  name: string;
  headers: string[];
  rows: Array<Array<string | number>>;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "MOOPE Assessor";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet(input.name.slice(0, 31) || "Relatório");
  worksheet.columns = input.headers.map((header, index) => ({
    header,
    key: `column_${index + 1}`,
    width: Math.min(42, Math.max(16, header.length + 4)),
  }));
  worksheet.addRows(input.rows);
  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF0D5964" },
  };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, input.rows.length + 1), column: input.headers.length },
  };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
