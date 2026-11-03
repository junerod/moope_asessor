# Fase 1 — Fundação — Resultado

Data: 2026-09-19  
Produto: **MOOPE Meu Assessor** (repositório independente `moope-assessor`)  
Status: fundação implementada e testada localmente. **Não** é “production ready”.

---

## Arquitetura criada

```text
moope-assessor
├── apps lógicos (mesmo repo, processos separados)
│   ├── Next.js web/api          npm run dev
│   ├── worker                   npm run worker
│   └── scheduler                npm run scheduler
├── PostgreSQL + pgvector        docker compose (porta 54329)
└── Zernio adapter               mock por padrão; HTTP real se credenciais
```

Fluxo inbound validado:

```text
Zernio webhook
  → verifica HMAC (X-Zernio-Signature)
  → persiste webhook_events (idempotente)
  → resolve whatsapp_identities (phone_e164 / bsuid)
  → cria/atualiza conversation + message
  → enqueue agent_jobs (idempotency_key)
  → worker claim FOR UPDATE SKIP LOCKED
  → resposta "Recebi sua mensagem." (ou onboarding)
  → adapter Zernio (mock nesta validação)
```

Isolamento: dados de domínio carregam `workspace_id`; buscas de memories/documents/tasks/reminders filtram no SQL por workspace.

Auth local: JWT HS256 + bcrypt. `users.global_user_id` existe e permanece `null` (preparado para MOOPE ID).

CRM: **não** há runtime dependency. O caminho `lib/channels/zernio` do CRM **não** foi encontrado localmente; o módulo Zernio foi implementado a partir da API pública Zernio (HMAC body, inbox send) e do client HTTP já usado no ecossistema finance.

---

## Arquivos principais

| Área | Caminho |
|------|---------|
| Schema Drizzle | `src/db/schema/index.ts` |
| Migration SQL | `src/db/migrations/0001_foundation.sql` |
| Migrate script | `scripts/migrate.ts` |
| Env | `.env.example` |
| Docker PG | `docker-compose.yml` |
| Webhook | `src/app/api/webhooks/zernio/route.ts` |
| Inbound service | `src/services/inbound-webhook.ts` |
| Zernio | `src/channels/zernio/*` |
| Auth | `src/lib/auth/index.ts` + `src/app/api/auth/*` |
| Workspaces | `src/domain/workspaces.ts` |
| Identities | `src/domain/whatsapp-identities.ts` |
| Queue | `src/domain/jobs.ts` |
| Worker | `src/worker/index.ts`, `src/worker/process-job.ts` |
| Scheduler | `src/scheduler/index.ts` |
| Policy | `src/agent/policy/engine.ts` |
| Isolation helpers | `src/domain/isolation.ts` |
| Logger | `src/lib/logger.ts` |
| Testes | `tests/fase1-foundation.test.ts` |

---

## Migrations

Aplicada: `0001_foundation.sql` via `npm run db:migrate`.

Extensões: `vector`, `pgcrypto`.

Tabela de controle: `schema_migrations`.

---

## Tabelas criadas (verificadas no Postgres)

- `users`
- `workspaces`
- `workspace_members`
- `whatsapp_identities`
- `conversations`
- `messages`
- `documents`
- `document_chunks` (`embedding vector(1536)`)
- `memories` (`embedding vector(1536)`)
- `tasks`
- `appointments`
- `reminders`
- `agent_jobs`
- `agent_runs`
- `tool_calls`
- `webhook_events`
- `integration_connections`
- `audit_logs`
- `schema_migrations`

---

## Endpoints

| Método | Path | Função |
|--------|------|--------|
| GET | `/api/health` | health check |
| POST | `/api/auth/register` | cria user + workspace pessoal owner |
| POST | `/api/auth/login` | JWT |
| GET | `/api/auth/me` | user + workspace pessoal |
| POST | `/api/webhooks/zernio` | webhook autenticado |

---

## Fluxo executado (teste real)

1. Registro cria user + workspace `personal` com role `owner`.
2. Pareamento WhatsApp identity → user.
3. Webhook assinado `message.received` persiste evento/mensagem e enfileira job.
4. Worker claim + process envia via mock adapter: `"Recebi sua mensagem."`
5. Mensagem outbound marcada `sent` com `external_message_id` mock.
6. Usuário desconhecido recebe job `onboarding_message` (ainda unpaired).
7. Scheduler existe e enfileira `deliver_reminder` para lembretes vencidos (código presente; não coberto por teste E2E nesta fase além da estrutura).

---

## Testes executados

Comando: `npm test` (Vitest + Postgres real em Docker).

Resultado: **14 passed / 0 failed**.

Cobertura pedida na Fase 1:

1. assinatura inválida de webhook — OK  
2. webhook duplicado — OK (`onConflictDoNothing`)  
3. identidade por telefone — OK  
4. identidade por BSUID — OK  
5. usuário desconhecido — OK  
6. usuário pareado — OK  
7. criação de workspace pessoal — OK  
8. isolamento memories/docs/tasks/reminders — OK  
9. enqueue idempotente — OK  
10. retry de job — OK  
11. falha de envio Zernio — OK (mock force fail → status `retry`)  
12. mensagem não vaza para outro workspace — OK  

Extra: fluxo completo webhook → job → worker → adapter mock — OK.

Typecheck: `npx tsc --noEmit` — OK.

---

## O que foi realmente validado

- Schema + migration no Postgres com pgvector.
- Auth local + workspace pessoal automático.
- HMAC Zernio (`HMAC-SHA256` do raw body).
- Idempotência de webhook e de job.
- Resolução phone/BSUID e unicidade de identity.
- Fila com `FOR UPDATE SKIP LOCKED`, attempts/retry.
- Isolamento por `workspace_id` em memories, chunks, tasks, reminders e messages.
- Caminho de resposta até o adapter (mock).

---

## O que depende de credencial / infra externa

| Item | Estado |
|------|--------|
| Envio real WhatsApp via Zernio | **Não validado**. Requer `ZERNIO_API_KEY`, `ZERNIO_ACCOUNT_ID`, `ZERNIO_WEBHOOK_SECRET` reais e `ZERNIO_MOCK=false`. |
| Webhook público recebido da Zernio | **Não validado** (somente fixture local assinada). |
| Storage de arquivos (S3/Supabase Storage) | Schema preparado; upload/pipeline **não** implementado. |
| Embeddings / RAG vetorial | Colunas `vector(1536)` existem; geração/busca por similaridade **não** implementada (busca lexical com filtro `workspace_id`). |
| Onboarding conversacional completo (e-mail + código + termos) | Fundação + verificação de código em domain; fluxo conversacional multi-step **não** automatizado no worker. |
| Tools do agente / LLM | Policy engine + nomes das tools; runtime LLM **não** implementado (echo controlado). |
| Integrações (CRM, Frotas, Open Finance, Google…) | Tabela `integration_connections` apenas. |

---

## Problemas encontrados

1. Detecção de duplicate via catch de unique violation falhou (mensagem Drizzle “Failed query…” sem código PG claro). Corrigido com `ON CONFLICT DO NOTHING`.
2. Operadores `??` / `||` misturados no client Zernio quebraram o bundler do Vitest — corrigido com parênteses.
3. Repositório CRM com `lib/channels/zernio` **não disponível** localmente para reutilizar parser/HMAC originais.

---

## Dívida técnica criada (consciente)

- Worker de Fase 1 responde com echo fixo; Agent Runtime completo ainda não existe.
- Busca de memória/documento é lexical, não vetorial.
- Onboarding WhatsApp multi-step incompleto (só mensagem inicial + helpers de verificação).
- Storage privado / anti-SSRF de mídia: helper SSRF existe (`media.ts`); download/pipeline não ligado ao inbound.
- Scheduler de lembretes enfileira jobs `deliver_reminder`, mas o worker ainda não entrega lembrete (só processa inbound/onboarding).
- Sem rate limiting HTTP ainda.
- Auth sem refresh tokens / sem verificação de e-mail real.
- Sem testes de carga / concorrência de claim além do caminho unitário.

---

## Próximo passo recomendado

**Fase 2 — Onboarding conversacional + memória mínima:**

1. Completar onboarding WhatsApp (nome → e-mail → código → aceite → pair).
2. Implementar tools `save_memory` / `search_memory` no worker com contexto injetado pelo servidor.
3. Ligar delivery de `deliver_reminder` (template WhatsApp quando fora da janela).
4. Validar um envio real Zernio com credenciais do número oficial do Assessor.
