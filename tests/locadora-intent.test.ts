import { describe, expect, it } from "vitest";
import { looksLikeCodeLeak } from "@/domain/safe-reply";
import { looksLikeAppointmentCreate } from "@/domain/appointment-intent";
import { isPersonalLifeCommand } from "@/domain/command-world";
import { isLocadoraDraftConfirm } from "@/domain/locadora-draft";
import {
  detectLocadoraIntent,
  isLocadoraAcaoPhrase,
  isLocadoraInclusaoPhrase,
  resolveLocadoraQuestion,
} from "@/domain/locadora-intent";
import { classifyTurnAct } from "@/domain/turn-act";

describe("locadora-intent", () => {
  it("mapeia aluguéis atrasados → inadimplência", () => {
    expect(detectLocadoraIntent("Queria saber quem falta pagar meus aluguéis")).toBe(
      "inadimplencia"
    );
    expect(detectLocadoraIntent("aluguéis atrasados")).toBe("inadimplencia");
    expect(detectLocadoraIntent("inadimplência")).toBe("inadimplencia");
    expect(detectLocadoraIntent("quem está atrasado")).toBe("inadimplencia");
  });

  it("não confunde com manutenção", () => {
    expect(detectLocadoraIntent("manutenções do mês")).toBe("manutencoes");
    expect(detectLocadoraIntent("OS da placa ABC1D23")).toBe("manutencoes");
  });

  it("preserva o período em consultas de recebimentos", () => {
    expect(detectLocadoraIntent("quanto tenho para receber hoje na locadora?")).toBe(
      "recebimentos"
    );
    expect(detectLocadoraIntent("recebimentos nesta semana")).toBe("recebimentos");
    expect(
      resolveLocadoraQuestion({
        userText: "quanto tenho para receber hoje na locadora?",
        toolQuestion: "receita deste mês",
      })
    ).toBe("recebimentos hoje");
    expect(resolveLocadoraQuestion({ userText: "quanto vou receber na semana?" })).toBe(
      "recebimentos nesta semana"
    );
    expect(resolveLocadoraQuestion({ userText: "recebimentos amanhã" })).toBe(
      "recebimentos amanhã"
    );
    expect(resolveLocadoraQuestion({ userText: "receita deste mês" })).toBe(
      "receita deste mês"
    );
  });

  it("rendimento não vira recebimento mesmo se o modelo pedir a semana", () => {
    expect(detectLocadoraIntent("rendimento da locadora")).toBe("receita");
    expect(detectLocadoraIntent("rendimentos da locadora")).toBe("receita");
    expect(
      resolveLocadoraQuestion({
        userText: "rendimento da locadora",
        toolQuestion: "recebimentos nesta semana",
      })
    ).toBe("receita deste mês");
  });

  it("como está a locadora é o resumo, e ajuda locadora é o manual", () => {
    expect(detectLocadoraIntent("como minha locadora está hoje")).toBe("resumo");
    expect(detectLocadoraIntent("como está minha locadora")).toBe("resumo");
    expect(detectLocadoraIntent("ajuda locadora")).toBe("capacidades");
    expect(detectLocadoraIntent("investidores da locadora")).toBe("investidores");
    expect(resolveLocadoraQuestion({ userText: "topo investidores" })).toBe(
      "investidores da locadora"
    );
    expect(resolveLocadoraQuestion({ userText: "investidor Alan Franco" })).toBe(
      "investidor Alan Franco"
    );
    expect(detectLocadoraIntent("locatários da locadora")).toBe("locatarios");
    expect(resolveLocadoraQuestion({ userText: "Locatários da locação" })).toBe(
      "locatários da locadora"
    );
    expect(resolveLocadoraQuestion({ userText: "Veículos da locação" })).toBe(
      "veículos da locadora"
    );
    expect(resolveLocadoraQuestion({ userText: "locatário Maria Souza" })).toBe(
      "locatário Maria Souza"
    );
    expect(detectLocadoraIntent("locatário em atraso")).not.toBe("locatarios");
    expect(detectLocadoraIntent("veículos da locadora")).toBe("veiculos");
    expect(detectLocadoraIntent("minha frota")).toBe("veiculos");
    expect(detectLocadoraIntent("carros disponíveis")).toBe("frota");
    expect(detectLocadoraIntent("onde está o veículo ABC1D23")).not.toBe("veiculos");
    expect(resolveLocadoraQuestion({ userText: "veículo Argo" })).toBe("veículo Argo");
    expect(
      resolveLocadoraQuestion({
        userText: "como minha locadora está hoje",
        toolQuestion: "capacidades",
      })
    ).toBe("resumo");
  });

  it("prioriza texto do usuário quando o LLM driftar", () => {
    const q = resolveLocadoraQuestion({
      userText: "Queria saber quem falta pagar meus aluguéis",
      toolQuestion: "manutenções do mês",
    });
    expect(q).toBe("inadimplência");
  });

  it("manda a frase de vistoria inteira e deixa vistorias abertas como era", () => {
    const acoes = [
      "quais carros não fizeram vistoria esta semana",
      "vistoria 1",
      "agendar vistoria 1 amanhã 9h",
      "agendar vistoria ABC1D23 amanhã 9h",
      "agenda de vistoria de amanhã",
    ];
    for (const said of acoes) {
      expect(isLocadoraAcaoPhrase(said)).toBe(true);
      expect(
        resolveLocadoraQuestion({
          userText: said,
          toolQuestion: "vistorias abertas",
        })
      ).toBe(said);
      expect(isPersonalLifeCommand(said)).toBe(false);
      expect(looksLikeAppointmentCreate(said)).toBe(false);
      expect(classifyTurnAct(said)).toBe("consultar_empresa");
    }
    expect(isLocadoraAcaoPhrase("vistorias abertas")).toBe(false);
    expect(resolveLocadoraQuestion({ userText: "vistorias abertas" })).toBe(
      "vistorias abertas"
    );
    expect(isPersonalLifeCommand("Agenda de amanhã")).toBe(true);
    expect(looksLikeAppointmentCreate("agendar reunião amanhã às 9h")).toBe(true);
    expect(classifyTurnAct("agendar reunião amanhã às 9h")).toBe("registrar_pessoal");
  });

  it("sim e não da vistoria só valem em cima do rascunho", () => {
    const rascunho =
      "Posso reservar amanhã às 9h para marcar a vistoria da placa ABC1D23?\nIsto é da locadora.";
    expect(isLocadoraDraftConfirm("sim", rascunho)).toBe(true);
    expect(isLocadoraDraftConfirm("não", rascunho)).toBe(true);
    expect(isLocadoraDraftConfirm("nao", rascunho)).toBe(true);
    expect(isLocadoraDraftConfirm("1", rascunho)).toBe(true);
    expect(isLocadoraDraftConfirm("2", rascunho)).toBe(true);
    expect(isLocadoraDraftConfirm("3", rascunho)).toBe(true);
    expect(isLocadoraDraftConfirm("valor total", rascunho)).toBe(true);
    expect(isLocadoraDraftConfirm("11988887777", rascunho)).toBe(true);
    expect(isLocadoraDraftConfirm("o que tenho amanhã", rascunho)).toBe(false);
    expect(isLocadoraDraftConfirm("nota pessoal", rascunho)).toBe(false);
    expect(isLocadoraDraftConfirm("vistorias abertas", rascunho)).toBe(false);
    expect(isLocadoraDraftConfirm("quantos carrinhos", rascunho)).toBe(false);
    expect(isLocadoraDraftConfirm("agenda de atendimento", rascunho)).toBe(false);
    expect(isLocadoraDraftConfirm("agendar reunião amanhã às 9h", rascunho)).toBe(
      false
    );
    expect(isLocadoraDraftConfirm("sim", "Pronto, compromisso agendado.")).toBe(false);
    expect(isLocadoraDraftConfirm("sim", "Isto é da locadora. Confere os dados?")).toBe(
      true
    );
  });

  it("separa foto da locadora do gasto pessoal", () => {
    const frases = [
      "incluir essa multa",
      "incluir motorista",
      "incluir locatário",
      "nota da locadora",
      "nota da placa ABC1D23",
      "manutenção da placa ABC1D23",
    ];
    for (const said of frases) {
      expect(isLocadoraInclusaoPhrase(said)).toBe(true);
      expect(resolveLocadoraQuestion({ userText: said, toolQuestion: "resumo" })).toBe(
        said
      );
      expect(isPersonalLifeCommand(said)).toBe(false);
    }
    expect(isLocadoraInclusaoPhrase("")).toBe(false);
    expect(isLocadoraInclusaoPhrase("nota pessoal")).toBe(false);
    expect(isLocadoraInclusaoPhrase("nota pessoal da placa ABC1D23")).toBe(false);
    expect(isLocadoraAcaoPhrase("vistorias abertas")).toBe(false);
  });

  it("quais veículos fizeram vistoria não vaza erro de código", () => {
    const said = "Quais veículos fizeram vistoria ?";
    expect(typeof isLocadoraAcaoPhrase).toBe("function");
    expect(() => isPersonalLifeCommand(said)).not.toThrow();
    expect(isLocadoraAcaoPhrase(said)).toBe(true);
    expect(isLocadoraAcaoPhrase("Quais veículos fizeram vistoria?")).toBe(true);
    expect(isPersonalLifeCommand(said)).toBe(false);
    expect(resolveLocadoraQuestion({ userText: said, toolQuestion: "vistorias abertas" })).toBe(
      said
    );
    expect(looksLikeCodeLeak("isLocadoraAcaoPhrase is not a function")).toBe(true);
    expect(looksLikeCodeLeak("3 carros fizeram vistoria esta semana.")).toBe(false);
  });
});
