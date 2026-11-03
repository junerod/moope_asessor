"use client";

import { useEffect, useState } from "react";

type Bubble = { role: "user" | "bot"; text: string };

const SCENES: Bubble[][] = [
  [
    { role: "user", text: "anota 48 de almoço" },
    { role: "bot", text: "Pronto ✅ R$ 48,00 em alimentação." },
  ],
  [
    { role: "user", text: "me lembra amanhã às 9h do dentista" },
    {
      role: "bot",
      text: "Lembrete marcado pra amanhã 9h. Quer ver o que tem hoje?",
    },
  ],
  [
    { role: "user", text: "o que tenho hoje?" },
    {
      role: "bot",
      text: "📅 Seu dia (2)\n1. Dentista · 09:00\n2. Conta de luz · 18:00\nDiga baixa 1 quando concluir.",
    },
  ],
  [
    { role: "user", text: "quanto tempo até o aeroporto?" },
    {
      role: "bot",
      text: "🛣️ ~42 min no trânsito agora. Manda o pin pra eu afinar a rota.",
    },
  ],
  [
    { role: "user", text: "me lembra às 18h de buscar o Pedro — avisa a Ju também" },
    {
      role: "bot",
      text: "Anotei ✅ Você e a Ju recebem às 18h. Ela vê: Recado de você.",
    },
  ],
  [
    { role: "user", text: "cotação do dólar" },
    { role: "bot", text: "💱 Dólar · R$ 5,42 (compra). Quer converter um valor?" },
  ],
];

const STEP_MS = 1100;
const HOLD_MS = 2800;
const CLEAR_MS = 450;

/**
 * Simulação de chat no mock do celular — entra pergunta/resposta e reinicia o ciclo.
 */
export function HeroChatDemo() {
  const [scene, setScene] = useState(0);
  const [shown, setShown] = useState(0);
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
      setShown(SCENES[0].length);
      return;
    }

    const bubbles = SCENES[scene];
    let cancelled = false;
    let clearId = 0;

    if (shown < bubbles.length) {
      const t = window.setTimeout(() => {
        if (!cancelled) setShown((n) => n + 1);
      }, STEP_MS);
      return () => {
        cancelled = true;
        window.clearTimeout(t);
      };
    }

    const hold = window.setTimeout(() => {
      if (cancelled) return;
      setClearing(true);
      clearId = window.setTimeout(() => {
        if (cancelled) return;
        setClearing(false);
        setShown(0);
        setScene((s) => (s + 1) % SCENES.length);
      }, CLEAR_MS);
    }, HOLD_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(hold);
      if (clearId) window.clearTimeout(clearId);
    };
  }, [scene, shown, reduceMotion]);

  const bubbles = SCENES[scene].slice(
    0,
    reduceMotion ? SCENES[scene].length : shown,
  );

  return (
    <div className={`lp-chat${clearing ? " lp-chat-clearing" : ""}`}>
      {bubbles.map((b, i) => (
        <div
          key={`${scene}-${i}-${b.text.slice(0, 12)}`}
          className={`lp-bubble lp-bubble-${b.role} lp-bubble-in`}
        >
          {b.text.split("\n").map((line, j) => (
            <span key={j}>
              {j > 0 ? <br /> : null}
              {line}
            </span>
          ))}
          <small>{b.role === "user" ? "você" : "Assessor"}</small>
        </div>
      ))}
      {!reduceMotion && shown > 0 && shown < SCENES[scene].length ? (
        <div className="lp-typing" aria-hidden>
          <span />
          <span />
          <span />
        </div>
      ) : null}
    </div>
  );
}
