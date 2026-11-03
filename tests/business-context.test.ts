import { describe, expect, it } from "vitest";
import {
  CONTEXT_SWITCH_HINT,
  askedBusinessKind,
  businessChoiceList,
  dedupeBusinessOptions,
  formatChooser,
  isContextSwitchIntent,
  matchBusinessChoice,
  type BusinessOption,
} from "@/domain/business-context";
import { collapseLocadoraLinks } from "@/integrations/moope-finance-assessor";
import {
  isBusinessWorldCommand,
  isPersonalLifeCommand,
} from "@/domain/command-world";

const OPTIONS: BusinessOption[] = [
  {
    key: "locadora:20",
    kind: "locadora",
    tenantId: 20,
    label: "JK Locações",
    papel: "gerente",
  },
  {
    key: "facejus:3",
    kind: "facejus",
    tenantId: 3,
    label: "Rodrigues Advogados",
    papel: "socio",
  },
];

describe("business-context", () => {
  it("detecta frases de troca / onde estou", () => {
    expect(isContextSwitchIntent("onde estou?")).toBe(true);
    expect(isContextSwitchIntent("trocar empresa")).toBe(true);
    expect(isContextSwitchIntent("mudar contexto")).toBe(true);
    expect(isContextSwitchIntent("agora o escritório")).toBe(true);
    expect(isContextSwitchIntent("agora a locadora JK")).toBe(true);
    expect(isContextSwitchIntent("quanto gastei ontem")).toBe(false);
  });

  it("casa escolha por número e por nome", () => {
    expect(matchBusinessChoice("1", OPTIONS)?.tenantId).toBe(20);
    expect(matchBusinessChoice("2)", OPTIONS)?.kind).toBe("facejus");
    expect(matchBusinessChoice("agora a locadora JK", OPTIONS)?.label).toBe(
      "JK Locações"
    );
    expect(matchBusinessChoice("Facejus", OPTIONS)?.kind).toBe("facejus");
    expect(matchBusinessChoice("Rodrigues", OPTIONS)?.tenantId).toBe(3);
  });

  it("ensina frase canônica de troca", () => {
    expect(CONTEXT_SWITCH_HINT).toMatch(/trocar empresa/);
    expect(CONTEXT_SWITCH_HINT).toMatch(/mudar contexto/);
    expect(CONTEXT_SWITCH_HINT).toMatch(/onde estou/);
  });

  it("junta SOLUTT curto com a razão social (dev + usuário no Finance)", () => {
    const duped = dedupeBusinessOptions([
      {
        key: "locadora:1",
        kind: "locadora",
        tenantId: 1,
        label: "SOLUTT",
        papel: "usuario",
      },
      {
        key: "locadora:9",
        kind: "locadora",
        tenantId: 9,
        label: "SOLUTT LOCAÇÃO DE AUTOMOVEIS LTDA",
        papel: "gerente",
      },
    ]);
    expect(duped).toHaveLength(1);
    expect(duped[0]?.tenantId).toBe(9);
    expect(duped[0]?.papel).toBe("gerente");
    expect(formatChooser(duped)).not.toMatch(/2\)/);
    expect(formatChooser(duped)).not.toMatch(/mais de um contexto/);
  });

  it("não lista a mesma locadora duas vezes", () => {
    const duped = dedupeBusinessOptions([
      {
        key: "locadora:1",
        kind: "locadora",
        tenantId: 1,
        label: "SOLUTT LOCAÇÃO DE AUTOMÓVEIS LTDA",
        papel: "gerente",
      },
      {
        key: "locadora:9",
        kind: "locadora",
        tenantId: 9,
        label: "SOLUTT LOCAÇÃO DE AUTOMÓVEIS LTDA",
        papel: "gerente",
      },
    ]);
    expect(duped).toHaveLength(1);
    expect(formatChooser(duped)).not.toMatch(/2\)/);
  });

  it("alertas da locadora não pergunta se a empresa está repetida", () => {
    const solutt: BusinessOption = {
      key: "locadora:9",
      kind: "locadora",
      tenantId: 9,
      label: "SOLUTT LOCAÇÃO DE AUTOMOVEIS LTDA",
      papel: "gerente",
    };
    const again: BusinessOption = { ...solutt, key: "locadora:9b" };
    const facejus: BusinessOption = {
      key: "facejus:6",
      kind: "facejus",
      tenantId: 6,
      label: "Rodrigues Advogados",
      papel: "socio",
    };
    expect(askedBusinessKind("alertas da locadora")).toBe("locadora");
    expect(businessChoiceList("alertas da locadora", [solutt, again, facejus])).toBe(
      null
    );
    expect(formatChooser([solutt, again])).not.toMatch(/Qual contexto/);
  });

  it("duas locadoras diferentes ainda pedem escolha", () => {
    const a: BusinessOption = {
      key: "locadora:1",
      kind: "locadora",
      tenantId: 1,
      label: "SOLUTT LOCAÇÃO DE AUTOMOVEIS LTDA",
      papel: "gerente",
    };
    const b: BusinessOption = {
      key: "locadora:2",
      kind: "locadora",
      tenantId: 2,
      label: "JK Locações",
      papel: "gerente",
    };
    const choice = businessChoiceList("alertas da locadora", [a, b]);
    expect(choice).toHaveLength(2);
  });
});

describe("collapseLocadoraLinks", () => {
  it("mantém um só vínculo quando o Finance manda dev e usuário da mesma empresa", () => {
    const links = collapseLocadoraLinks([
      {
        userid: 1,
        empresa_nome: "SOLUTT LOCAÇÃO DE AUTOMOVEIS LTDA",
        papel: "gerente",
        scopes: [],
        phone_e164: "+5561996715985",
        nome: "dev",
      },
      {
        userid: 9,
        empresa_nome: "SOLUTT LOCAÇÃO DE AUTOMOVEIS LTDA",
        papel: "gerente",
        scopes: [],
        phone_e164: "+5561996715985",
        nome: "usuario",
      },
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]?.userid).toBe(1);
  });
});

describe("mundos pessoal vs empresa", () => {
  const agenda =
    "Agendar para 17h00, falar com cliente LOCACCAR, sobre ajuste nos contratos de investidores, e envio automático de mensagens para locatários, e acesso em massa da plataforma.";

  it("compromisso com contrato/investidor/locatário no assunto é pessoal", () => {
    expect(isPersonalLifeCommand(agenda)).toBe(true);
    expect(isBusinessWorldCommand(agenda)).toBe(false);
    expect(isPersonalLifeCommand("Pessoal")).toBe(true);
    expect(isPersonalLifeCommand("me lembra amanhã às 10 de ligar")).toBe(true);
  });

  it("só pede empresa em operação de locadora ou Facejus", () => {
    expect(isBusinessWorldCommand("locatários da locadora")).toBe(true);
    expect(isBusinessWorldCommand("prazos do escritório")).toBe(true);
    expect(isBusinessWorldCommand("trocar empresa")).toBe(true);
    expect(isBusinessWorldCommand("gastei 40 no almoço")).toBe(false);
  });
});
