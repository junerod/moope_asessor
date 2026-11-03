import type { Metadata } from "next";
import { getAssessorWhatsAppPublic } from "@/lib/assessor-whatsapp";
import { PhoneChat } from "@/components/landing/PhoneChat";
import { PESSOAL_SCENES } from "@/components/landing/phone-scenes";
import "./landing.css";

export const metadata: Metadata = {
  title: "MOOPE Assessor — assistente pessoal no WhatsApp",
  description:
    "Organize gastos, agenda e lembretes conversando no WhatsApp. Abra o Assessor e comece agora.",
};

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const wa = await getAssessorWhatsAppPublic();

  return (
    <main className="lp">
      <section className="lp-hero" aria-label="MOOPE Assessor">
        <div className="lp-hero-bg" aria-hidden />
        <div className="lp-hero-inner">
          <div>
            <div className="lp-brand">
              <img
                src="/brand/moope-assessor-logo.png"
                alt="MOOPE Assessor"
                width={72}
                height={72}
              />
              <div className="lp-brand-text">
                <strong>MOOPE Assessor</strong>
                <span>no WhatsApp</span>
              </div>
            </div>

            <h1>Pessoal, locadora e escritório. No mesmo Zap.</h1>
            <p className="lp-hero-lead">
              Você fala como fala com uma pessoa. Ele anota, avisa, acha o
              carro e o processo.
            </p>

            <div className="lp-cta">
              {wa.waUrl ? (
                <a
                  className="lp-btn lp-btn-wa"
                  href={wa.waUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <i className="fa-brands fa-whatsapp" aria-hidden />
                  Abrir o Assessor
                </a>
              ) : (
                <a className="lp-btn lp-btn-wa" href="/ajuda">
                  <i className="fa-brands fa-whatsapp" aria-hidden />
                  Como começar
                </a>
              )}
              <a className="lp-btn lp-btn-accent" href="/ajuda/pessoal">
                Como usar agora
              </a>
            </div>
            {wa.display ? (
              <p className="lp-wa-hint">
                WhatsApp {wa.display}
              </p>
            ) : null}
          </div>

          <PhoneChat scenes={PESSOAL_SCENES} label="Exemplos pessoais" />
        </div>
      </section>

      <section className="lp-section lp-offers-wrap" aria-label="Para quem é">
        <div className="lp-offers">
          <article className="lp-offer" id="pessoal">
            <span className="lp-offer-ico pessoal">
              <i className="fa-solid fa-user" aria-hidden />
            </span>
            <p className="lp-eyebrow">Uso pessoal</p>
            <h2>O dia cabe numa conversa</h2>
            <p>Gasto, lembrete, rota e grupo. Sem instalar outro app.</p>
            <ul>
              <li>anota 50 de mercado</li>
              <li>me lembra amanhã às 8h</li>
              <li>o que tenho hoje?</li>
            </ul>
            <a className="lp-offer-go" href="/ajuda/pessoal">
              Como usar agora
            </a>
          </article>

          <article className="lp-offer" id="locadora">
            <span className="lp-offer-ico locadora">
              <i className="fa-solid fa-truck" aria-hidden />
            </span>
            <p className="lp-eyebrow">Locadora</p>
            <h2>A frota atende no Zap</h2>
            <p>
              Placa, contrato, vistoria e o rendimento — quando a locadora
              libera o seu número.
            </p>
            <ul>
              <li>onde está a placa ABC1D23</li>
              <li>rendimentos da locadora</li>
              <li>quem está com o carro</li>
            </ul>
            <a className="lp-offer-go" href="/ajuda/locadora">
              Ver o manual da locadora
            </a>
          </article>

          <article className="lp-offer" id="facejus">
            <span className="lp-offer-ico facejus">
              <i className="fa-solid fa-scale-balanced" aria-hidden />
            </span>
            <p className="lp-eyebrow">Jurídico</p>
            <h2>O escritório, sem abrir o sistema</h2>
            <p>
              Processo, andamento, atendimento e prazos. Sócio vê o escritório.
              Advogado vê o que é dele.
            </p>
            <ul>
              <li>agenda de atendimento</li>
              <li>agenda de prazos processuais</li>
              <li>meus processos</li>
            </ul>
            <a className="lp-offer-go" href="/ajuda/facejus">
              Ver o manual do Facejus
            </a>
          </article>
        </div>
        <p className="lp-offers-note">
          O mesmo número. O uso pessoal continua quando a locadora ou o
          escritório entra.
        </p>
      </section>

      <footer className="lp-footer">
        <div className="lp-footer-brand">
          <img
            src="/brand/moope-assessor-logo.png"
            alt=""
            width={40}
            height={40}
          />
          <span>MOOPE Assessor</span>
        </div>
        <div>
          <a href="/ajuda/pessoal">Como usar agora</a>
          {" · "}
          <a href="/painel">Como pedir</a>
          {" · "}
          <a href="https://moope.com.br" target="_blank" rel="noreferrer">
            moope.com.br
          </a>
        </div>
      </footer>
    </main>
  );
}
