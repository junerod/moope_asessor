import { describe, expect, it } from "vitest";
import {
  looksLikeIouList,
  looksLikeIouOpen,
  looksLikeIouSettle,
} from "@/domain/personal-iou";
import {
  looksLikeBillAhead,
  looksLikeCeilingAsk,
  looksLikeRecurringMoney,
} from "@/domain/recurring-money";
import { extractAtaBody, looksLikeAtaAsk } from "@/domain/meeting-notes";
import { looksLikePublicSlotAsk, looksLikeTaskReport } from "@/domain/public-slots";
import { looksLikeChargeSomeone, isFreshCommand } from "@/domain/desk-router";

describe("fases 4 a 7 sem trancar o resto", () => {
  it("vale pessoal fecha o ciclo e não vira cobrança", () => {
    expect(looksLikeIouOpen("Emprestei 200 pro Lucas")).toMatchObject({
      name: "Lucas",
      amount: 200,
      direction: "they",
    });
    expect(looksLikeIouOpen("o Lucas me deve 80")).toMatchObject({
      name: "Lucas",
      amount: 80,
      direction: "they",
    });
    expect(
      looksLikeIouOpen("O José me deve R$ 50, cobrar dele na sexta-feira às 10h00")
    ).toMatchObject({ name: "José", amount: 50, direction: "they" });
    expect(looksLikeIouList("quem me deve?")).toBe("they");
    expect(looksLikeIouList("a quem eu devo?")).toBe("i");
    expect(looksLikeIouSettle("recebi 200 do Lucas")).toMatchObject({
      name: "Lucas",
      amount: 200,
    });
    expect(looksLikeChargeSomeone("o Lucas me deve 80")).toBe(false);
    expect(isFreshCommand("quem me deve?")).toBe(true);
    expect(isFreshCommand("Sincronizar agenda")).toBe(true);
  });

  it("série, teto, ata e link público não comem comando de agenda", () => {
    expect(looksLikeRecurringMoney("Academia 89,90 todo mês")).toMatchObject({
      label: "Academia",
      amount: 89.9,
      rule: "monthly",
    });
    expect(looksLikeRecurringMoney("TV em 10x de 150")).toMatchObject({
      label: "TV",
      amount: 150,
      count: 10,
    });
    expect(looksLikeCeilingAsk("como está o teto")).toBe(true);
    expect(looksLikeBillAhead("IPVA 1200 em março")?.label).toBe("IPVA");
    expect(looksLikeAtaAsk("faz a ata")).toBe(true);
    expect(extractAtaBody("faz a ata")).toBeNull();
    expect(extractAtaBody("faz a ata: June fica com o contrato")).toContain("June");
    expect(looksLikePublicSlotAsk("Me dá um link pra a pessoa marcar")).toBe(true);
    expect(looksLikeTaskReport("relatório de tarefas")).toBe(true);
    expect(isFreshCommand("compromissos de hoje?")).toBe(true);
    expect(isFreshCommand("faz a ata")).toBe(true);
  });
});
