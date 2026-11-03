# Fase 3 — Produto real + administração operacional

Documento factual do que foi entregue nesta fase.

## Objetivo

Colocar o Assessor operável: `/admin` para configurar providers, SecretStore, Zernio/LLM/Email reais (quando credenciados), mídia inbound, lembretes proativos, dead-letter e fundação de planos/uso — sem reescrever Fases 1–2.

## Migrations novas

- `src/db/migrations/0003_fase3_produto_real.sql`

## Tabelas / colunas novas

- `platform_admins`, `encrypted_secrets`, `platform_settings`, `provider_configs`
- `whatsapp_templates`, `process_heartbeats`, `admin_audit_logs`
- `plans`, `subscriptions`, `usage_counters`
- `users.account_status`
- `agent_jobs.dead_at`
- `tool_calls.execution_key`
- provenance/embedding metadata em `documents`, `document_chunks`, `memories`
- `integration_connections.consent_expires_at`, `secret_reference`

## Rotas admin

| Rota | Função |
| --- | --- |
| `/admin` | Dashboard + Zernio/OpenAI/Email |
| `/admin/users` | Lista operacional de usuários |
| `/admin/jobs` | Dead-letter + reprocessar |
| `/admin/templates` | Templates WhatsApp lógicos |
| `/api/admin/dashboard` | Métricas + saúde |
| `/api/admin/providers` | CRUD/test providers |
| `/api/admin/users` | Usuários |
| `/api/admin/jobs` | Jobs + reprocess |
| `/api/admin/templates` | Templates |
| `/api/admin/audit` | Audit log |
| `/api/admin/webhooks` | Últimos webhooks (sem corpo privado) |
| `/api/health` | Liveness |
| `/api/ready` | Readiness |

## Configuração necessária (infra vs operacional)

**Infra (`.env`):** `DATABASE_URL`, `AUTH_JWT_SECRET`, `ENCRYPTION_MASTER_KEY`, `APP_BASE_URL`

**Operacional (`/admin`):** Zernio, OpenAI, Email, templates, número oficial

Bootstrap: primeiro usuário platform admin via `ensurePlatformAdmin` (script/seed) ou insert em `platform_admins`.

## Capacidade × homologação

| Capacidade | Implementada | Mock testado | API real testada | E2E real |
| --- | ---: | ---: | ---: | ---: |
| Zernio inbound | sim | sim | AGUARDANDO CREDENCIAL | AGUARDANDO CREDENCIAL |
| Zernio outbound | sim | sim | AGUARDANDO CREDENCIAL | AGUARDANDO CREDENCIAL |
| OpenAI LLM | sim | heuristic | AGUARDANDO CREDENCIAL | AGUARDANDO CREDENCIAL |
| Embeddings | sim | local | AGUARDANDO CREDENCIAL | AGUARDANDO CREDENCIAL |
| Email | sim | mock | AGUARDANDO CREDENCIAL | AGUARDANDO CREDENCIAL |
| PDF | sim | sim | n/a (local) | AGUARDANDO CREDENCIAL (WhatsApp) |
| Vision | sim | stub | AGUARDANDO CREDENCIAL | AGUARDANDO CREDENCIAL |
| Transcription | sim | stub | AGUARDANDO CREDENCIAL | AGUARDANDO CREDENCIAL |
| Reminder | sim | mock send | AGUARDANDO CREDENCIAL | AGUARDANDO CREDENCIAL |
| Admin | sim | sim | n/a | parcial (UI local) |

## Testes

- Preservados: Fase 1 + Fase 2
- Novos: `tests/fase3-produto-real.test.ts`
- Resultado: **29/29 passed** (`npm test`)
- Typecheck: **OK** (`npx tsc --noEmit`)
- Build: **OK** (`NODE_ENV=production npm run build`)
- Smoke (não entram em `npm test`): `npm run smoke:openai|zernio|email|vision|transcription|all`
- Reindex: `npm run embeddings:reindex -- --workspace=<id>|--all`
- Promote admin: `npx tsx scripts/promote-platform-admin.ts <email>`

## Build / typecheck

Executados com sucesso ao final desta fase.

## Dívida técnica

- SMTP real é mínimo (sem AUTH LOGIN completo); preferir API transacional depois
- Template WhatsApp fora da janela ainda envia texto prefixado (não Meta template API completa)
- Export/delete LGPD é fundação, não UI completa
- Planos/subscriptions sem billing
- OCR de PDF vazio depende de Vision configurado

## Credenciais ainda necessárias

```text
AGUARDANDO CREDENCIAL PARA HOMOLOGAÇÃO EXTERNA
```

- Zernio: Account ID, API Key, Webhook Secret, número oficial
- OpenAI: API Key (LLM + embeddings + vision + whisper)
- Email SMTP/API + destinatário de teste admin
- Template WhatsApp `reminder` aprovado no provider → status `active` no admin

## O que falta para o primeiro cliente real

1. Promover um user a `platform_admins`
2. Configurar e testar Zernio/OpenAI/Email em `/admin`
3. Expor `APP_BASE_URL` público no webhook Zernio
4. Subir app + worker + scheduler
5. Seguir `docs/HOMOLOGACAO_WHATSAPP.md` no celular
6. Corrigir só o que falhar na homologação
