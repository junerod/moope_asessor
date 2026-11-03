import { describe, expect, it } from "vitest";
import {
  isBillLikeReminder,
  looksLikeReceiptPaidText,
  looksLikeReceiptSkip,
  receiptCtaLine,
} from "@/domain/receipt-prompt";

describe("receipt-prompt", () => {
  it("detecta lembrete de conta", () => {
    expect(isBillLikeReminder("pagar luz", { kind: "conta" })).toBe(true);
    expect(isBillLikeReminder("boleto do condomínio", {})).toBe(true);
    expect(isBillLikeReminder("ligar pro dentista", {})).toBe(false);
  });

  it("detecta texto de pago / skip", () => {
    expect(looksLikeReceiptPaidText("já paguei")).toBe(true);
    expect(looksLikeReceiptPaidText("paguei a conta")).toBe(true);
    expect(looksLikeReceiptPaidText("depois")).toBe(true);
    expect(looksLikeReceiptSkip("depois")).toBe(true);
    expect(looksLikeReceiptPaidText("quanto gastei")).toBe(false);
  });

  it("cta", () => {
    expect(receiptCtaLine()).toMatch(/comprovante/i);
  });
});
