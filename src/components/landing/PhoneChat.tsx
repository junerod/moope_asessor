"use client";

import { useEffect, useRef, useState } from "react";
import { MiniMap } from "@/components/landing/MiniMap";
import type { PhoneScene } from "@/components/landing/phone-scenes";
import "./phone-demo.css";

const STEP_MS = 900;
const HOLD_MS = 3400;
const CLEAR_MS = 380;

/**
 * Mesmo celular do WhatsApp em todas as telas: pergunta, resposta e, quando
 * cabe, o mini mapa. O nome no topo é MOOPE Assessor.
 */
export function PhoneChat({
  scenes,
  label,
  onIndex,
}: {
  scenes: PhoneScene[];
  label: string;
  onIndex?: (index: number) => void;
}) {
  const [index, setIndex] = useState(0);
  const onIndexRef = useRef(onIndex);
  onIndexRef.current = onIndex;
  const [phase, setPhase] = useState<"ask" | "reply">("ask");
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
      setPhase("reply");
      return;
    }
    let cancelled = false;
    let clearId = 0;
    const wait = phase === "ask" ? STEP_MS : HOLD_MS;
    const t = window.setTimeout(() => {
      if (cancelled) return;
      if (phase === "ask") {
        setPhase("reply");
        return;
      }
      setClearing(true);
      clearId = window.setTimeout(() => {
        if (cancelled) return;
        setClearing(false);
        setPhase("ask");
        setIndex((i) => (i + 1) % scenes.length);
      }, CLEAR_MS);
    }, wait);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      if (clearId) window.clearTimeout(clearId);
    };
  }, [phase, index, reduceMotion, scenes.length]);

  useEffect(() => {
    onIndexRef.current?.(reduceMotion ? 0 : index);
  }, [index, reduceMotion]);

  const scene = scenes[reduceMotion ? 0 : index];
  const showReply = reduceMotion || phase === "reply";

  return (
    <div className="pd-phone" aria-label={label}>
      <div className="pd-screen">
        <div className="pd-bar">
          <i className="fa-brands fa-whatsapp" aria-hidden />
          MOOPE Assessor
        </div>
        <div className={`pd-chat${clearing ? " pd-clearing" : ""}`}>
          <div className="pd-bubble pd-user pd-in" key={`${index}-ask`}>
            {scene.ask}
            <small>você</small>
          </div>
          {showReply ? (
            <div className="pd-bubble pd-bot pd-in" key={`${index}-reply`}>
              {scene.reply}
              {scene.map ? <MiniMap {...scene.map} /> : null}
              <small>MOOPE Assessor</small>
            </div>
          ) : (
            <div className="pd-typing" aria-hidden>
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
        <p className="pd-step">
          Exemplo {reduceMotion ? 1 : index + 1} de {scenes.length}
        </p>
      </div>
    </div>
  );
}
