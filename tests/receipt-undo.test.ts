import { describe, expect, it } from "vitest";
import {
  formatReceiptMoney,
  looksLikeSpend,
  looksLikeUndo,
  looksLikeValueFix,
  receiptLine,
  scrubFakeValueHint,
  withinReceiptWindow,
} from "@/domain/receipt-undo";
import { looksLikeReminderCreate } from "@/domain/reminder-intent";

describe("recibo 24h", () => {
  it("lê gastei 40 no almoço e o recibo de uma linha", () => {
    const spend = looksLikeSpend("Gastei 40 no almoço");
    expect(spend?.amount).toBe(40);
    expect(spend?.label).toBe("almoço");
    expect(spend?.category).toBe("restaurante");
    expect(formatReceiptMoney(40)).toBe("R$ 40,00");
    expect(receiptLine("🍽️ Anotei *almoço*: R$ 40,00.")).toBe(
      "🍽️ Anotei *almoço*: R$ 40,00."
    );
    expect(receiptLine("🍽️ Anotei *almoço*: R$ 40,00.")).not.toMatch(/55|desfaz/);
    expect(receiptLine("✅ *Marcado:* reunião", "appointment")).toBe(
      "✅ *Marcado:* reunião. Diz *desfaz* se o horário ou o assunto estiver errado."
    );
    expect(receiptLine("🔔 Te lembro às 10h", "reminder")).not.toMatch(/valor é 55/);
  });

  it("desfaz o último ou a frase, e troca o valor", () => {
    expect(looksLikeUndo("desfaz")).toEqual({ phrase: null });
    expect(looksLikeUndo("desfaz o almoço")?.phrase).toBe("almoco");
    expect(looksLikeValueFix("o valor é 55")).toEqual({ amount: 55, phrase: null });
    expect(looksLikeValueFix("o valor do almoço é 55")).toEqual({
      amount: 55,
      phrase: "almoco",
    });
    expect(looksLikeSpend("quanto gastei")).toBeNull();
    expect(looksLikeUndo("Cobrar o Zé 50 sexta")).toBeNull();
    expect(looksLikeSpend("Cobrar o Zé 50 sexta")).toBeNull();
  });

  it("áudio curto de gasto não vira lembrete nem cita 55", () => {
    expect(looksLikeSpend("Gastei 100 reais com gasolina.")).toMatchObject({
      amount: 100,
      label: "gasolina",
      category: "gasolina",
    });
    expect(looksLikeSpend("Mercado 250.")).toMatchObject({
      amount: 250,
      label: "Mercado",
      category: "mercado",
    });
    expect(looksLikeSpend("250 no mercado")).toMatchObject({
      amount: 250,
      category: "mercado",
    });
    expect(looksLikeSpend("no mercado 250")).toMatchObject({
      amount: 250,
      category: "mercado",
    });
    expect(looksLikeSpend("gasolina 80")).toMatchObject({
      amount: 80,
      category: "gasolina",
    });
    expect(looksLikeReminderCreate("Mercado 250.")).toBe(false);
    expect(looksLikeSpend("me lembra amanhã às 9h de ir no mercado")).toBeNull();
    expect(looksLikeSpend("18h00 verificar o aplicativo do Bistek")).toBeNull();
    expect(
      scrubFakeValueHint(
        "🛒 Anotei *mercado*: R$ 250,00. Diz *desfaz* ou *o valor é 55*."
      )
    ).toBe("🛒 Anotei *mercado*: R$ 250,00.");
  });

  it("não trata como recibo o que passou de 24h", () => {
    const now = Date.now();
    expect(withinReceiptWindow(new Date(now - 60 * 60 * 1000), now)).toBe(true);
    expect(withinReceiptWindow(new Date(now - 25 * 60 * 60 * 1000), now)).toBe(false);
  });
});
