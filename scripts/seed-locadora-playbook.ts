#!/usr/bin/env tsx
/**
 * Grava playbook de integração locadora na base de conhecimento + memória do workspace do dev.
 */
import { eq } from "drizzle-orm";
import { getDb, closeDb } from "@/db/client";
import { memories, platformKnowledge } from "@/db/schema";
import { getEmbeddingProvider } from "@/lib/ai/providers";

const WS = "4729d8be-1a8e-4e46-9f1b-ebfd3f7d9a2a";
const USER = "bbf4f87e-8d70-472c-a48b-8dcd8bfd567e";
const CONV = "bba78bb1-bb8a-4e96-addc-b768418d2dae";

const PLAYBOOK = `Integração Assessor ↔ MOOPE Finance (locadoras)

Como funciona:
1) No Finance (frotas.moope.com.br): Configurações → Assessor MOOPE → ligar integração e cadastrar WhatsApps autorizados (papel gerente/financeiro/operação/atendimento).
2) No WhatsApp do Assessor, o número da conversa é conferido. Se bater e estiver ativo, libera dados da locadora daquele tenant.
3) Nunca misturar dados entre locadoras.

Perguntas úteis do usuário:
- o que o assessor pode fazer pela locadora? / capacidades
- tenho integração moope locadora?
- minha locadora: resumo
- alertas da locadora / alertas de rastreamento (por placa: fora 24/48/72h, duplo offline/misto)
- minha locadora: quantos carros disponíveis?
- contratos a vencer / CNH a vencer / preventivas da semana
- quem está com o carro ABC1D23
- vistorias abertas / vistoria da placa ABC1D23
- manutenções do mês da placa ABC1D23
- lançamentos do mês da placa ABC1D23
- faturas da placa ABC1D23 (só abertas + link Asaas; sem pagas/canceladas)
- extrato do contrato da placa ABC1D23
- onde está o carro ABC1D23 (mapa; bateria do veículo em V se houver; % só TAG)

Tools: check_locadora_integration, query_locadora, locadora_snapshot.
Site institucional: https://moope.com.br
Painel Finance: https://frotas.moope.com.br/empresaassessormoope`;

async function main() {
  const db = getDb();
  const embedder = getEmbeddingProvider();
  const [embedding] = await embedder.embed([PLAYBOOK]);

  const slug = "moope-assessor-locadora-integracao";
  const existing = await db.query.platformKnowledge.findFirst({
    where: eq(platformKnowledge.slug, slug),
  });
  if (existing) {
    await db
      .update(platformKnowledge)
      .set({
        title: "Integração Assessor × Locadora (MOOPE Finance)",
        category: "integracao",
        content: PLAYBOOK,
        sourceUrl: "https://frotas.moope.com.br/empresaassessormoope",
        embedding,
        embeddingModel:
          embedder.name === "openai" ? "text-embedding-3-small" : "local",
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(platformKnowledge.id, existing.id));
  } else {
    await db.insert(platformKnowledge).values({
      slug,
      title: "Integração Assessor × Locadora (MOOPE Finance)",
      category: "integracao",
      content: PLAYBOOK,
      sourceUrl: "https://frotas.moope.com.br/empresaassessormoope",
      embedding,
      embeddingModel:
        embedder.name === "openai" ? "text-embedding-3-small" : "local",
      status: "active",
    });
  }

  // Soft-archive old playbook memories of this kind
  const prior = await db.query.memories.findMany({
    where: eq(memories.workspaceId, WS),
    limit: 50,
  });
  for (const m of prior) {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    if (meta.kind === "locadora_playbook") {
      await db
        .update(memories)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(memories.id, m.id));
    }
  }

  await db.insert(memories).values({
    workspaceId: WS,
    createdByUserId: USER,
    conversationId: CONV,
    type: "preference",
    content: PLAYBOOK,
    sourceType: "system",
    embedding,
    embeddingModel: embedder.name === "openai" ? "text-embedding-3-small" : "local",
    status: "active",
    metadata: {
      kind: "locadora_playbook",
      tenant_finance_id: 9,
      phone_e164: "+556196715985",
      empresa: "SOLUTT LOCAÇÃO DE AUTOMOVEIS LTDA",
    },
  });

  console.log(JSON.stringify({ ok: true, workspace: WS, slug }));
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
