import { describe, expect, it } from "vitest";
import { classifyTurnAct } from "@/domain/turn-act";
import { looksLikeAppointmentCreate } from "@/domain/appointment-intent";
import { looksLikeReminderCreate } from "@/domain/reminder-intent";
import { looksLikeDayList, looksLikeChargeSomeone } from "@/domain/desk-router";
import { looksLikeFreeSlotAsk, looksLikeClashAsk } from "@/domain/agenda-gaps";
import { looksLikeRouteIntent } from "@/domain/routes";
import { looksLikeLeaveHomeIntent } from "@/domain/leave-home";
import { looksLikePublicSlotAsk } from "@/domain/public-slots";
import {
  isBusinessWorldCommand,
  isPersonalLifeCommand,
} from "@/domain/command-world";
import { isContextSwitchIntent } from "@/domain/business-context";
import { looksLikeSpend } from "@/domain/receipt-undo";

/** Todas as portas que uma frase solta pode abrir ao mesmo tempo. */
export function openDoors(text: string): string[] {
  const hit: string[] = [];
  if (looksLikeAppointmentCreate(text)) hit.push("appointment");
  if (looksLikeReminderCreate(text)) hit.push("reminder");
  if (looksLikeDayList(text)) hit.push("day_list");
  if (looksLikeFreeSlotAsk(text)) hit.push("free_slot");
  if (looksLikeClashAsk(text)) hit.push("clash");
  if (looksLikeRouteIntent(text)) hit.push("route");
  if (looksLikeLeaveHomeIntent(text)) hit.push("leave_home");
  if (looksLikePublicSlotAsk(text)) hit.push("public_slot");
  if (looksLikeChargeSomeone(text)) hit.push("charge");
  if (looksLikeSpend(text)) hit.push("spend");
  if (isContextSwitchIntent(text)) hit.push("context_switch");
  if (isBusinessWorldCommand(text)) hit.push("business");
  return hit;
}

type Case = {
  said: string;
  act: ReturnType<typeof classifyTurnAct>;
  doors: string[];
  personal?: boolean;
};

const CASES: Case[] = [
  {
    said: "Agendar amanhã às 09:30 Falar com Mauricio da livre via",
    act: "registrar_pessoal",
    doors: ["appointment"],
    personal: true,
  },
  {
    said: "marca amanha 9h30 o mauricio da livre via",
    act: "registrar_pessoal",
    doors: ["appointment"],
    personal: true,
  },
  {
    said: "Marcar amanhã falar com Adan da MOVEGO sobre o zernio às 09:35",
    act: "registrar_pessoal",
    doors: ["appointment"],
    personal: true,
  },
  {
    said: "Anotar compromisso 15h30 ligar para o senhor Adam da movie Go",
    act: "registrar_pessoal",
    doors: ["appointment"],
    personal: true,
  },
  {
    said: "Ligar 17h00 para Locadora MOve GO para falar com Adan",
    act: "registrar_pessoal",
    doors: ["appointment"],
    personal: true,
  },
  {
    said: "18h00 verificar o aplicativo do Bistek para recolher carrinhos e criar rotas",
    act: "registrar_pessoal",
    doors: ["appointment"],
    personal: true,
  },
  {
    said: "Anotar compromisso para as 18h00 Verificar aplicativo do Bistek para gerar rotas",
    act: "registrar_pessoal",
    doors: ["appointment"],
    personal: true,
  },
  {
    said: "amanha 9:30 ligar pro mauricio",
    act: "registrar_pessoal",
    doors: ["appointment"],
    personal: true,
  },
  {
    said: "me lembra amanhã às 9h de ligar pro dentista",
    act: "registrar_pessoal",
    doors: ["reminder"],
    personal: true,
  },
  {
    said: "o q tenho hoje",
    act: "listar_dia",
    doors: ["day_list"],
  },
  {
    said: "Agenda de amanhã",
    act: "listar_dia",
    doors: ["day_list"],
  },
  {
    said: "o que eu tenho amanhã?",
    act: "listar_dia",
    doors: ["day_list"],
  },
  {
    said: "quais meus compromissos de hoje?",
    act: "listar_dia",
    doors: ["day_list"],
  },
  {
    said: "Sexta de manhã livre?",
    act: "consultar_livre",
    doors: ["free_slot"],
  },
  {
    said: "horários livres amanhã",
    act: "consultar_livre",
    doors: ["free_slot"],
  },
  {
    said: "quanto tempo até o aeroporto",
    act: "residual",
    doors: ["route"],
  },
  {
    said: "rota até o dentista",
    act: "residual",
    doors: ["route"],
  },
  {
    said: "até Taguatinga",
    act: "residual",
    doors: ["route"],
  },
  {
    said: "quando sair pro aeroporto",
    act: "residual",
    doors: ["leave_home"],
  },
  {
    said: "alertas da locadora",
    act: "consultar_empresa",
    doors: ["business"],
  },
  {
    said: "locatários da locadora",
    act: "consultar_empresa",
    doors: ["business"],
  },
  {
    said: "prazos judiciais",
    act: "consultar_empresa",
    doors: ["business"],
  },
  {
    said: "agenda de atendimento",
    act: "consultar_empresa",
    doors: ["business"],
  },
  {
    said: "agenda de atendimento da filial Içara",
    act: "consultar_empresa",
    doors: ["business"],
  },
  {
    said: "agenda de prazos processuais",
    act: "consultar_empresa",
    doors: ["business"],
  },
  {
    said: "atendimentos de hoje",
    act: "consultar_empresa",
    doors: ["business"],
  },
  {
    said: "marcar atendimento amanhã às 15h",
    act: "registrar_pessoal",
    doors: ["appointment"],
    personal: true,
  },
  {
    said: "onde estou?",
    act: "residual",
    doors: ["context_switch", "business"],
  },
  {
    said: "trocar empresa",
    act: "residual",
    doors: ["context_switch", "business"],
  },
  {
    said: "Cobrar o Zé 50 sexta",
    act: "residual",
    doors: ["charge"],
  },
  {
    said: "Gastei 40 no almoço",
    act: "residual",
    doors: ["spend"],
  },
  {
    said: "Mercado 250",
    act: "residual",
    doors: ["spend"],
  },
  {
    said: "Gastei 100 reais com gasolina.",
    act: "residual",
    doors: ["spend"],
  },
  {
    said: "me dá um link pra a pessoa marcar",
    act: "residual",
    doors: ["public_slot"],
  },
  {
    said: "tem choque na agenda?",
    act: "residual",
    doors: ["clash"],
  },
  {
    said: "Meus compromissos",
    act: "listar_dia",
    doors: ["day_list"],
  },
  {
    said: "baixar compromisso: Falar com Adan",
    act: "residual",
    doors: [],
  },
  {
    said: "remover compromisso de ontem: Falar com Adan",
    act: "residual",
    doors: [],
  },
];

describe("cruzamento das portas — frase solta, sem comando oficial", () => {
  it("cada frase abre só o módulo certo", () => {
    const fails: string[] = [];
    for (const row of CASES) {
      const act = classifyTurnAct(row.said);
      const doors = openDoors(row.said);
      if (act !== row.act) {
        fails.push(`ATO  «${row.said}» → ${act} (queria ${row.act})`);
      }
      const extra = doors.filter((d) => !row.doors.includes(d));
      const missing = row.doors.filter((d) => !doors.includes(d));
      if (extra.length || missing.length) {
        fails.push(
          `PORTA «${row.said}» → [${doors.join(",")}] queria [${row.doors.join(",")}]`
        );
      }
      if (row.personal === true && !isPersonalLifeCommand(row.said)) {
        fails.push(`PESSOAL «${row.said}» não foi pessoal`);
      }
      if (row.personal === true && isBusinessWorldCommand(row.said)) {
        fails.push(`PESSOAL «${row.said}» vazou pra empresa`);
      }
    }
    expect(fails).toEqual([]);
  });
});
