import { describe, expect, it } from "vitest";
import {
  classifyBalanceAsk,
  formatBalanceMenu,
  matchBalancePick,
  type BalanceTarget,
} from "@/domain/balance-route";

const both: BalanceTarget[] = [
  { kind: "pessoal", label: "Pessoal" },
  { kind: "locadora", label: "SOLUTT", tenantId: 9, papel: "gerente" },
];

describe("balance route", () => {
  it("pede o menu só no balanço sem contexto", () => {
    expect(classifyBalanceAsk("balanço do mês")).toBe("ask");
    expect(classifyBalanceAsk("balanço do mês pessoal")).toBe("pessoal");
    expect(classifyBalanceAsk("balanço da locadora")).toBe("locadora");
    expect(classifyBalanceAsk("resumo da locadora")).toBeNull();
  });

  it("escolhe 1 ou 2 sem abrir os dois", () => {
    expect(matchBalancePick("2", both)).toBe(1);
    expect(matchBalancePick("pessoal", both)).toBe(0);
    expect(formatBalanceMenu(both)).toContain("1. Pessoal");
    expect(formatBalanceMenu(both)).toContain("2. Locadora · SOLUTT");
  });
});