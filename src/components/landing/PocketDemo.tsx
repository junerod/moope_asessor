"use client";

import { useEffect, useState } from "react";

export type PocketRow = {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "muted";
};

export type PocketScene = {
  ask: string;
  kicker: string;
  title: string;
  rows: PocketRow[];
  note: string;
};

const STEP_ASK = 700;
const HOLD = 3200;
const CLEAR = 380;

/**
 * Uma frase no Zap e, em seguida, o cartão do que o Assessor devolveria.
 * Cicla os exemplos e recomeça. Com movimento reduzido, fica no primeiro.
 */
export function PocketDemo({
  scenes,
  label,
}: {
  scenes: PocketScene[];
  label: string;
}) {
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<"ask" | "card">("ask");
  const [clearing, setClearing] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const onChange = () => setReduceMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      setPhase("card");
      return;
    }
    let cancelled = false;
    let clearId = 0;
    const wait = phase === "ask" ? STEP_ASK : HOLD;
    const t = window.setTimeout(() => {
      if (cancelled) return;
      if (phase === "ask") {
        setPhase("card");
        return;
      }
      setClearing(true);
      clearId = window.setTimeout(() => {
        if (cancelled) return;
        setClearing(false);
        setPhase("ask");
        setIndex((i) => (i + 1) % scenes.length);
      }, CLEAR);
    }, phase === "ask" ? STEP_ASK : wait);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      if (clearId) window.clearTimeout(clearId);
    };
  }, [phase, index, reduceMotion, scenes.length]);

  const scene = scenes[reduceMotion ? 0 : index];
  const showCard = reduceMotion || phase === "card";

  return (
    <div
      className={`lp-pocket${clearing ? " lp-pocket-clearing" : ""}`}
      aria-label={label}
    >
      <div className="lp-pocket-ask lp-bubble lp-bubble-user lp-bubble-in">
        {scene.ask}
        <small>você</small>
      </div>
      {showCard ? (
        <article className="lp-pocket-card lp-bubble-in" key={`${index}-${scene.title}`}>
          <p className="lp-pocket-kicker">{scene.kicker}</p>
          <h3>{scene.title}</h3>
          <ul>
            {scene.rows.map((row) => (
              <li key={row.label} data-tone={row.tone || "ok"}>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </li>
            ))}
          </ul>
          <p className="lp-pocket-note">{scene.note}</p>
        </article>
      ) : (
        <div className="lp-typing" aria-hidden>
          <span />
          <span />
          <span />
        </div>
      )}
      <p className="lp-pocket-step">
        Exemplo {reduceMotion ? 1 : index + 1} de {scenes.length}
      </p>
    </div>
  );
}

export const LOCADORA_SCENES: PocketScene[] = [
  {
    ask: "resumo da locadora",
    kicker: "Frota",
    title: "Panorama de agora",
    rows: [
      { label: "Disponíveis", value: "18" },
      { label: "Alugados", value: "42" },
      { label: "Manutenção", value: "3", tone: "warn" },
    ],
    note: "Dá para pedir por filial ou por operação, tipo Uber.",
  },
  {
    ask: "onde está o carro ABC1D23",
    kicker: "Posição",
    title: "ABC1D23 · online",
    rows: [
      { label: "Onde", value: "Asa Norte" },
      { label: "Mapa", value: "link pronto" },
      { label: "Bateria", value: "12,4 V" },
    ],
    note: "TAG mostra a porcentagem da tag, não o volt do carro.",
  },
  {
    ask: "alertas da locadora",
    kicker: "Rastreamento",
    title: "O que pede atenção",
    rows: [
      { label: "Fora 24h", value: "2", tone: "warn" },
      { label: "Fora 48h", value: "1", tone: "warn" },
      { label: "TAG", value: "4" },
    ],
    note: "Alerta é por placa: 24h, 48h, 72h, offline e misto.",
  },
  {
    ask: "quem está com o carro ABC1D23",
    kicker: "Contrato",
    title: "João Silva · devolve sexta",
    rows: [
      { label: "Contrato", value: "ativo" },
      { label: "A vencer na semana", value: "6" },
      { label: "Devoluções em 7 dias", value: "4" },
    ],
    note: "Também: renovações da semana e contratos a vencer.",
  },
  {
    ask: "vistorias abertas",
    kicker: "Operação",
    title: "Vistoria, OS e CNH",
    rows: [
      { label: "Vistorias abertas", value: "5", tone: "warn" },
      { label: "OS do mês", value: "2" },
      { label: "CNH a vencer", value: "1", tone: "warn" },
    ],
    note: "A vistoria sai com o link do relatório.",
  },
  {
    ask: "multas a pagar",
    kicker: "Ocorrência",
    title: "Sinistros e multas",
    rows: [
      { label: "Sinistros abertos", value: "1", tone: "warn" },
      { label: "Multas a pagar", value: "3", tone: "warn" },
      { label: "Valor", value: "só gerente" },
    ],
    note: "Valor em real só aparece para gerente ou financeiro.",
  },
  {
    ask: "receita deste mês",
    kicker: "Financeiro",
    title: "Setembro · gerente",
    rows: [
      { label: "Receita", value: "R$ 86 mil" },
      { label: "Recebido hoje", value: "R$ 2.400" },
      { label: "Inadimplência", value: "R$ 4.100", tone: "warn" },
    ],
    note: "Fluxo de caixa, ticket, faturas da placa e extrato do contrato.",
  },
];

export const FACEJUS_SCENES: PocketScene[] = [
  {
    ask: "meus processos",
    kicker: "Processos",
    title: "No seu escopo",
    rows: [
      { label: "Ativos", value: "28" },
      { label: "Arquivados", value: "11", tone: "muted" },
      { label: "Papel", value: "advogado" },
    ],
    note: "Sócio vê o escritório inteiro. Advogado vê só o dele.",
  },
  {
    ask: "processos do cliente Marilene",
    kicker: "Busca",
    title: "Marilene · 2 processos",
    rows: [
      { label: "Por nome", value: "achou" },
      { label: "Por CPF", value: "também" },
      { label: "Por número CNJ", value: "também" },
    ],
    note: "Dá para filtrar por área e por filial.",
  },
  {
    ask: "resumo do escritório",
    kicker: "KPIs",
    title: "Escritório agora",
    rows: [
      { label: "Ativos", value: "140" },
      { label: "Previdenciário", value: "46" },
      { label: "Filial Içara", value: "22" },
    ],
    note: "Quebra por área, natureza e filial, no papel de quem pergunta.",
  },
  {
    ask: "andamento do processo 0001234-56.2024",
    kicker: "Andamento",
    title: "Último lançamento",
    rows: [
      { label: "Quando", value: "ontem" },
      { label: "O quê", value: "juntada" },
      { label: "Onde", value: "Facejus" },
    ],
    note: "Atualiza o cliente sem abrir o sistema.",
  },
  {
    ask: "agenda de atendimento",
    kicker: "Atendimento",
    title: "Consultas por filial",
    rows: [
      { label: "Içara", value: "2" },
      { label: "Sede", value: "1" },
      { label: "OAB", value: "opcional" },
    ],
    note: "A lista sai por filial. A OAB filtra um advogado. O PDF baixa no painel.",
  },
  {
    ask: "agenda de prazos processuais",
    kicker: "Prazos",
    title: "Prazos do dia",
    rows: [
      { label: "09:30", value: "audiência" },
      { label: "Filial", value: "Içara" },
      { label: "PDF", value: "no painel" },
    ],
    note: "Agenda de prazos é separada da agenda de atendimento.",
  },
  {
    ask: "onde estou?",
    kicker: "Contexto",
    title: "Escritório Facejus",
    rows: [
      { label: "Agora", value: "Facejus" },
      { label: "Trocar", value: "locadora" },
      { label: "Pessoal", value: "no mesmo Zap" },
    ],
    note: "Lembrete e gasto pessoal continuam aqui. Diga trocar empresa.",
  },
];
