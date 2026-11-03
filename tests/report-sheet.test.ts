import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildXlsxSheet } from "@/lib/report-sheet";

describe("buildXlsxSheet", () => {
  it("gera um XLSX válido que preserva cabeçalhos e linhas", async () => {
    const buffer = await buildXlsxSheet({
      name: "Recebimentos",
      headers: ["Valor", "Data ou detalhe"],
      rows: [["R$ 1.250,50", "28/09/2026"], ["R$ 400,00", "Contrato 42"]],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet("Recebimentos");

    expect(buffer.subarray(0, 2).toString("hex")).toBe("504b");
    expect(sheet?.getRow(1).values).toEqual([undefined, "Valor", "Data ou detalhe"]);
    expect(sheet?.getRow(2).values).toEqual([undefined, "R$ 1.250,50", "28/09/2026"]);
    expect(sheet?.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet?.autoFilter).toBeDefined();
  });
});