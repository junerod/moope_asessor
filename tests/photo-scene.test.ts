import { describe, expect, it } from "vitest";
import {
  parseVisionExtraction,
  replyForUnaskedPhoto,
} from "@/domain/vision-extract";

describe("foto sem pedido", () => {
  it("comida traz nutrientes por 100 g", () => {
    const extracted = parseVisionExtraction(
      JSON.stringify({
        scene: "comida",
        subject: "arroz e feijão",
        summary: "prato feito",
        foods: [
          { name: "arroz", kcal: 130, protein_g: 2.7, fat_g: 0.3, carbs_g: 28 },
        ],
      }),
      "documento"
    );
    const reply = replyForUnaskedPhoto(extracted) || "";
    expect(reply).toContain("100 g");
    expect(reply).toContain("arroz");
    expect(reply).toContain("130 kcal");
    expect(reply).toContain("Média do prato");
  });

  it("nota com valor espera confirmação, não responde como foto solta", () => {
    const extracted = parseVisionExtraction(
      JSON.stringify({
        scene: "financeiro",
        subject: "nota da farmácia",
        amount: 42.5,
        category: "farmacia",
        merchant: "Drogaria",
      }),
      "documento"
    );
    expect(extracted.kind).toBe("nota_recibo");
    expect(replyForUnaskedPhoto(extracted)).toBeNull();
  });

  it("foto comum pergunta se manda ou guarda", () => {
    const extracted = parseVisionExtraction(
      JSON.stringify({ scene: "outro", subject: "cachorro no sofá", summary: "pet" }),
      "documento"
    );
    const reply = replyForUnaskedPhoto(extracted) || "";
    expect(reply).toContain("cachorro no sofá");
    expect(reply).toContain("mande para alguém");
  });
});
