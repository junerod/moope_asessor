import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Política de Privacidade · MOOPE Assessor",
  description: "Como o MOOPE Assessor trata dados pessoais.",
};

export default function PrivacidadePage() {
  return (
    <main style={wrap}>
      <p style={eyebrow}>
        <Link href="/">MOOPE Assessor</Link>
      </p>
      <h1 style={h1}>Política de Privacidade</h1>
      <p style={meta}>Versão 2026-09-19 · Domínio: assessor.moope.com.br</p>

      <section style={sec}>
        <h2 style={h2}>1. Quem somos</h2>
        <p>
          Esta política descreve como a MOOPE trata dados pessoais no produto
          MOOPE Assessor (“Assessor”), acessível principalmente via WhatsApp e
          páginas em assessor.moope.com.br.
        </p>
      </section>

      <section style={sec}>
        <h2 style={h2}>2. Dados que podemos tratar</h2>
        <ul>
          <li>Identidade de WhatsApp (número) e dados de cadastro (nome, e-mail).</li>
          <li>
            Conteúdo das conversas e arquivos que você envia (texto, áudio,
            imagens, PDFs), na medida necessária para prestar o serviço.
          </li>
          <li>
            Dados de agenda, lembretes, gastos e memórias que você pede para
            guardar.
          </li>
          <li>
            Tokens de integração (ex.: Google), armazenados de forma segura,
            quando você autoriza.
          </li>
          <li>Logs técnicos de operação, segurança e diagnóstico.</li>
        </ul>
      </section>

      <section style={sec}>
        <h2 style={h2}>3. Finalidades</h2>
        <ul>
          <li>Prestar e melhorar o Assessor (respostas, lembretes, relatórios).</li>
          <li>Autenticar e manter sua conta / workspace.</li>
          <li>Cumprir obrigações legais e prevenir abuso.</li>
          <li>
            Integrar serviços que você autorizar (Google Agenda/Sheets, sistemas
            parceiros).
          </li>
        </ul>
      </section>

      <section style={sec}>
        <h2 style={h2}>4. Bases e compartilhamento</h2>
        <p>
          Tratamos dados com base na execução do contrato de uso, no seu
          consentimento (quando aplicável) e em legítimo interesse operacional,
          sempre de forma proporcional. Podemos usar subprocessadores de
          infraestrutura (hospedagem, e-mail, WhatsApp/BSP, provedores de IA)
          sob contratos adequados. Não vendemos seus dados pessoais.
        </p>
      </section>

      <section style={sec}>
        <h2 style={h2}>5. Retenção e segurança</h2>
        <p>
          Mantemos os dados enquanto sua conta estiver ativa e pelo tempo
          necessário às finalidades ou exigências legais. Aplicamos medidas
          técnicas razoáveis (controle de acesso, criptografia de segredos,
          segregação por workspace).
        </p>
      </section>

      <section style={sec}>
        <h2 style={h2}>6. Seus direitos (LGPD)</h2>
        <p>
          Você pode solicitar acesso, correção, exclusão, portabilidade e
          informações sobre o tratamento, pelos canais de suporte MOOPE / Assessor,
          observados os limites legais.
        </p>
      </section>

      <section style={sec}>
        <h2 style={h2}>7. Google e outros provedores</h2>
        <p>
          Se você conectar o Google, o Assessor acessa apenas os escopos
          autorizados (ex.: eventos de agenda, planilhas) para sincronizar o que
          você pedir. Você pode desconectar no Assessor (“desconectar google”)
          ou revogar em myaccount.google.com.
        </p>
      </section>

      <section style={sec}>
        <h2 style={h2}>8. Contato</h2>
        <p>
          Encarregado / privacidade: use o suporte MOOPE já conhecido pela sua
          empresa, ou o próprio WhatsApp do Assessor solicitando “privacidade” /
          exclusão de dados.
        </p>
      </section>

      <p style={foot}>
        <Link href="/legal/termos">Termos de Serviço</Link>
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
