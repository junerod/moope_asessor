import type { Metadata } from "next";
import "./not-found.css";

export const metadata: Metadata = {
  title: "Página não encontrada — MOOPE Assessor",
};

export default function NotFound() {
  return (
    <main className="nf">
      <div className="nf-bg" aria-hidden />
      <section className="nf-card">
        <img
          src="/brand/moope-assessor-logo.png"
          alt="MOOPE Assessor"
          width={72}
          height={72}
        />
        <p className="nf-brand">MOOPE Assessor</p>
        <h1>Não achei essa página</h1>
        <p className="nf-lead">
          Procurei no WhatsApp, na agenda e até debaixo do sofá. Esse endereço
          não existe — ou mudou de lugar.
        </p>
        <div className="nf-bubble" aria-hidden>
          <span>Posso te levar de volta?</span>
        </div>
        <div className="nf-actions">
          <a className="nf-btn nf-btn-main" href="/">
            Voltar ao início
          </a>
          <a className="nf-btn" href="/ajuda">
            Como usar
          </a>
        </div>
      </section>
    </main>
  );
}
