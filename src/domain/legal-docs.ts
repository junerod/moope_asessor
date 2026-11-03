/**
 * Termos e privacidade oficiais do Assessor.
 * Pedido de “termos de privacidade” nunca pode cair no FAQ comercial da MOOPE.
 */

export const PRIVACY_URL = "https://assessor.moope.com.br/legal/privacidade";
export const TERMS_URL = "https://assessor.moope.com.br/legal/termos";
export const LEGAL_VERSION = "2026-09-19";
export const TERMS_VERSION = "2026-10-22";

function fold(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function legalDocKind(text: string): "privacy" | "terms" | null {
  const q = fold(text).trim();
  if (!q || q.length > 180) return null;
  if (
    /\b(contrato|locacao|locadora|frota|placa|facejus|escritorio|vistoria)\b/.test(
      q
    )
  ) {
    return null;
  }
  if (
    /\b(lgpd|privacidade|exclusao de dados|apagar meus dados|meus dados pessoais)\b/.test(
      q
    ) ||
    /termos?\s+de\s+privacidade/.test(q) ||
    /politica de privacidade/.test(q)
  ) {
    return "privacy";
  }
  if (/termos?\s+de\s+(uso|servico)/.test(q) || /termos e condicoes/.test(q)) {
    return "terms";
  }
  if (
    /(mostra|mostre|manda|envie|quero|quais|ver|ler|leia).{0,28}termos/.test(q) ||
    /^(os )?termos\??$/.test(q)
  ) {
    return "terms";
  }
  return null;
}

export function looksLikeLegalAsk(text: string): boolean {
  return legalDocKind(text) !== null;
}

export function formatPrivacyPolicy(): string {
  return [
    "🔒 *Política de Privacidade — MOOPE Assessor*",
    `Versão ${LEGAL_VERSION}`,
    "",
    "*1. Quem somos*",
    "Esta política descreve como a MOOPE trata dados pessoais no Assessor, pelo WhatsApp e em assessor.moope.com.br.",
    "",
    "*2. Dados que podemos tratar*",
    "• Número de WhatsApp e cadastro (nome, e-mail)",
    "• Conteúdo das conversas e arquivos que você envia (texto, áudio, fotos, PDFs), só o necessário para prestar o serviço",
    "• Agenda, lembretes, gastos e memórias que você pede para guardar",
    "• Tokens de integração (ex.: Google), quando você autoriza",
    "• Logs técnicos de operação, segurança e diagnóstico",
    "",
    "*3. Finalidades*",
    "• Prestar e melhorar o Assessor (respostas, lembretes, relatórios)",
    "• Autenticar e manter sua conta",
    "• Cumprir obrigações legais e prevenir abuso",
    "• Integrar serviços que você autorizar (Google Agenda/Sheets, sistemas parceiros)",
    "",
    "*4. Bases e compartilhamento*",
    "Tratamos dados na execução do contrato de uso, no seu consentimento quando aplicável e em legítimo interesse operacional, de forma proporcional. Podemos usar subprocessadores (hospedagem, e-mail, WhatsApp, IA) sob contrato. *Não vendemos seus dados pessoais.*",
    "",
    "*5. Retenção e segurança*",
    "Mantemos os dados enquanto a conta estiver ativa e pelo tempo exigido pela lei. Aplicamos controle de acesso, criptografia de segredos e segregação por workspace.",
    "",
    "*6. Seus direitos (LGPD)*",
    "Você pode pedir acesso, correção, exclusão, portabilidade e informações sobre o tratamento pelos canais de suporte MOOPE / Assessor, nos limites da lei.",
    "",
    "*7. Google e outros provedores*",
    "Se conectar o Google, o Assessor acessa só os escopos autorizados. Diga *desconectar google* ou revogue em myaccount.google.com.",
    "",
    "*8. Contato*",
    "Dúvidas de privacidade ou exclusão de dados: fale neste WhatsApp.",
    "",
    "O Assessor pode falhar. Uso indevido, perda de prazos, instabilidade e outros eventos estão nos Termos de Serviço.",
    "",
    `Texto completo: ${PRIVACY_URL}`,
    `Termos de Serviço: ${TERMS_URL}`,
  ].join("\n");
}

export function formatTermsOfService(): string {
  return [
    "📜 *Termos de Serviço — MOOPE Assessor*",
    `Versão ${TERMS_VERSION}`,
    "",
    "*1. O serviço*",
    "O Assessor é o assistente da MOOPE no WhatsApp: organização pessoal (lembretes, agenda, gastos, documentos) e, quando habilitado, integrações (locadora, Facejus).",
    "",
    "*2. Aceite*",
    `Ao usar o WhatsApp e responder “aceito” no cadastro, você concorda com estes Termos e com a Política de Privacidade: ${PRIVACY_URL}`,
    "",
    "*3. Conta e responsabilidade*",
    "• Você é responsável pelas informações que envia.",
    "• Não use o serviço para fins ilegais, spam ou para prejudicar terceiros.",
    "• O Assessor pode errar; confirme dados críticos (valores, horários, obrigações) antes de agir.",
    "",
    "*4. Integrações*",
    "Google Agenda/Sheets e outros exigem autorização sua. Você pode revogar a qualquer momento.",
    "",
    "*5. Disponibilidade*",
    "O serviço depende de WhatsApp, internet e provedores externos. Interrupções podem ocorrer.",
    "",
    "*6. O que a MOOPE não se responsabiliza*",
    "O Assessor é só apoio. Não substitui advogado, contador, gestor nem decisão sua. Confira prazos, valores e qualquer informação crítica.",
    "A MOOPE *não se responsabiliza* por:",
    "• uso indevido do serviço por você ou por terceiros",
    "• perda de prazos (judiciais, processuais, contratuais, pessoais ou outros)",
    "• lembrete, aviso ou mensagem que falhou, atrasou ou não saiu",
    "• instabilidade, queda ou falta do Assessor, do WhatsApp ou de terceiros",
    "• erro da IA, dado incompleto ou resposta errada",
    "• perda ou atraso de dados causados por provedores externos",
    "• qualquer outro dano, prejuízo ou consequência do uso ou da falta do serviço",
    "O serviço é oferecido no estado em que se encontra. O que a lei brasileira não deixa excluir, permanece.",
    "",
    "*7. Alterações*",
    "A versão vigente fica neste endereço. Uso continuado após aviso razoável implica aceite.",
    "",
    "*8. Contato*",
    "Dúvidas: neste WhatsApp ou no suporte MOOPE da sua empresa.",
    "",
    `Texto completo: ${TERMS_URL}`,
    `Política de Privacidade: ${PRIVACY_URL}`,
  ].join("\n");
}

export function formatLegalReply(text: string): string | null {
  const kind = legalDocKind(text);
  if (kind === "terms") return formatTermsOfService();
  if (kind === "privacy") return formatPrivacyPolicy();
  return null;
}
