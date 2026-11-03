import { describe, expect, it } from "vitest";
import { looksLikeToneRewrite, rewriteNotice } from "@/domain/notice-tone";
import { looksLikeAnomalyAsk } from "@/domain/spend-anomaly";
import { looksLikeInvitePull } from "@/integrations/google/gmail-invites";
import { guessDocFolder, looksLikeDocFolderAsk } from "@/domain/doc-folders";
import { looksLikeOverdueAsk, looksLikeTaskProject } from "@/domain/task-projects";
import { isExpectedDeskAnswer, isFreshCommand, looksLikeChargeSomeone } from "@/domain/desk-router";

describe("pontos 3, 10, 21, 24, 26 sem comer o resto", () => {
  it("tom reescreve o aviso e não vira cobrança", () => {
    expect(looksLikeToneRewrite("mais curto")).toBe("short");
    expect(looksLikeToneRewrite("mais formal")).toBe("formal");
    expect(looksLikeToneRewrite("gastei 40 no almoço")).toBeNull();
    expect(looksLikeToneRewrite("cobrar o José agora")).toBeNull();
    expect(rewriteNotice("Oi, José. Ana pediu para te lembrar do pagamento de R$ 50,00.", "short")).toBe(
      "Oi, José. Ana pediu para te lembrar do pagamento de R$ 50,00."
    );
    expect(rewriteNotice("Oi, José. Paga até sexta.", "formal")).toMatch(/Olá/);
    expect(rewriteNotice("Oi, José. Paga até sexta.", "formal")).toMatch(/por favor/);
    expect(
      isExpectedDeskAnswer("mais curto", { kind: "meeting", step: "confirm_text" })
    ).toBe(true);
    expect(looksLikeChargeSomeone("mais curto")).toBe(false);
  });

  it("convite, padrão, pasta e atraso não travam comando", () => {
    expect(looksLikeInvitePull("tem convite no email?")).toBe(true);
    expect(looksLikeInvitePull("Sincronizar agenda")).toBe(false);
    expect(looksLikeAnomalyAsk("isso saiu do padrão hoje?")).toBe(true);
    expect(looksLikeAnomalyAsk("gastei 40 no almoço")).toBe(false);
    expect(guessDocFolder("contrato-aluguel.pdf", null)).toBe("contratos");
    expect(guessDocFolder("foto.jpg", "meu RG")).toBe("identidade");
    expect(looksLikeDocFolderAsk("documentos da pasta contratos")).toBe(true);
    expect(looksLikeDocFolderAsk("compromissos de hoje?")).toBe(false);
    expect(looksLikeOverdueAsk("tarefas atrasadas")).toBe(true);
    expect(looksLikeTaskProject("projeto Casa: pintar muro até sexta")?.project).toBe("Casa");
    expect(looksLikeTaskProject("projeto Casa: pintar muro até sexta")?.title).toMatch(/pintar/);
    expect(looksLikeTaskProject("relatório de tarefas")).toBeNull();
    expect(isFreshCommand("tem convite no email?")).toBe(true);
    expect(isFreshCommand("isso saiu do padrão hoje?")).toBe(true);
    expect(isFreshCommand("tarefas atrasadas")).toBe(true);
    expect(isFreshCommand("documentos da pasta contratos")).toBe(true);
    expect(isFreshCommand("Sincronizar agenda")).toBe(true);
    expect(isFreshCommand("quem me deve?")).toBe(true);
  });
});
