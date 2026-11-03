import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Termos de Serviço · MOOPE Assessor",
  description: "Termos de uso do MOOPE Assessor (WhatsApp).",
};

export default function TermosPage() {
  return (
    <main style={wrap}>
      <p style={eyebrow}>
        <Link href="/">MOOPE Assessor</Link>
      </p>
      <h1 style={h1}>Termos de Serviço</h1>
      <p style={meta}>Versão 2026-10-22 · Domínio: assessor.moope.com.br</p>

      <section style={sec}>
        <h2 style={h2}>1. O serviço</h2>
        <p>
          O MOOPE Assessor (“Assessor”) é um assistente conversacional via
          WhatsApp oferecido pela MOOPE, para organização pessoal (lembretes,
          agenda, gastos, documentos) e, quando habilitado, integrações com
          produtos parceiros (ex.: locadora, Facejus).
        </p>
      </section>

      <section style={sec}>
        <h2 style={h2}>2. Aceite</h2>
        <p>
          Ao iniciar o uso pelo WhatsApp e responder “aceito” no onboarding, você
          concorda com estes Termos e com a{" "}
          <Link href="/legal/privacidade">Política de Privacidade</Link>.
        </p>
      </section>

      <section style={sec}>
        <h2 style={h2}>3. Conta e responsabilidade</h2>
        <ul>
          <li>Você é responsável pelas informações que envia ao Assessor.</li>
          <li>
            Não use o serviço para fins ilegais, spam ou para prejudicar
            terceiros.
          </li>
          <li>
            O Assessor pode errar interpretações; confirme dados críticos
            (valores, horários, obrigações) antes de agir.
          </li>
        </ul>
      </section>

      <section style={sec}>
        <h2 style={h2}>4. Integrações de terceiros</h2>
        <p>
          Recursos opcionais (ex.: Google Agenda / Sheets) exigem autorização
          explícita na conta do provedor. Você pode revogar a qualquer momento
          (no Assessor ou no provedor). O uso dessas APIs também segue os termos
          do terceiro.
        </p>
      </section>

      <section style={sec}>
        <h2 style={h2}>5. Disponibilidade</h2>
        <p>
          Buscamos alta disponibilidade, mas o serviço depende de WhatsApp,
          internet e provedores externos. Interrupções podem ocorrer sem aviso
          prévio.
        </p>
      </section>

      <section style={sec}>
        <h2 style={h2}>6. Limitação de responsabilidade</h2>
        <p>
          O Assessor é ferramenta de apoio. Não substitui advogado, contador,
          gestor ou decisão humana. Você deve conferir prazos, valores,
          compromissos e qualquer informação crítica antes de agir.
        </p>
        <p>
          Na máxima extensão permitida pela lei brasileira, a MOOPE não se
          responsabiliza por:
        </p>
        <ul>
          <li>uso indevido do serviço por você ou por terceiros;</li>
          <li>
            perda de prazos de qualquer natureza (judiciais, processuais,
            contratuais, pessoais, fiscais ou outros);
          </li>
          <li>
            falha, atraso ou ausência de lembretes, avisos, resumos, mensagens
            ou relatórios;
          </li>
          <li>
            instabilidade, queda, atraso ou indisponibilidade do Assessor, do
            WhatsApp, da internet ou de provedores externos;
          </li>
          <li>
            erro de interpretação, dado incompleto ou resposta incorreta da IA;
          </li>
          <li>
            perda, atraso ou indisponibilidade de dados causados por terceiros;
          </li>
          <li>
            qualquer outro dano, prejuízo, lucro cessante ou consequência do
            uso ou da impossibilidade de uso do serviço.
          </li>
        </ul>
        <p>
          O serviço é oferecido no estado em que se encontra. Direitos que a
          legislação brasileira (inclusive o Código de Defesa do Consumidor e a
          LGPD) não permitem excluir ou limitar permanecem.
        </p>
      </section>

      <section style={sec}>
        <h2 style={h2}>7. Alterações</h2>
        <p>
          Podemos atualizar estes Termos. A versão vigente aparece neste
          endereço e no onboarding (TERMS_VERSION). Uso continuado após
          comunicação razoável implica aceite da nova versão.
        </p>
      </section>

      <section style={sec}>
        <h2 style={h2}>8. Contato</h2>
        <p>
          Dúvidas: fale pelo próprio WhatsApp do Assessor ou com o suporte MOOPE
          (canal comercial já utilizado pela sua empresa).
        </p>
      </section>

      <p style={foot}>
        <Link href="/legal/privacidade">Política de Privacidade</Link>
        {" · "}
        <Link href="/ajuda">Central de ajuda</Link>
      </p>
    </main>
  );
}

const wrap: React.CSSProperties = {
  maxWidth: 720,
  margin: "0 auto",
  padding: "48px 20px 80px",
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  lineHeight: 1.55,
  color: "#1a1a1a",
  background: "#fafafa",
  minHeight: "100vh",
};
const eyebrow: React.CSSProperties = { fontSize: 14, marginBottom: 8 };
const h1: React.CSSProperties = { fontSize: 28, margin: "0 0 8px", fontWeight: 700 };
const h2: React.CSSProperties = { fontSize: 18, margin: "0 0 8px", fontWeight: 650 };
const meta: React.CSSProperties = { color: "#666", fontSize: 14, marginBottom: 28 };
const sec: React.CSSProperties = { marginBottom: 22 };
const foot: React.CSSProperties = { marginTop: 40, fontSize: 14, color: "#444" };
