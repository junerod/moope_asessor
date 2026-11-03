import type { Metadata } from "next";
import { HelpChrome } from "@/components/help/HelpChrome";
import { PAINEL_ASKS } from "@/domain/painel-menu";

export const metadata: Metadata = {
  title: "Como pedir o painel · MOOPE Assessor",
  description:
    "Os números não ficam nesta página. O pedido sai do WhatsApp e volta um link único.",
};

export default function PainelPage() {
  return (
    <HelpChrome>
      <section className="hero">
        <div className="eyebrow">
          <i className="fa-solid fa-lock" aria-hidden />
          Sem dados aqui
        </div>
        <h1>O pedido sai do celular</h1>
        <p className="lead">
          Este endereço não mostra número de ninguém. Você pede no WhatsApp.
          O Assessor cria um link único, com token, só com a resposta daquela
          frase. Outro cliente não abre o mesmo link. Vale 24 horas.
        </p>
      </section>

      <div className="painel-asks">
        {PAINEL_ASKS.map((group) => (
          <section key={group.title} className="block tone-blue">
            <div className="block-head">
              <div className="fa-wrap" aria-hidden>
                <i className="fa-solid fa-list" />
              </div>
              <h3>{group.title}</h3>
            </div>
            <p>Manda uma destas frases no Zap. A resposta traz o link.</p>
            <ol className="phrase-list">
              {group.phrases.map((phrase) => (
                <li key={phrase}>{phrase}</li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      <aside className="tips">
        <h3>
          <i className="fa-solid fa-route" aria-hidden />
          Como funciona
        </h3>
        <ul>
          <li>No WhatsApp, diga painel se quiser esta lista de novo.</li>
          <li>Envie uma frase. A resposta traz os dados e um link Ver no celular.</li>
          <li>Esse link guarda só aquela consulta. Não busca a conta de outra pessoa.</li>
          <li>Depois de 24 horas o link para de abrir.</li>
        </ul>
      </aside>
    </HelpChrome>
  );
}
