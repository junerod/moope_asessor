import { publicAppBaseUrl } from "@/lib/public-url";

/** Conteúdo dos manuais HTML. Nunca citar Traccar — sempre Moope. */

export type ManualBlock = {
  icon: string; // Font Awesome class, e.g. "fa-wallet"
  title: string;
  body: string;
  examples?: string[];
  tone?: "blue" | "cyan" | "yellow" | "green" | "orange";
};

export type ManualDoc = {
  slug: "pessoal" | "locadora" | "facejus" | "crm";
  title: string;
  eyebrow: string;
  lead: string;
  audience: string;
  /** Faixa de novidades no topo (opcional) */
  whatsNew?: {
    title: string;
    lead?: string;
    items: string[];
  };
  blocks: ManualBlock[];
  tips: string[];
  footerNote: string;
};

/** Base pública — em produção nunca é localhost (ver publicAppBaseUrl). */
export const HELP_BASE = publicAppBaseUrl();

/** Links curtos para o cliente (texto amigável no HTML; URL fica no href). */
export const LINK_FROTAS = "https://frotas.moope.com.br";
export const LINK_FROTAS_ASSESSOR =
  "https://frotas.moope.com.br/empresaassessormoope";
export const LINK_MOOPE = "https://moope.com.br";
export const MD_FROTAS = `[acessar: Gestão de frotas](${LINK_FROTAS})`;
export const MD_FROTAS_ASSESSOR = `[acessar: Gestão de frotas](${LINK_FROTAS_ASSESSOR})`;
export const MD_MOOPE = `[acessar: moope.com.br](${LINK_MOOPE})`;
export const MD_AJUDA = `[acessar: Central de ajuda](${HELP_BASE}/ajuda)`;
export const MD_AJUDA_PESSOAL = `[acessar: Manual pessoal](${HELP_BASE}/ajuda/pessoal)`;
export const MD_AJUDA_LOCADORA = `[acessar: Manual locadora](${HELP_BASE}/ajuda/locadora)`;
export const MD_AJUDA_FACEJUS = `[acessar: Manual Facejus](${HELP_BASE}/ajuda/facejus)`;
export const MD_AJUDA_CRM = `[acessar: Manual CRM](${HELP_BASE}/ajuda/crm)`;
export const LINK_CRM = "https://crm.facejus.com.br";
export const LINK_FACEJUS = "https://web.facejus.com.br";
export const MD_FACEJUS = `[acessar: Facejus](${LINK_FACEJUS})`;

export const MANUAL_PESSOAL: ManualDoc = {
  slug: "pessoal",
  title: "Manual do Assessor Pessoal",
  eyebrow: "MOOPE Assessor · uso pessoal",
  lead:
    "Seu parceiro no WhatsApp: agenda, dinheiro, tempo, rotas e o dia a dia — em português natural, sem app extra. Fale como fala com uma pessoa.",
  audience:
    "Para quem usa o MOOPE Assessor no dia a dia pessoal (e ainda não liberou a locadora no MOOPE Gestão).",
  whatsNew: {
    title: "✨ Novidades",
    lead:
      "Resumo do que chegou de novo. Em cada bloco abaixo tem a explicação completa e exemplos pra copiar.",
    items: [
      "💸 *Cobrar agora* — “José me deve R$ 50 cobre ele agora”. Sem *sim*. Se não tiver o número, manda o contato. Vai no template, com o link do *seu* Zap.",
      "📞 *Número errado* — “troca o telefone do José” e manda o contato certo.",
      "📒 *Quem me deve* — “emprestei 200 pro Lucas” · “quem me deve?” · “recebi 200 do Lucas”.",
      "📅 *Livre e choque* — “sexta de manhã livre?” · “tem choque na agenda?” · “me dá um link pra a pessoa marcar”.",
      "🔁 *Todo mês* — “Academia 89,90 todo mês” · teto avisa em *70%* · “como está o teto”.",
      "📝 *Ata e tom* — “faz a ata” · no rascunho de aviso: “mais curto” ou “mais formal”.",
      "📎 *Pasta e atraso* — arquivo cai em pasta · “acha a foto do RG” · “projeto Casa: pintar muro até sexta” · “tarefas atrasadas”.",
      "✉️ *Convite* — “tem convite no email?” · *sim 1* confirma no Google.",
    ],
  },
  blocks: [
    {
      icon: "fa-microphone",
      title: "Áudio → ação",
      body: "Não precisa digitar. Mande um *áudio* no Zap como se estivesse falando comigo. Eu transcrevo e executo o pedido — lembrete, gasto, tempo, rota, câmbio… A resposta começa com “Ouvi: …” pra você conferir se entendi certo.",
      examples: [
        "(áudio) me lembra amanhã às 9h de ligar pro dentista",
        "(áudio) quanto tempo até o aeroporto",
        "(áudio) cotação do dólar",
      ],
      tone: "blue",
    },
    {
      icon: "fa-comments",
      title: "Como falar comigo",
      body: "Escreva naturalmente — sem decorar comando. Em dúvida, pergunte o que eu sei fazer ou abra as preferências de avisos. Eu respondo no mesmo chat.",
      examples: [
        "bom dia",
        "preferências",
        "o que você pode fazer?",
        "ajuda",
      ],
      tone: "blue",
    },
    {
      icon: "fa-road",
      title: "Rotas e deslocamento",
      body: "Pra saber *quanto tempo demora daqui até um lugar*, se o trânsito está bom, ou pra receber o *mapa / link da rota*. Eu peço seu pin (📎 Localização) pra calcular de onde você está de verdade. Dá pra *salvar uma base* (casa ou trabalho) e não mandar pin toda vez.",
      examples: [
        "quanto tempo até o aeroporto",
        "quanto tempo demora daqui até Taguatinga",
        "me dá o mapa até o shopping",
        "rota até o dentista",
        "trânsito pra Brasília",
        "salvar base",
        "minha base",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-door-open",
      title: "Saí de casa",
      body: "Quando você tem *compromisso com horário e local*, eu cruzo a rota + o trânsito e digo *que horas sair* (com uma folga), pra não atrasar. Manda o pin pra origem precisa — ou use a base que você salvou.",
      examples: [
        "quando sair",
        "quando sair pro aeroporto",
        "que horas sair",
        "que horas sair pra reunião das 15h",
      ],
      tone: "orange",
    },
    {
      icon: "fa-cloud-sun",
      title: "Previsão do tempo",
      body: "Peça quando quiser — hoje, amanhã, a semana ou outra cidade. Também posso mandar no *bom-dia* ou num horário fixo só seu. Na primeira vez, diga a cidade e a UF.",
      examples: [
        "como está o tempo?",
        "tempo amanhã",
        "tempo em Curitiba PR",
        "me avisa o tempo todo dia às 7h",
      ],
      tone: "blue",
    },
    {
      icon: "fa-dollar-sign",
      title: "Câmbio e cotação",
      body: "Cotação limpa em card (dólar, euro…) e conversão rápida pra reais — sem aquele texto confuso de pesquisa na internet.",
      examples: [
        "cotação do dólar",
        "quanto está o euro?",
        "100 dólares em reais",
      ],
      tone: "green",
    },
    {
      icon: "fa-sun",
      title: "Resumo do dia (manhã)",
      body: "Entre 7h e 10h mando um *bom-dia* com a agenda, tarefas e o que vence. Se o dia estiver livre, mando um toque útil. Dá pra ligar ou desligar nas preferências.",
      examples: [
        "preferências",
        "desliga o resumo do dia",
        "o que tenho hoje?",
      ],
      tone: "yellow",
    },
    {
      icon: "fa-calendar-check",
      title: "Agenda, lembretes e dar baixa",
      body: "Compromisso, alerta e lembrete são a mesma lista. Diga *o que tenho hoje?* ou *o que tenho amanhã?* — vem tudo junto, numerado, inclusive o que está na Agenda Google. *Dar baixa* tira o item da fila: *baixa 1*. Se o horário bater com outro, eu aviso; responda *sim* para marcar mesmo assim, ou mande outro horário. *Sexta de manhã livre?* mostra os buracos. *Tem choque na agenda?* aponta dois no mesmo horário. *Me dá um link pra a pessoa marcar* abre só os horários livres — quem abre não vê o que você já tem. Coisa da locadora pede o nome: *compromissos da locadora*, *financeiro da locadora*, *inadimplentes*, *onde está a placa ABC1D23*.",
      examples: [
        "me lembra amanhã às 9h de ligar pro dentista",
        "toda segunda às 8h me lembre de tomar vitaminas",
        "o que tenho hoje?",
        "sexta de manhã livre?",
        "tem choque na agenda?",
        "me dá um link pra a pessoa marcar",
        "baixa 1",
        "baixa lembrete 1",
        "o que tenho essa semana?",
      ],
      tone: "blue",
    },
    {
      icon: "fa-link",
      title: "Google Agenda e planilha",
      body: "Conecte uma vez (*conectar google*). *Sincronizar agenda* puxa o que já está no Google. No *o que tenho hoje*, os eventos entram na mesma lista. Cerca de 30 min antes, eu aviso no Zap. Convite em aberto: *sim*, *não* ou *talvez*. Se ainda não estiver na agenda: *tem convite no email?* — se achar, responda *sim 1*.",
      examples: [
        "conectar google",
        "sincronizar agenda",
        "o que tenho hoje?",
        "tem convite no email?",
        "sim 1",
        "status google",
        "desconectar google",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-lightbulb",
      title: "Memória útil",
      body: "Guarde fatos do seu dia a dia (dentista, placa, preferências). Depois eu uso isso em lembretes e respostas, sem você precisar repetir tudo.",
      examples: [
        "lembra que meu dentista é Dr. Silva na Asa Sul",
        "minha placa é ABC1D23",
        "o que você lembra de mim?",
      ],
      tone: "green",
    },
    {
      icon: "fa-moon",
      title: "Encerramento do dia",
      body: "Por volta das 21h (ou no horário que você escolher) mando o que ainda está *aberto hoje*, com números. Responda *baixa 1* (ou *baixa lembrete 1* / *baixa agenda 1*) pra concluir e eu parar de cobrir. Dá pra mudar o horário ou desligar.",
      examples: [
        "preferências",
        "encerra às 20h",
        "desliga encerramento do dia",
        "liga encerramento do dia",
        "baixa 1",
        "baixa lembrete 2",
        "ainda não",
      ],
      tone: "yellow",
    },
    {
      icon: "fa-users",
      title: "Modo família",
      body: "Sua lista de contatos. Digite *família* e mande o cartão 📎. Para cobrar ou avisar alguém que *não usa* o Assessor, eu mando o *template* no Zap dela, com o link do *seu* número — ela fala com você, não comigo. Número errado: *troca o telefone do José* e manda o contato certo. Família e grupo de trabalho são coisas diferentes. Ninguém lê conversa alheia.",
      examples: [
        "família",
        "(📎 Contato da Ju)",
        "família Ju 61 99999-0000",
        "troca o telefone do José",
        "o telefone do José é 61 99999-0000",
        "esquece família Ju",
      ],
      tone: "blue",
    },
    {
      icon: "fa-people-group",
      title: "Grupos de trabalho",
        body: "*Criar um grupo:* diga `criar grupo CRM`. Na hora eu peço o nome e o número, ou o contato 📎. Quem já usa o Assessor recebe a mensagem do grupo direto. Quem ainda não usa recebe um convite oficial (template), inclusive em grupo de família, para o número não ser bloqueado. Para ver grupos, diga `meus grupos` ou `grupos`. Para ver as pessoas, `quem está no grupo CRM`, `grupo 1` ou `grupo CRM`. *Adicionar:* `adicionar Tatiana 11999998888 ao grupo CRM`. *Remover:* `remover Tatiana do grupo CRM`.\n\n*Avisar agora:* `reunião às 15h para o grupo Trabalho`. Quem já está no Assessor recebe *Fulano mandou avisar*. Quem ainda não usa recebe o convite oficial. *Lembrete com hora:* `me lembra amanhã às 10 reunião para o grupo Trabalho`. Se disser só `lembrete para o grupo Trabalho`, eu peço o texto e o horário.\n\n*Marcar reunião:* diga o assunto, a data e o horário. Se faltar a data ou o horário, eu pergunto. Se não disser quem participa, pergunto se será só você ou quem quer convidar. Exemplo: `crie reunião de produto amanhã às 17h com Meet e avise Tatiana da minha lista de Trabalho; me avise 10 minutos antes`. Se não disser a duração, considero 60 minutos. Antes de avisar qualquer pessoa, mostro nomes e telefones: escolha pelo número ou diga `todos`, confira e responda `confirmar`. Se houver muitas pessoas, diga `grupos` ou `grupo 1` para conferir a lista.\n\nCom o Google conectado, crio a sala Meet e coloco na sua Agenda. Sem conexão, você pode mandar um link HTTPS. Cada convidado externo precisa autorizar antes de receber; a reunião só é enviada depois da sua confirmação. Para encerrar a série, diga `cancelar reunião`; para parar só seus avisos, use `cancelar minha reunião 1` ou `baixa reunião 1`.",
      examples: [
        "criar grupo CRM",
        "meus grupos",
        "quem está no grupo CRM",
        "reunião às 15h para o grupo Trabalho",
        "me lembra amanhã às 10 reunião para o grupo Trabalho",
        "lembrete para o grupo Trabalho",
        "adicionar Tatiana ao grupo CRM",
        "adicionar Tatiana ao grupo 1",
        "adicionar João +55 61 99999-0000 ao grupo CRM",
        "(📎 contato da Tatiana)",
        "grupo 1",
        "convidar Ana para lembretes",
        "crie reunião de produto amanhã às 17h com Meet e avise Tatiana da minha lista de Trabalho",
        "me avise 10 minutos antes",
        "toda segunda às 17h reunião do time, criar Meet e avisar grupo Trabalho",
        "inclua este material: https://exemplo.com/apresentacao",
        "1",
        "todos",
        "confirmar",
        "cancelar reunião",
        "cancelar minha reunião 1",
        "baixa reunião 1",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-receipt",
      title: "Comprovante na hora",
      body: "Depois do lembrete de *conta ou boleto*, eu peço a foto do comprovante. Você manda a imagem e eu arquivo (e registro o gasto se der pra ler o valor). Também vale responder *já paguei* ou *depois*.",
      examples: [
        "já paguei",
        "depois",
        "(foto do comprovante)",
      ],
      tone: "orange",
    },
    {
      icon: "fa-wallet",
      title: "Gastos e notas fiscais",
      body: "Mande a *foto* da nota/recibo ou escreva o valor. Eu registro e você consulta por período ou categoria. Se a foto for de *boleto*, eu peço um “sim” bem claro antes de tratar como pago. Foto *sem legenda*: se for nota, cupom, boleto ou orçamento com valor, eu proponho o gasto e só gravo quando você responder *sim*. Se for comida, respondo kcal, proteína, gordura e carboidrato de cada item (por 100 g) e a média do prato. Se for outra foto, digo o que vi e pergunto se é para enviar a alguém ou só guardar.",
      examples: [
        "gastei R$ 80 de gasolina",
        "foto da nota do mercado",
        "(foto sem legenda de um cupom)",
        "(foto de um prato)",
        "quanto gastei esse mês?",
      ],
      tone: "green",
    },
    {
      icon: "fa-piggy-bank",
      title: "Receitas pessoais",
      body: "Guarde o que *entrou* (salário, freelance, reembolso). Isso entra no balanço do mês junto com os gastos.",
      examples: [
        "recebi 3500 do salário",
        "entrou 200 de reembolso",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-chart-pie",
      title: "Balanço e insights",
      body: "Panorama do mês em linguagem simples: quanto entrou, quanto saiu e se você está dentro da meta.",
      examples: [
        "balanço do mês",
        "quanto sobrou?",
        "como estou de gastos?",
      ],
      tone: "yellow",
    },
    {
      icon: "fa-bullseye",
      title: "Metas de gasto",
      body: "Defina um *teto mensal*. O radar avisa em *70%*, com os dias que faltam no mês. Se passar de *80%* ou estourar, o alerta sobe. *Como está o teto* mostra o mês. *Academia 89,90 todo mês* vira série, sem extrato de banco.",
      examples: [
        "quero gastar no máximo R$ 3000",
        "como está o teto",
        "Academia 89,90 todo mês",
        "como estou de gastos?",
        "isso saiu do padrão hoje?",
      ],
      tone: "orange",
    },
    {
      icon: "fa-file-pdf",
      title: "Relatórios PDF e Excel",
      body: "Peça um relatório e eu monto *PDF + planilha* pra guardar, imprimir ou compartilhar.",
      examples: [
        "me manda o relatório",
        "relatório de gastos do mês",
        "relatório de tarefas",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-pills",
      title: "Receitas médicas",
      body: "Mande a *foto da receita*. Eu guardo médico, remédio e dose pra você consultar depois sem vasculhar a galeria.",
      examples: [
        "foto da receita",
        "qual o nome do médico?",
        "mostra a receita",
      ],
      tone: "green",
    },
    {
      icon: "fa-cart-shopping",
      title: "Lista de mercado e pesquisa",
      body: "Listas rápidas pro mercado e pesquisas do dia a dia (preços, IPVA, etc.) — tudo no mesmo Zap.",
      examples: [
        "lista de mercado: leite, pão, café",
        "pesquisa preço médio de IPVA",
      ],
      tone: "yellow",
    },
    {
      icon: "fa-plane",
      title: "Modo viagem",
      body: "Quando você viaja, liga o *modo viagem* com a cidade. Eu ajusto o *fuso* dos lembretes e *silencio* avisos locais/Google da rotina, pra não te acordar no horário errado. Ao voltar: *desliga modo viagem*.",
      examples: [
        "modo viagem em Lisboa",
        "modo viagem Miami",
        "desliga modo viagem",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-hand-holding-dollar",
      title: "Cobrar agora",
      body: "Diga o nome, o valor e *agora* — eu mando na hora, *sem pedir sim*. Se o número não estiver na lista, manda o contato 📎 (ou o telefone) e eu envio, com ou sem cadastro no Assessor. O aviso vai no *template* oficial, com o link do *seu* Zap — a pessoa fala com você. Número errado: *troca o telefone do José*. Mudou de assunto ou *cancelar* — o rascunho cai.",
      examples: [
        "José me deve R$ 50 cobre ele agora",
        "cobra o José agora",
        "(📎 contato)",
        "troca o telefone do José",
        "cancelar",
      ],
      tone: "orange",
    },
    {
      icon: "fa-book",
      title: "Quem me deve",
      body: "Empréstimo e vale ficam na sua lista. *Quem me deve?* mostra o que está aberto. *Recebi 200 do Lucas* dá baixa. Isso não manda mensagem — pra cobrar de verdade, use *cobre ele agora*.",
      examples: [
        "emprestei 200 pro Lucas",
        "o José me deve R$ 50",
        "quem me deve?",
        "recebi 200 do Lucas",
      ],
      tone: "green",
    },
    {
      icon: "fa-pen-nib",
      title: "Tom do aviso",
      body: "No rascunho de um aviso, peça o tom. *Mais curto* ou *mais formal* reescreve o texto. Eu não invento horário.",
      examples: [
        "mais curto",
        "mais formal",
        "mais direto",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-clipboard",
      title: "Ata da reunião",
      body: "Depois da conversa, *faz a ata* guarda o que ficou combinado. Depois você pede de volta no mesmo Zap.",
      examples: [
        "faz a ata",
        "faz a ata: João fica com o contrato até sexta",
      ],
      tone: "yellow",
    },
    {
      icon: "fa-folder-open",
      title: "Pastas de documento",
      body: "Arquivo e foto caem numa pasta. Dá pra guardar de propósito e achar depois pelo nome — inclusive a foto do documento.",
      examples: [
        "guarda na pasta contratos",
        "documentos da pasta contratos",
        "acha a foto do RG",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-list-check",
      title: "Tarefa, projeto e atraso",
      body: "Dá pra amarrar a tarefa num projeto e numa data. *Tarefas atrasadas* mostra a fila. *Relatório de tarefas* manda PDF no Zap.",
      examples: [
        "projeto Casa: pintar muro até sexta",
        "tarefas atrasadas",
        "o que atrasou",
        "relatório de tarefas",
      ],
      tone: "orange",
    },
    {
      icon: "fa-handshake",
      title: "Lembrar de cobrar depois",
      body: "Se a cobrança *não* é agora, eu anoto pra te lembrar daqui a N dias — aquele “vou te retornar” que some. Isso é lembrete pra *você*, não mensagem pra outra pessoa. Pra mandar agora, use *cobre ele agora*.",
      examples: [
        "cobrar Pedro em 2 dias se não responder",
        "me lembra de cobrar a Ju amanhã",
      ],
      tone: "orange",
    },
    {
      icon: "fa-sliders",
      title: "Preferências de avisos",
      body: "Você manda no volume: resumo do dia, resumo semanal, alertas de meta/contas e encerramento do dia (com horário). Digite *preferências* pra ver o menu.",
      examples: [
        "preferências",
        "desliga o resumo semanal",
        "liga alertas de conta",
        "encerra às 20h",
        "desliga encerramento do dia",
        "desliga tudo",
      ],
      tone: "orange",
    },
    {
      icon: "fa-building",
      title: "Locadora no mesmo Zap",
      body: `Quando a locadora libera o seu número, as pessoas e a frota entram neste mesmo chat. *Investidores da locadora* mostra só quem tem veículo ativo, último repasse e o acumulado do ano. *Locatários da locadora* mostra atraso, a receber na semana, a receber no mês e o pago no mês — sem boleto cancelado. No card, a placa abre a ficha do carro. *Veículos da locadora* abre um card por carro ativo, com status e endereço. O nome do locatário abre a ficha dele no mesmo painel. O passo a passo completo está no ${MD_AJUDA_LOCADORA}.`,
      examples: [
        "investidores da locadora",
        "locatários da locadora",
        "veículos da locadora",
        "locatário Maria Souza",
      ],
      tone: "green",
    },
  ],
  tips: [
    "Privacidade: não vendemos seus dados; detalhes em [Política de Privacidade (LGPD)](https://assessor.moope.com.br/legal/privacidade).",
    "Google: conecte uma vez; o Assessor grava compromissos na Agenda e dados nas planilhas.",
    "Família: cadastre o contato 📎. Cobrança e aviso pra quem não usa o Assessor vão no template, com o link do *seu* Zap.",
    "Mudou de assunto ou *cancelar* — o rascunho de cobrança ou convite cai.",
    "Rotas: pin fresco (~45 min) = origem mais precisa; senão uso a base salva.",
    "Sem integração com o MOOPE Gestão: este manual cobre só o assistente pessoal.",
    `Se a locadora liberar seu WhatsApp no MOOPE Gestão (${MD_FROTAS}), use também o manual da locadora.`,
    "Em dúvida: “ajuda”, “preferências” ou “o que você pode fazer?”.",
  ],
  footerNote: `MOOPE Assessor · Manual pessoal · ${MD_MOOPE} · ${MD_AJUDA_PESSOAL}`,
};

export const MANUAL_LOCADORA: ManualDoc = {
  slug: "locadora",
  title: "Manual do Assessor da Locadora",
  eyebrow: "MOOPE Assessor ↔ MOOPE Gestão de Frotas e Locação",
  lead:
    "Com a integração ativa, o WhatsApp vira canal da sua locadora: frota, contratos, operação e financeiro — com acesso controlado por telefone e papel. Fale em português natural; eu busco os dados no MOOPE Gestão.",
  audience: `Para donos e equipes cuja locadora liberou o número em Configurações → Assessor MOOPE no MOOPE Gestão de Frotas e Locação (${MD_FROTAS_ASSESSOR}).`,
  blocks: [
    {
      icon: "fa-link",
      title: "Como liberar o acesso",
      body: `No MOOPE Gestão (${MD_FROTAS}), o *dono da conta* liga a integração e cadastra cada WhatsApp com um *papel* (gerente, financeiro, operação…). O 9 do celular é ajustado automaticamente. Depois é só perguntar no Zap se a integração está ok.`,
      examples: [
        "tenho integração moope locadora?",
        "o que o assessor pode fazer pela locadora?",
      ],
      tone: "blue",
    },
    {
      icon: "fa-user-shield",
      title: "Papéis por telefone",
      body: "Cada número tem um papel. *Gerente* e *Financeiro* veem valores em R$. *Operação* e *Atendimento* veem frota, contratos e operação — *sem* receita nem faturas. Assim o time usa o mesmo Assessor com o nível certo de informação.",
      examples: [
        "Gerente — visão completa + valores",
        "Financeiro — foco em R$",
        "Operação — frota e contratos, sem R$",
        "Atendimento — contratos e resumo, sem R$",
      ],
      tone: "yellow",
    },
    {
      icon: "fa-car",
      title: "Frota e disponibilidade",
      body: "Pergunte o panorama da frota: quantos disponíveis, em manutenção, por *filial* ou por *operação* (Uber, Particular — o texto que você cadastra e vincula no veículo). Para ver cada carro, peça *veículos da locadora*: o painel lista só os ativos, com locatário e status.",
      examples: [
        "resumo da locadora",
        "carros disponíveis",
        "veículos da locadora",
        "frota por operação",
        "carros da operação Uber",
        "frota por filial",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-car-side",
      title: "Veículos da locadora",
      body: "Diga *veículos da locadora* (ou *minha frota*). Eu abro um card por veículo ativo: placa, modelo, status (alugado, disponível, reservado ou em manutenção) e a última localização quando a placa está no rastreador Moope. O locatário vem do contrato que ocupa o carro, o mesmo vínculo da tela de veículos. Toque no nome do locatário e a ficha dele abre neste painel: documento, WhatsApp, quanto deve e a próxima parcela. Não sai para outra página. Toque na placa ou em *Abrir ficha* para o endereço, a hora e o mapa. O nome do motorista abre a ficha do motorista no MOOPE Gestão. Desmobilizado e vendido não entram. No fim, *Acessar MOOPE Frotas* abre a tela de veículos.",
      examples: [
        "veículos da locadora",
        "minha frota",
        "veículo ABC1D23",
        "veículo Argo",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-location-dot",
      title: "Onde está o carro",
      body: "Informe a *placa*. Eu respondo com endereço, link do mapa e se está online/offline. Quando o rastreador Moope enviar, mostro a bateria do veículo em volts; TAG mostra % da TAG.",
      examples: [
        "onde está o carro ABC1D23",
        "posição da placa ABC1D23",
      ],
      tone: "blue",
    },
    {
      icon: "fa-satellite-dish",
      title: "Alertas de rastreamento Moope",
      body: "Alertas por *placa* (não por aparelho): fora 24/48/72h, duplo offline, duplo misto e TAGs — pra você enxergar o que precisa de atenção na operação.",
      examples: [
        "alertas da locadora",
        "alertas de rastreamento",
      ],
      tone: "orange",
    },
    {
      icon: "fa-file-contract",
      title: "Contratos e devoluções",
      body: "Contratos ativos, a vencer, *quem está com a placa*, devoluções nas próximas 24h/7 dias e renovações da semana — tudo perguntando no Zap.",
      examples: [
        "contratos a vencer",
        "quem está com o carro ABC1D23",
        "devoluções dos próximos 7 dias",
        "renovações desta semana",
      ],
      tone: "green",
    },
    {
      icon: "fa-clipboard-check",
      title: "Vistorias, OS e CNH",
      body: "Vistorias abertas (com link do relatório), manutenções/OS no período, preventivas e CNH a vencer — pra não deixar nada passar. Quem pode agendar vistoria (o interruptor em Configurações → Assessor MOOPE) também lista quem não fez vistoria na semana, abre o relatório pelo número da lista e marca o horário na agenda de atendimento. O sim grava o horário; o não descarta. Sem o interruptor, a lista responde e o horário não grava.",
      examples: [
        "vistorias abertas",
        "vistoria da placa ABC1D23",
        "quais carros não fizeram vistoria esta semana",
        "vistoria 1",
        "agendar vistoria 1 amanhã 9h",
        "agenda de vistoria de amanhã",
        "manutenções do mês da placa ABC1D23",
        "CNH a vencer",
        "preventivas da semana",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-triangle-exclamation",
      title: "Sinistros e multas",
      body: "Liste sinistros em aberto e multas a pagar. Valores em R$ das multas só aparecem se o *papel* do telefone tiver acesso financeiro.",
      examples: [
        "sinistros abertos",
        "multas a pagar",
      ],
      tone: "orange",
    },
    {
      icon: "fa-coins",
      title: "Rendimentos da locadora",
      body: "Diga *rendimentos da locadora* (ou *lucro da locadora*). Eu trago o mesmo cálculo da tela Rendimentos da frota no MOOPE Gestão: receita de locação, outras receitas, custos, repasse do investidor, lucro da locadora, margem e os veículos em destaque. A mensagem no Zap vem organizada. No fim vai um link curto, válido por 24 horas. Quem abre no celular vê gráfico do mês, receita por mês e a lista de destaques, com borda nas laterais para o texto não cortar no iPhone nem no Android. Nesse painel dá para baixar *PDF da frota*, *PDF contábil*, *PDF executivo* e *Excel* — os mesmos arquivos da tela. Só aparece para o papel com acesso a valores (gerente ou financeiro). Isso não é o financeiro pessoal: peça sempre *da locadora*.",
      examples: [
        "rendimentos da locadora",
        "lucro da locadora",
        "me dá o rendimento da locadora",
      ],
      tone: "yellow",
    },
    {
      icon: "fa-coins",
      title: "Financeiro da locadora (R$)",
      body: "Além dos rendimentos, dá para pedir despesas, inadimplência, o que entra hoje ou na semana, fluxo de caixa, ticket médio e faturas. *Como está a locadora* mostra a receber no mês, na semana quando houver vencimento nesta semana, e o valor em atraso. *Rendimento da locadora* abre o painel de lucro. *Recebimentos* e *calendário de recebimentos* são outra coisa: a lista por vencimento, com pago, a vencer e atraso, e o link do calendário no MOOPE Gestão. Boleto cancelado não entra nesses totais. Os recebimentos respeitam o papel do seu WhatsApp. PDF e planilha do período: *PDF recebimentos hoje* ou *Excel recebimentos da semana*.",
      examples: [
        "receita deste mês",
        "quanto tenho para receber hoje?",
        "recebimentos desta semana",
        "calendário de recebimentos",
        "quanto tenho para receber amanhã?",
        "me manda PDF dos recebimentos de hoje",
        "me manda Excel dos recebimentos desta semana",
        "fluxo de caixa",
        "ticket médio",
        "inadimplência",
        "faturas da placa ABC1D23",
        "extrato do contrato da placa ABC1D23",
      ],
      tone: "yellow",
    },
    {
      icon: "fa-user-tie",
      title: "Investidores",
      body: "Diga *investidores da locadora*. Eu trago só quem tem veículo ativo, o último repasse pago, o acumulado do ano e quem está em aberto ou sem repasse. Repasse de R$ 0,00 conta como sem repasse. A data sai em dia/mês/ano. No celular, a lista inteira abre com busca por nome, placa, CPF, CNPJ ou e-mail. Toque no documento para ver a ficha e, se quiser, abrir a mesma pessoa no MOOPE Frotas. Também dá para pedir *investidor* seguido do nome ou do documento. Desmobilizado e vendido não entram. Essa consulta é só do *gerente geral*.",
      examples: ["investidores da locadora", "investidor Alan Franco", "investidor 52998224725"],
      tone: "blue",
    },
    {
      icon: "fa-id-card",
      title: "Locatários",
      body: "Diga *locatários da locadora* para ver quem tem contrato ativo. Os indicadores separam o dinheiro: *em atraso* (só vencido e ainda ativo), *na semana* e *no mês* (o que ainda vai vencer, sem misturar atraso) e *pago no mês*. Boleto cancelado não entra. No card, o nome abre a ficha. Do lado vai o chip *Contrato ativo*. Abaixo, a placa do carro — toque nela e abre a ficha do veículo neste mesmo painel, com status e última localização. CPF em letra menor, telefone logo abaixo (toque e o WhatsApp do cliente abre neste celular), a próxima parcela e o chip de em dia ou em atraso. O botão *Abrir ficha* traz o restante: contratos, quanto deve, semana, mês e pago. Para achar uma pessoa: *locatário* seguido do nome, do documento ou do telefone.",
      examples: ["locatários da locadora", "locatário Maria Souza", "locatário 12345678901"],
      tone: "green",
    },
    {
      icon: "fa-people-group",
      title: "Reuniões e grupos pessoais",
      body: "Reuniões com Meet e grupos de convidados pertencem à *agenda pessoal* do Assessor; não alteram frota, contratos ou dados da locadora. Diga `criar grupo CRM`; `meus grupos` mostra a lista e `quem está no grupo Trabalho` mostra as pessoas. Para avisar na hora: `reunião às 15h para o grupo Trabalho`. Com horário de lembrete: `me lembra amanhã às 10 reunião para o grupo Trabalho`. Para incluir alguém, diga `adicionar Tatiana ao grupo CRM`. Se não estiver salva, eu peço o cartão 📎 ou o telefone e vinculo ao grupo certo, sem enviar mensagem. Para marcar reunião, informe assunto, data e horário. Se faltar algo, eu pergunto. Antes de convidar, mostro nomes e telefones para você escolher e confirmar.",
      examples: [
        "criar grupo Trabalho",
        "meus grupos",
        "quem está no grupo Trabalho",
        "reunião às 15h para o grupo Trabalho",
        "adicionar Tatiana ao grupo Trabalho",
        "grupo 1",
        "crie reunião amanhã às 17h com Meet e avise o grupo Trabalho",
      ],
      tone: "cyan",
    },
  ],
  tips: [
    "Privacidade: não vendemos seus dados — [Política LGPD](https://assessor.moope.com.br/legal/privacidade).",
    "O Assessor *pessoal* continua no mesmo WhatsApp — a integração só *adiciona* dados da locadora.",
    "Nunca misturamos empresas: só a locadora que liberou o seu número responde.",
    "Rastreamento e alertas são do ecossistema Moope.",
    `Painel do Assessor na locadora: ${MD_FROTAS_ASSESSOR}.`,
    "Rendimentos: diga “rendimentos da locadora”. O link do celular abre o gráfico e os arquivos (PDF, PDF contábil e Excel).",
    "Pessoas da locadora: “investidores da locadora” e “locatários da locadora”. Frota em cards: “veículos da locadora”.",
    "Em dúvida: “tenho integração?” ou “resumo da locadora”.",
  ],
  footerNote: `MOOPE Assessor · Manual locadora · ${MD_MOOPE} · ${MD_AJUDA_LOCADORA}`,
};

export const MANUAL_FACEJUS: ManualDoc = {
  slug: "facejus",
  title: "Manual do Assessor Facejus · Advogados",
  eyebrow: "MOOPE Assessor ↔ Facejus",
  lead:
    "Com a integração ativa, o WhatsApp consulta processos, andamentos, agenda de atendimento e agenda de prazos processuais. O acesso segue o telefone e o papel: sócio ou advogado.",
  audience: `Para sócios e advogados cujo escritório liberou o número em Administração → Assessor MOOPE no Facejus (${MD_FACEJUS}).`,
  whatsNew: {
    title: "Duas agendas no Zap",
    lead: "Atendimento e prazos processuais são pedidos diferentes. Cada um abre painel no celular e PDF.",
    items: [
      "🤝 *Agenda de atendimento* — consultas e reuniões com cliente, por filial. A OAB do advogado é opcional.",
      "⚖️ *Agenda de prazos processuais* — prazo, audiência e tarefa do processo.",
      "📄 *PDF* — “PDF agenda de atendimento” ou “PDF agenda de prazos”.",
    ],
  },
  blocks: [
    {
      icon: "fa-link",
      title: "Como liberar o acesso",
      body: `No Facejus (${MD_FACEJUS}), o *admin do escritório* liga o Assessor MOOPE e cadastra cada WhatsApp. *Sócio* vê o escritório inteiro; *advogado* vê só o que está ligado a ele. Depois pergunte no Zap se a integração está ok.`,
      examples: [
        "tenho integração facejus?",
        "meu escritório está ligado?",
      ],
      tone: "blue",
    },
    {
      icon: "fa-user-shield",
      title: "Papéis",
      body: "*Sócio* — processos, andamentos, atendimento e prazos de todo o escritório. *Advogado* — só o que está ligado a ele. O mesmo Assessor, escopos diferentes.",
      examples: [
        "Sócio — visão completa do escritório",
        "Advogado — só o que é dele",
      ],
      tone: "yellow",
    },
    {
      icon: "fa-gavel",
      title: "Processos",
      body: "Liste processos do seu escopo, busque por número CNJ, por nome do cliente/parte (completo ou parcial), por CPF/CNPJ, por área ou por filial — tudo perguntando no Zap.",
      examples: [
        "meus processos",
        "processo 0001234-56.2024.8.24.0001",
        "processos do cliente MARILENE",
        "processos do CPF 000.000.000-00",
        "processos da área previdenciário",
        "processos da filial Içara",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-chart-column",
      title: "KPIs do escritório",
      body: "Totais ativos/arquivados e quebras por área, natureza e filial — sempre no escopo do seu papel (sócio vê tudo; advogado só o dele).",
      examples: [
        "KPIs",
        "resumo do escritório",
        "quantos processos ativos",
      ],
      tone: "yellow",
    },
    {
      icon: "fa-timeline",
      title: "Andamentos",
      body: "Informe o *número do processo* e eu mostro os últimos andamentos lançados no Facejus — útil pra atualizar o cliente sem abrir o sistema.",
      examples: [
        "andamento do processo 0001234-56.2024.8.24.0001",
      ],
      tone: "green",
    },
    {
      icon: "fa-handshake",
      title: "Agenda de atendimento",
      body: "Consultas e reuniões com cliente. A lista sai *por filial*. Para um advogado, diga a OAB. O painel agrupa a filial, abre outro dia no calendário e baixa o PDF.",
      examples: [
        "agenda de atendimento",
        "agenda de atendimento da filial Içara",
        "agenda de atendimento da semana",
        "agenda de atendimento OAB 15444",
        "PDF agenda de atendimento",
      ],
      tone: "blue",
    },
    {
      icon: "fa-calendar-days",
      title: "Agenda de prazos processuais",
      body: "Prazo, audiência e tarefa do processo. É outra lista, separada do atendimento. O painel mostra a filial, o processo e baixa o PDF. *Agenda jurídica* continua abrindo estes prazos. *Agenda OAB* traz os compromissos daquela inscrição.",
      examples: [
        "agenda de prazos processuais",
        "agenda de prazos da semana",
        "agenda de prazos da filial Içara",
        "agenda jurídica de hoje",
        "agenda OAB 15444",
        "PDF agenda de prazos",
      ],
      tone: "green",
    },
    {
      icon: "fa-people-group",
      title: "Reuniões pessoais e grupos",
      body: "Reuniões com Meet e convidados ficam na *agenda pessoal*, separadas da agenda jurídica e dos processos. Diga `criar grupo Trabalho`; `meus grupos` mostra a lista e `quem está no grupo Trabalho` mostra nomes e telefones. Para avisar na hora: `audiência mudou para o grupo Trabalho`. Com horário: `me lembra amanhã às 10 reunião para o grupo Trabalho`. Para incluir alguém, diga `adicionar Tatiana ao grupo Trabalho`; se ela não estiver salva, envie o cartão 📎 ou digite o número. Para marcar, diga assunto, data e horário. Se faltar algum dado, eu pergunto. Antes de convidar, mostro nomes e telefones para você escolher e confirmar. Isso não cria nem altera compromissos jurídicos no Facejus.",
      examples: [
        "criar grupo Trabalho",
        "meus grupos",
        "quem está no grupo Trabalho",
        "audiência mudou para o grupo Trabalho",
        "adicionar Tatiana ao grupo Trabalho",
        "grupo 1",
        "crie uma reunião pessoal amanhã às 17h com Meet",
      ],
      tone: "cyan",
    },
    {
      icon: "fa-arrows-rotate",
      title: "Pessoal e troca de contexto",
      body: "Gastos, lembretes e agenda *pessoal* continuam no mesmo Zap. Se o número tiver locadora *e* Facejus, diga *onde estou?* ou *trocar empresa* pra eu saber qual mundo usar.",
      examples: [
        "onde estou?",
        "trocar empresa",
        "agora o escritório",
        "agora a locadora",
      ],
      tone: "orange",
    },
  ],
  tips: [
    "Privacidade: não vendemos seus dados — [Política LGPD](https://assessor.moope.com.br/legal/privacidade).",
    "O Assessor *pessoal* nunca muda — a integração só *adiciona* dados do escritório.",
    "Lembrete, compromisso e agenda = *pessoal*. No Facejus: *agenda de atendimento* ou *agenda de prazos processuais* (também vale “agenda jurídica”, OAB ou processos).",
    "Nunca misturamos escritórios: só o que liberou o seu número responde.",
    `Painel Facejus: ${MD_FACEJUS}.`,
    "Em dúvida: “tenho integração facejus?”, “agenda de atendimento” ou “agenda de prazos processuais”.",
  ],
  footerNote: `MOOPE Assessor · Manual Facejus · ${MD_MOOPE} · ${MD_AJUDA_FACEJUS}`,
};

export const MANUAL_CRM: ManualDoc = {
  slug: "crm",
  title: "Manual do CRM no Assessor",
  eyebrow: "MOOPE Assessor ↔ CRM",
  lead:
    "O dono da conta cadastra um WhatsApp. Cliente novo e lead que responde chegam nesse número, como avisos separados. Perguntar leads abre um painel no celular, do mesmo jeito que a locadora.",
  audience:
    "Para quem já falou com o MOOPE Assessor e teve o número liberado em Meu Assessor, no CRM.",
  blocks: [
    {
      icon: "fa-bell",
      title: "Alerta de lead",
      body: "A primeira mensagem de um cliente novo. Ligar e desligar não mexe no alerta de resposta, e não tira você do Assessor.",
      examples: ["ligar alerta lead", "desligar alerta lead"],
      tone: "green",
    },
    {
      icon: "fa-reply",
      title: "Alerta de resposta",
      body: "Quando o lead escreve de novo, depois de uma mensagem da equipe. Um aviso por resposta, não um aviso para cada “ok” seguido.",
      examples: ["ligar alerta resposta", "desligar alerta resposta"],
      tone: "orange",
    },
    {
      icon: "fa-list",
      title: "Leads e o painel",
      body: "A resposta no Zap é curta. O link abre a lista no celular e vale 24 horas. Outra pessoa não abre.",
      examples: ["leads do dia", "leads de hoje", "leads da semana", "leads abertos", "quem respondeu hoje"],
      tone: "blue",
    },
    {
      icon: "fa-mobile-screen",
      title: "Onde cadastrar o número",
      body: `No CRM, em Meu Assessor (${LINK_CRM}). O mesmo número precisa já ter mandado um oi para o Assessor, senão o aviso não tem conversa para entrar.`,
      examples: ["ajuda crm"],
      tone: "cyan",
    },
  ],
  tips: [
    "Alerta de lead e alerta de resposta são dois interruptores.",
    "Desligar um aviso não apaga o Assessor pessoal, a locadora nem o Facejus.",
    "“leads do dia” é quem entrou hoje. “quem respondeu hoje” é quem escreveu hoje.",
    `Manual: ${MD_AJUDA_CRM}.`,
  ],
  footerNote: `MOOPE Assessor · Manual CRM · ${MD_MOOPE} · ${MD_AJUDA_CRM}`,
};

export function manualBySlug(slug: string): ManualDoc | null {
  if (slug === "pessoal") return MANUAL_PESSOAL;
  if (slug === "locadora") return MANUAL_LOCADORA;
  if (slug === "facejus") return MANUAL_FACEJUS;
  if (slug === "crm") return MANUAL_CRM;
  return null;
}
