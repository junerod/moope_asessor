import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { platformKnowledge } from "@/db/schema";
import {
  embeddingToSqlLiteral,
  getEmbeddingProvider,
} from "@/lib/ai/providers";

export const MOOPE_SITE = "https://moope.com.br";

export const MOOPE_SEED: Array<{
  slug: string;
  title: string;
  category: string;
  content: string;
  sourceUrl?: string;
}> = [
  {
    slug: "moope-sobre",
    title: "O que é a MOOPE",
    category: "empresa",
    content:
      "A MOOPE é uma empresa brasileira de tecnologia para locadoras de veículos e gestão de frotas. Oferece rastreamento veicular, plataforma de gestão (contratos, locação, financeiro, multas, vistorias, sinistros, checklists, investidores) e o Assessor MOOPE no WhatsApp. Site oficial: https://moope.com.br — para preços e planos atualizados, sempre consultar https://moope.com.br",
    sourceUrl: MOOPE_SITE,
  },
  {
    slug: "moope-rastreamento",
    title: "Rastreamento veicular MOOPE",
    category: "produto",
    content:
      "MOOPE Rastreamento: localização e segurança da frota, controle de motoristas, consumo e manutenções. Os planos de rastreamento incluem acesso às plataformas de gestão (financeiro, locação, manutenções) sem mensalidade extra de módulo. Detalhes e valores: https://moope.com.br",
    sourceUrl: MOOPE_SITE,
  },
  {
    slug: "moope-gestao-frota",
    title: "Gestão de frotas e locação",
    category: "produto",
    content:
      "Plataforma de gestão MOOPE para locadoras: contratos e locações, frota, financeiro integrado, multas, vistorias, sinistros, checklists personalizáveis, relatórios/dashboards e controle de investidores. Ideal para locadoras que precisam centralizar a operação. Saiba mais em https://moope.com.br",
    sourceUrl: MOOPE_SITE,
  },
  {
    slug: "moope-finance",
    title: "MOOPE Gestão de Frotas e Locação",
    category: "produto",
    content:
      "MOOPE Gestão de Frotas e Locação (frotas.moope.com.br) é o sistema das locadoras: frota, contratos/locações, receitas, despesas, fluxo de caixa, inadimplência, multas, vistorias e visão gerencial. Nome interno técnico às vezes aparece como “Finance”, mas para o cliente use sempre MOOPE Gestão de Frotas e Locação. Site: https://moope.com.br · Painel: https://frotas.moope.com.br",
    sourceUrl: "https://frotas.moope.com.br",
  },
  {
    slug: "moope-assessor",
    title: "Assessor MOOPE (WhatsApp)",
    category: "produto",
    content:
      "O Assessor MOOPE é o assistente de IA no WhatsApp: agenda, lembretes, gastos/receitas, documentos, pesquisas e dia a dia do gestor ou da pessoa. Não substitui o sistema financeiro completo; complementa com conversa. Site: https://moope.com.br",
    sourceUrl: MOOPE_SITE,
  },
  {
    slug: "moope-precos",
    title: "Preços e planos MOOPE",
    category: "comercial",
    content:
      "Os preços e planos da MOOPE (rastreamento, gestão de frotas e locação) mudam conforme pacote e volume de veículos. O Assessor não inventa tabela de preço: oriente o usuário a ver https://moope.com.br ou falar com o comercial MOOPE. Sempre link: https://moope.com.br",
    sourceUrl: MOOPE_SITE,
  },
  {
    slug: "moope-contato",
    title: "Contato e site oficial",
    category: "comercial",
    content:
      "Canal oficial de produtos, planos e contato da MOOPE: https://moope.com.br. Quando alguém perguntar sobre a empresa, produtos, valores, rastreamento, gestão de frotas ou locação, responda com o essencial e SEMPRE indique https://moope.com.br",
    sourceUrl: MOOPE_SITE,
  },
  {
    slug: "moope-locadora-beneficios",
    title: "Benefícios para locadoras",
    category: "produto",
    content:
      "Para locadoras, a MOOPE entrega: rastreio da frota, contratos/locações, financeiro (receitas, despesas, rendimento), multas e vistorias, sinistros, checklists e visão para investidores — tudo no ecossistema. O Assessor no WhatsApp ajuda no dia a dia do gestor. Detalhes: https://moope.com.br",
    sourceUrl: MOOPE_SITE,
  },
  {
    slug: "moope-assessor-locadora-integracao",
    title: "Integração Assessor × Locadora (MOOPE Gestão)",
    category: "integracao",
    content:
      "Integração Assessor ↔ MOOPE Gestão de Frotas e Locação (frotas.moope.com.br): o dono liga Configurações → Assessor MOOPE e cadastra WhatsApps. Perguntas: o que o assessor pode fazer pela locadora? (capacidades); tenho integração?; resumo; alertas por placa (24/48/72h, duplo offline/misto, TAGs); frota; contratos/CNH/preventivas; quem está com a placa; vistorias + link relatório; manutenções/OS; lançamentos da placa; faturas Asaas abertas da placa com link (sem pagas/canceladas); extrato do contrato da placa; onde está o carro (mapa; bateria do veículo em V; % só TAG). Relatórios PDF: “me manda o relatório da locadora / alertas / faturas da placa”. Briefing: “bom dia” / “me atualiza”. Tools: check_locadora_integration, query_locadora, locadora_snapshot, generate_report_pdf, daily_briefing. Painel: https://frotas.moope.com.br/empresaassessormoope — site: https://moope.com.br. Nunca diga “MOOPE Finance” ao cliente.",
    sourceUrl: "https://frotas.moope.com.br/empresaassessormoope",
  },
  {
    slug: "moope-assessor-iot-carrinhos",
    title: "Integração Assessor × IoT Carrinhos (supermercado)",
    category: "integracao",
    content:
      "Assessor ↔ IoT/Carrinhos no MOOPE Gestão (mercado/supermercado): mesma liberação em Configurações → Assessor MOOPE, papéis gerente_iot ou localizador. Perguntas: quantos carrinhos / por unidade; quantos fora / próximos / na base / sem sinal; carrinhos fora da loja X (+ distância + mapa); onde está a tag LJ…/TAG-… (FINDTAG, TAGBRGPS, BRGPS, BRTAG, AIRTAG); alertas de saída/geocerca; manda Excel das tags fora/todas/na base; rota de recolha; tipos (carrinho, pessoa, empilhadeira, container). Tool: query_locadora (Finance roteia IoT). Painel: https://frotas.moope.com.br — site: https://moope.com.br.",
    sourceUrl: "https://frotas.moope.com.br",
  },
  {
    slug: "moope-assessor-facejus-integracao",
    title: "Integração Assessor × Facejus (escritório)",
    category: "integracao",
    content:
      "Integração Assessor ↔ Facejus: o admin do escritório liga Administração → Assessor MOOPE e libera WhatsApps de sócios e advogados (ou um número manual). Telefone no Facejus é DDD+número, com ou sem 0 na frente (ex.: 61999990000 ou 061999990000), sem +55. Sócio vê processos/andamentos/agendas do escritório; advogado só o dele. Lembrete, compromisso e agenda = pessoal (não abrem Facejus). Facejus só com: agenda de atendimento (por filial, OAB opcional, com painel e PDF); agenda de prazos processuais (painel e PDF); agenda jurídica; prazos judiciais; agenda OAB; meus processos; KPIs. As duas agendas não se misturam e não gravam compromisso pessoal. Whitelist/assinatura/7 dias de teste. Tools: check_escritorio_integration, query_escritorio.",
    sourceUrl: "https://web.facejus.com.br",
  },
];

export async function upsertMoopeKnowledgeSeed(db: Db) {
  const embedder = getEmbeddingProvider();
  for (const item of MOOPE_SEED) {
    const [embedding] = await embedder.embed([`${item.title}\n${item.content}`]);
    const existing = await db.query.platformKnowledge.findFirst({
      where: eq(platformKnowledge.slug, item.slug),
    });
    if (existing) {
      await db
        .update(platformKnowledge)
        .set({
          title: item.title,
          category: item.category,
          content: item.content,
          sourceUrl: item.sourceUrl || MOOPE_SITE,
          embedding,
          embeddingModel:
            embedder.name === "openai" ? "text-embedding-3-small" : "local",
          status: "active",
          updatedAt: new Date(),
        })
        .where(eq(platformKnowledge.id, existing.id));
    } else {
      await db.insert(platformKnowledge).values({
        slug: item.slug,
        title: item.title,
        category: item.category,
        content: item.content,
        sourceUrl: item.sourceUrl || MOOPE_SITE,
        embedding,
        embeddingModel:
          embedder.name === "openai" ? "text-embedding-3-small" : "local",
        status: "active",
      });
    }
  }
  return { count: MOOPE_SEED.length };
}

export async function searchMoopeKnowledge(
  db: Db,
  query: string,
  limit = 4
): Promise<Array<{ title: string; content: string; sourceUrl: string | null; score: number }>> {
  const embedder = getEmbeddingProvider();
  const [embedding] = await embedder.embed([query]);
  const literal = embeddingToSqlLiteral(embedding);
  const rows = await db.execute(sql`
    SELECT title, content, source_url,
      1 - (embedding <=> ${sql.raw(`'${literal}'::vector`)}) AS score
    FROM platform_knowledge
    WHERE status = 'active'
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${sql.raw(`'${literal}'::vector`)}
    LIMIT ${limit}
  `);
  const list = (Array.isArray(rows) ? rows : []) as Array<{
    title: string;
    content: string;
    source_url: string | null;
    score: number;
  }>;
  return list.map((r) => ({
    title: r.title,
    content: r.content,
    sourceUrl: r.source_url,
    score: Number(r.score) || 0,
  }));
}
