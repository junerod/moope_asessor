import type { Metadata } from "next";
import Link from "next/link";
import { HelpChrome } from "@/components/help/HelpChrome";
import { getAssessorWhatsAppPublic } from "@/lib/assessor-whatsapp";

export const metadata: Metadata = {
  title: "Começar · MOOPE Assessor",
  description:
    "Abra o MOOPE Assessor no WhatsApp e comece: gastos, agenda e lembretes.",
};

export const dynamic = "force-dynamic";

export default async function AjudaHubPage() {
  const wa = await getAssessorWhatsAppPublic();

  return (
    <HelpChrome>
      <section className="hero hero-start">
        <div className="eyebrow">
          <i className="fa-brands fa-whatsapp" aria-hidden />
          MOOPE Assessor
        </div>
        <h1>Comece pelo WhatsApp</h1>
        <p className="lead">
          Seu Assessor pessoal organiza gastos, agenda e lembretes — conversando.
          Abra o número oficial e diga oi.
        </p>
        <div className="hero-cta">
          {wa.waUrl ? (
            <a
              className="btn btn-wa"
              href={wa.waUrl}
              target="_blank"
              rel="noreferrer"
            >
              <i className="fa-brands fa-whatsapp" aria-hidden />
              Abrir o Assessor
            </a>
          ) : null}
          <Link className="btn btn-secondary hero-cta-ghost" href="/ajuda/pessoal">
            Ver o que ele faz
          </Link>
        </div>
        {wa.display ? (
          <p className="hero-wa-num">WhatsApp {wa.display}</p>
        ) : null}
      </section>

      <section className="start-box" aria-label="Primeiros passos">
        <h2>Primeiros passos</h2>
        <ol className="start-steps">
          <li>
            <strong>Abra o Assessor</strong> no botão acima (WhatsApp).
          </li>
          <li>
            Diga <em>anota 40 de café</em> ou <em>me lembra amanhã às 9h…</em>
          </li>
          <li>
            Depois: <em>o que tenho hoje?</em> — e dê baixa com{" "}
            <em>baixa 1</em>.
          </li>
        </ol>
      </section>

      <section className="help-section-head help-section-tight">
        <h2>Quer ir além?</h2>
        <p>Manuais curtos quando precisar — o dia a dia é no Zap.</p>
      </section>

      <div className="grid-cards grid-cards-3 grid-cards-compact">
        <Link href="/ajuda/pessoal" className="pick-card pick-card-compact">
          <div
            className="icon-badge"
            style={{
              background: "linear-gradient(135deg,#26c6da,#1565c0)",
            }}
          >
            <i className="fa-solid fa-user" aria-hidden />
          </div>
          <h2>Pessoal</h2>
          <p>Gastos, agenda, cobrança e o que pedir no Zap.</p>
        </Link>

        <Link href="/ajuda/locadora" className="pick-card pick-card-compact">
          <div
            className="icon-badge"
            style={{
              background: "linear-gradient(135deg,#ffca28,#fb8c00)",
              color: "#3e2723",
            }}
          >
            <i className="fa-solid fa-car" aria-hidden />
          </div>
          <h2>Locadora</h2>
          <p>Frota e caixa via MOOPE Gestão.</p>
        </Link>

        <Link href="/ajuda/crm" className="pick-card pick-card-compact">
          <div
            className="icon-badge"
            style={{
              background: "linear-gradient(135deg,#66bb6a,#2e7d32)",
            }}
          >
            <i className="fa-solid fa-bell" aria-hidden />
          </div>
          <h2>CRM</h2>
          <p>Aviso de lead novo, de resposta, e a lista do dia.</p>
        </Link>

        <Link href="/ajuda/facejus" className="pick-card pick-card-compact">
          <div
            className="icon-badge"
            style={{
              background: "linear-gradient(135deg,#455a64,#263238)",
            }}
          >
            <i className="fa-solid fa-scale-balanced" aria-hidden />
          </div>
          <h2>Facejus</h2>
          <p>Processos, atendimento e prazos do escritório.</p>
        </Link>
      </div>
    </HelpChrome>
  );
}
