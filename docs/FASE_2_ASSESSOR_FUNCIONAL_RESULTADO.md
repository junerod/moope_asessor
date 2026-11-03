# Fase 2 — Assessor Funcional — Resultado

Data: 2026-09-19  
Produto: **MOOPE Meu Assessor**  
Status: Fase 2 implementada e testada em Postgres real. **Não** é production-ready. Envio Zernio real **não** validado.

---

## O que foi implementado

- Onboarding WhatsApp com máquina de estados persistida (`awaiting_name` → `email` → `verification` → `terms` → `completed`)
- Verificação por e-mail + código (provider `EmailProvider` mock; código hashed, expiração, tentativas, uso único)
- Aceite versionado (`terms_version`, `privacy_version`, `consent_acceptances`)
- User + workspace pessoal sem duplicar workspace existente
- Agent Runtime único: context builder + LLM provider + tools + policy + resposta natural
- Tool registry com tools reais: memória, tasks, reminders, appointments, documents
- Policy default-deny; auditoria em `tool_calls`
- Memória com embedding + busca vetorial filtrada por `workspace_id` no SQL
- Lembretes: criação, scheduler com claim atômico, entrega idempotente, `sendProactiveMessage` (free-form vs template)
- Appointments com timezone
- Pipeline de documentos (storage privado local → extract → chunk → embed → index) via job
- Múltiplas tools no mesmo turno
- Interfaces de connectors futuros (Open Finance / CRM / Frotas stubs)
- Harness E2E `src/testing/conversation-harness.ts`
- Smoke Zernio real explícito: `npm run test:zernio:smoke` (fora de `npm test`)

---

## Migrations novas

- `src/db/migrations/0002_fase2_funcional.sql`
  - `users.terms_*`
  - `memories.type`
  - `agent_runs` métricas (provider/tokens/latency/tool_count)
  - `tool_calls` started/completed/error_code
  - `consent_acceptances`
  - `appointments.user_id`
  - índices HNSW (best-effort)

---

## Arquivos principais

| Área | Path |
|------|------|
| Onboarding | `src/domain/onboarding.ts` |
| Agent runtime | `src/agent/runtime.ts` |
| Context | `src/agent/context-builder.ts` |
| Tools | `src/agent/tools/*` |
| Policy | `src/agent/policy/engine.ts` |
| AI providers | `src/lib/ai/providers/*` |
| Email | `src/lib/email/provider.ts` |
| Documents | `src/domain/documents.ts` |
| Storage | `src/lib/storage/private.ts` |
| Datetime | `src/lib/datetime.ts` |
| Proactive WA | `src/channels/zernio/proactive.ts` |
| Scheduler | `src/scheduler/queue-reminders.ts` |
| Worker | `src/worker/process-job.ts` |
| Connectors | `src/integrations/connector.ts` |
| Harness | `src/testing/conversation-harness.ts` |
| Testes | `tests/fase2-funcional.test.ts` |

---

## Providers

| Provider | Default | Notas |
|----------|---------|-------|
| `AI_PROVIDER` | `heuristic` | OpenAI function-calling se `OPENAI_API_KEY` + `AI_PROVIDER=openai` |
| `EMBEDDING_PROVIDER` | `local` | OpenAI `text-embedding-3-small` se chave; local 1536-dim para testes |
| `EMAIL_PROVIDER` | `mock` | SMTP não implementado |
| `TranscriptionProvider` / `VisionProvider` | stub | Interfaces prontas; não fingir OCR/STT |
| Zernio | `ZERNIO_MOCK=true` | Mock padrão; real só via smoke explícito |

---

## Tools

ALLOW: `save_memory`, `search_memory`, `create_task`, `list_tasks`, `complete_task`, `create_reminder`, `list_reminders`, `cancel_reminder`, `create_appointment`, `list_appointments`, `search_documents`, `summarize_document`  

Sem policy → DENY.

---

## Testes

Comando: `npm test`

Resultado: **20 passed / 0 failed**

- Fase 1: 14 testes (preservados)
- Fase 2: 6 suítes cobrindo onboarding, memória/tools/isolamento, lembrete/agenda, documentos, segurança, E2E harness

`npx tsc --noEmit`: OK (após implementação)

### Exemplos E2E executados (harness)

```text
A: "Guarda que meu contador é Marcos."
A: "Quem é meu contador?" → contém Marcos
B: "Quem é meu contador?" → não vaza Marcos
A: "Me lembra amanhã às 9h…" → reminder persistido
A: "Agenda reunião terça às 14h." → appointment persistido
A: "O que tenho terça?" → consulta appointment
A: fato + lembrete no mesmo turno → memory + reminder
Documento texto/contrato → indexado → busca "valor" → 1500; B isolado
```

---

## O que usa mock

- Zernio send (`ZERNIO_MOCK=true`)
- Email de verificação
- LLM heuristic (sem OpenAI key)
- Embeddings local
- Transcription/Vision stubs

---

## Validado de verdade

- Onboarding state machine + verification + terms versionados
- Memória persistida + recuperação com filtro workspace no SQL
- Isolamento A/B
- Reminder due → queue idempotente → delivery once
- Appointments + consulta por dia/timezone
- Document ingest/chunk/embed/search/summarize + isolamento
- Policy DENY sem regra
- SSRF block em hosts locais
- Tool ignora `workspace_id` vindo do “LLM”

---

## Depende de credencial externa

- Envio WhatsApp real (Zernio)
- OpenAI LLM/embeddings reais
- SMTP real
- OCR/visão e transcrição reais
- Download de mídia Zernio em produção

---

## Dívida técnica

- Heuristic LLM é para testes/dev; qualidade de NL real exige OpenAI (ou outro) em produção
- Embeddings locais não são semanticamente fortes como `text-embedding-3-small`
- PDF: pipeline aceita PDF via `pdf-parse`; teste E2E usou texto (`text/plain`) para estabilidade
- Entrega de lembrete assume conversation WhatsApp existente
- Quotas/billing só preparados conceitualmente
- Onboarding ainda não cobre reenvio explícito de código por comando dedicado além de reenviar e-mail

---

## Próximo passo recomendado

1. Configurar `OPENAI_API_KEY` + `AI_PROVIDER=openai` / `EMBEDDING_PROVIDER=openai` e validar os mesmos fluxos
2. Smoke Zernio real (`npm run test:zernio:smoke`) com número oficial do Assessor
3. Completar download de anexo WhatsApp no inbound (ligar mídia Zernio → `ingestInboundDocument`)
4. Depois: Open Finance connector com consentimento forte (não antes de memória/docs/agenda estáveis em produção)
