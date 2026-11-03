export type PhoneMap =
  | { mode: "route"; from: string; to: string; minutes: string }
  | { mode: "pin"; label: string; place: string };

export type PhoneScene = {
  ask: string;
  reply: string;
  map?: PhoneMap;
};

export const PESSOAL_SCENES: PhoneScene[] = [
  {
    ask: "anota 48 de almoço",
    reply: "Pronto. R$ 48,00 em alimentação.",
  },
  {
    ask: "me lembra amanhã às 9h do dentista",
    reply: "Lembrete marcado para amanhã, 9h.",
  },
  {
    ask: "o que tenho hoje?",
    reply: "Seu dia\n1. Dentista · 09:00\n2. Conta de luz · 18:00",
  },
  {
    ask: "quanto tempo até o aeroporto?",
    reply: "Cerca de 42 min no mapa agora.",
    map: {
      mode: "route",
      from: "Asa Sul",
      to: "Aeroporto",
      minutes: "42 min",
    },
  },
  {
    ask: "cotação do dólar",
    reply: "Dólar · R$ 5,42 na compra.",
  },
];

export const LOCADORA_SCENES: PhoneScene[] = [
  {
    ask: "resumo da locadora",
    reply: "Frota agora\n18 disponíveis\n42 alugados\n3 em manutenção",
  },
  {
    ask: "onde está o carro ABC1D23",
    reply: "ABC1D23 está online. Bateria 12,4 V.",
    map: { mode: "pin", label: "ABC1D23", place: "Asa Norte" },
  },
  {
    ask: "alertas da locadora",
    reply: "2 fora há 24h\n1 fora há 48h\n4 TAG para olhar",
  },
  {
    ask: "quem está com o carro ABC1D23",
    reply: "João Silva · devolve sexta\n6 contratos a vencer na semana",
  },
  {
    ask: "vistorias abertas",
    reply: "5 vistorias abertas\n2 OS no mês\n1 CNH a vencer",
  },
  {
    ask: "multas a pagar",
    reply: "1 sinistro aberto\n3 multas a pagar\nValor só para gerente ou financeiro",
  },
  {
    ask: "receita deste mês",
    reply: "Receita R$ 86 mil\nRecebido hoje R$ 2.400\nInadimplência R$ 4.100",
  },
];

export const CRM_SCENES: PhoneScene[] = [
  {
    ask: "ligar alerta lead",
    reply: "Alerta de lead ligado. Cliente novo chega neste WhatsApp.",
  },
  {
    ask: "ligar alerta resposta",
    reply: "Alerta de resposta ligado. Quando o lead responder, eu aviso.",
  },
  {
    ask: "leads do dia",
    reply: "Leads de hoje\n3 no recorte.\nO restante está no painel.",
  },
  {
    ask: "quem respondeu hoje",
    reply: "Quem falou hoje\nAna · 14h\nCarlos · 16h",
  },
];

export const FACEJUS_SCENES: PhoneScene[] = [
  {
    ask: "meus processos",
    reply: "28 ativos no seu escopo\n11 arquivados\nPapel: advogado",
  },
  {
    ask: "processos do cliente Marilene",
    reply: "2 processos\nBusca por nome, CPF ou número CNJ",
  },
  {
    ask: "resumo do escritório",
    reply: "140 ativos\n46 previdenciário\n22 na filial Içara",
  },
  {
    ask: "andamento do processo 0001234-56.2024",
    reply: "Ontem · juntada\nAtualizado no Facejus",
  },
  {
    ask: "agenda de atendimento",
    reply: "Por filial\nIçara · 2 consultas\nOAB é opcional",
  },
  {
    ask: "agenda de prazos processuais",
    reply: "Prazos de hoje\n09:30 audiência\nPDF no painel",
  },
  {
    ask: "PDF agenda de atendimento",
    reply: "PDF da lista chega neste Zap.\nPainel também baixa o arquivo.",
  },
  {
    ask: "onde estou?",
    reply: "Agora: escritório Facejus.\nDiga trocar empresa para a locadora.\nO pessoal continua neste Zap.",
  },
];
