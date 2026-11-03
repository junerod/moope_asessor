import { describe, expect, it } from "vitest";
import {
  formatLegalReply,
  legalDocKind,
  looksLikeLegalAsk,
  PRIVACY_URL,
} from "@/domain/legal-docs";

describe("termos de privacidade", () => {
  it("reconhece o pedido de política, não o FAQ da empresa", () => {
    expect(legalDocKind("Me mostra os termos de privacidade")).toBe("privacy");
    expect(legalDocKind("política de privacidade")).toBe("privacy");
    expect(legalDocKind("lgpd")).toBe("privacy");
    expect(legalDocKind("quero apagar meus dados")).toBe("privacy");
    expect(legalDocKind("termos de uso")).toBe("terms");
    expect(legalDocKind("termos de serviço")).toBe("terms");
    expect(looksLikeLegalAsk("Me mostra os termos de privacidade")).toBe(true);
  });

  it("não rouba pedido de contrato da locadora", () => {
    expect(legalDocKind("termos do contrato da locadora")).toBeNull();
    expect(legalDocKind("contrato da placa ABC1D23")).toBeNull();
  });

  it("devolve o termo oficial, sem site comercial", () => {
    const reply = formatLegalReply("Me mostra os termos de privacidade");
    expect(reply).toContain("Política de Privacidade");
    expect(reply).toContain("Não vendemos seus dados pessoais");
    expect(reply).toContain(PRIVACY_URL);
    expect(reply).not.toContain("Rastreamento veicular");
    expect(reply).not.toContain("Benefícios para locadoras");
  });

  it("nos termos de uso, a MOOPE não assume prazo, queda nem uso indevido", () => {
    const reply = formatLegalReply("termos de uso");
    expect(reply).toContain("não se responsabiliza");
    expect(reply).toContain("perda de prazos");
    expect(reply).toContain("uso indevido");
    expect(reply).toContain("instabilidade");
  });
});
