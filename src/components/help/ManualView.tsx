import type { ReactNode } from "react";
import type { ManualDoc } from "@/content/help-manuals";
import { RichText } from "@/components/help/RichText";

function toneClass(tone?: string) {
  return tone ? `tone-${tone}` : "tone-blue";
}

export function ManualView({
  doc,
  demo,
  notice,
}: {
  doc: ManualDoc;
  demo?: ReactNode;
  notice?: ReactNode;
}) {
  const hero = (
      <section className="hero">
        <div className="eyebrow">
          <i className="fa-solid fa-book-open" aria-hidden />
          {doc.eyebrow}
        </div>
        <h1>{doc.title}</h1>
        <p className="lead">{doc.lead}</p>
        <div className="audience">
          <i className="fa-solid fa-user-check" aria-hidden />
          <span>
            <RichText text={doc.audience} />
          </span>
        </div>
      </section>
  );

  return (
    <>
      {demo ? (
        <div className="help-hero-row">
          {hero}
          <div className="help-hero-phone">{demo}</div>
        </div>
      ) : (
        hero
      )}

      {notice}

      <aside className="privacy-card" aria-label="Privacidade e seus dados">
        <div className="privacy-card-icon" aria-hidden>
          <i className="fa-solid fa-shield-halved" />
        </div>
        <div className="privacy-card-body">
          <h2>Seus dados, com respeito</h2>
          <p>
            O Assessor existe pra te ajudar — <strong>não pra vender ou expor
            sua vida</strong>. Não vendemos seus dados. Suas conversas e
            arquivos não viram marketing pra terceiros. O atendimento no
            WhatsApp fica no canal da Meta, com a segurança própria do app.
            Acesso interno só o mínimo pra operar e proteger o serviço — não
            pra “ficar lendo” o seu Zap.
          </p>
          <p className="privacy-card-link">
            <a href="/legal/privacidade">Política de Privacidade (LGPD) →</a>
          </p>
        </div>
      </aside>

      {doc.whatsNew ? (
        <aside className="whats-new" aria-label="Novidades">
          <div className="whats-new-badge">Novo</div>
          <h2>{doc.whatsNew.title}</h2>
          {doc.whatsNew.lead ? <p className="whats-new-lead">{doc.whatsNew.lead}</p> : null}
          <ul>
            {doc.whatsNew.items.map((item) => (
              <li key={item}>
                <RichText text={item} />
              </li>
            ))}
          </ul>
        </aside>
      ) : null}

      {doc.blocks.map((b) => (
        <article key={b.title} className={`block ${toneClass(b.tone)}`}>
          <div className="block-head">
            <div className="fa-wrap" aria-hidden>
              <i className={`fa-solid ${b.icon}`} />
            </div>
            <h3>{b.title}</h3>
          </div>
          <p>
            <RichText text={b.body} />
          </p>
          {b.examples?.length ? (
            <div className="chips">
              {b.examples.map((ex) => (
                <span key={ex} className="chip">
                  “{ex}”
                </span>
              ))}
            </div>
          ) : null}
        </article>
      ))}

      <aside className="tips">
        <h3>
          <i className="fa-solid fa-lightbulb" aria-hidden />
          Dicas importantes
        </h3>
        <ul>
          {doc.tips.map((t) => (
            <li key={t}>
              <RichText text={t} />
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
