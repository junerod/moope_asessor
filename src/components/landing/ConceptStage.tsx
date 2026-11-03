"use client";

import { useState } from "react";
import { PhoneChat } from "@/components/landing/PhoneChat";
import { LOCADORA_SCENES } from "@/components/landing/phone-scenes";

type CardId = "frota" | "financeiro" | "contratos" | "rastreamento" | "desempenho";

const LIVE: CardId[] = [
  "frota",
  "rastreamento",
  "desempenho",
  "contratos",
  "contratos",
  "financeiro",
  "financeiro",
];

const CARDS: {
  id: CardId;
  icon: string;
  title: string;
  value: string;
  hint: string;
  lines: string[];
}[] = [
  {
    id: "frota",
    icon: "fa-truck",
    title: "Frota",
    value: "247",
    hint: "veículos ativos",
    lines: ["212 em operação", "18 em manutenção", "17 inativos"],
  },
  {
    id: "financeiro",
    icon: "fa-chart-column",
    title: "Financeiro",
    value: "R$ 892.415",
    hint: "resultado do mês",
    lines: ["+14% frente ao mês passado"],
  },
  {
    id: "contratos",
    icon: "fa-file-lines",
    title: "Contratos",
    value: "32",
    hint: "contratos ativos",
    lines: ["5 vencem em 30 dias", "2 em negociação"],
  },
  {
    id: "rastreamento",
    icon: "fa-location-dot",
    title: "Rastreamento",
    value: "80 km/h",
    hint: "BR-116 · Curitiba",
    lines: ["Em movimento agora"],
  },
  {
    id: "desempenho",
    icon: "fa-chart-line",
    title: "Desempenho",
    value: "+28%",
    hint: "eficiência em 30 dias",
    lines: ["−17% custo por km", "+32% produtividade"],
  },
];

export function ConceptStage({ waUrl }: { waUrl: string | null }) {
  const [scene, setScene] = useState(0);
  const live = LIVE[scene] ?? "frota";
  const ask = LOCADORA_SCENES[scene]?.ask ?? "";

  return (
    <>
      <div className="help-hero-row">
        <section className="hero">
          <p className="eyebrow">Rascunho · mesmo visual do manual</p>
          <h1>Pediu. Moveu. Resolveu.</h1>
          <p className="lead">
            O mesmo celular do manual da locadora: a pergunta entra e a
            resposta chega. Os números são exemplo.
          </p>
          <p className="audience">
            A página inicial continua a mesma. Isto é só para você validar.
          </p>
          <div className="hero-cta">
            {waUrl ? (
              <a className="btn btn-wa" href={waUrl} target="_blank" rel="noreferrer">
                <i className="fa-brands fa-whatsapp" aria-hidden />
                Abrir o Assessor
              </a>
            ) : (
              <a className="btn btn-wa" href="/ajuda">
                Como começar
              </a>
            )}
            <a className="btn hero-cta-ghost" href="/">
              Ver a página atual
            </a>
          </div>
        </section>
        <div className="help-hero-phone">
          <PhoneChat
            scenes={LOCADORA_SCENES}
            label="Exemplos no padrão do manual"
            onIndex={setScene}
          />
        </div>
      </div>

      <section className="float-field" aria-label="Números de exemplo que acompanham a conversa">
        <p className="float-kicker">
          Agora no Zap. <strong>{ask}</strong>
          <span>Números de exemplo, no mesmo jeito do manual.</span>
        </p>
        <div className="float-stage">
          <span className="float-wash" aria-hidden />
          {CARDS.map((card, i) => {
            const on = card.id === live;
            return (
              <div
                key={card.id}
                className={`float-slot slot-${i}${on ? " is-live" : ""}`}
              >
                <article className={`float-card tone-${card.id}${on ? " is-live" : ""}`}>
                  <span className="float-chip">agora no Zap</span>
                  <div className="float-head">
                    <span className="float-ico">
                      <i className={`fa-solid ${card.icon}`} aria-hidden />
                    </span>
                    <strong>{card.title}</strong>
                  </div>
                  <p className="float-value">{card.value}</p>
                  <p className="float-hint">{card.hint}</p>
                  <ul>
                    {card.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </article>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
