# Ajuste final Fase 3 — WhatsApp-first, Admin interno, identidade, planos e Zernio multi-número

Documento factual. Fase 4 **não** iniciada.

## Decisões consolidadas

- Cliente = WhatsApp (sem portal/login web do assinante).
- `/admin` = backoffice MOOPE apenas.
- Monólito Next.js mantido (separação lógica, não física).
- Identidade: `whatsapp_identity → user → workspace → subscription → plan`.
- Telefone **não** é PK do user; assinatura fica no **workspace**.
- Zernio: catálogo multi-número; **um** canal `purpose=ASSISTANT` + `is_active`.

## Mudanças técnicas

| Item | Detalhe |
| --- | --- |
| Migration | `0004_whatsapp_channels.sql` |
| Domínio | `src/domain/whatsapp-channels.ts` (sync, setAssistant, inbound gate, trial subscription) |
| Inbound | Gate ASSISTANT; `conversation.whatsapp_channel_id`; bootstrap em test/dev se sem canal |
| Outbound | Worker resolve `account_id` via channel da conversation → payload → runtime config |
| Onboarding | Cria `subscription` trial no workspace pessoal |
| Admin | Clientes (`/admin/users` + detalhe API), Planos (`/admin/plans`), Zernio “Definir como Meu Assessor” |
| Precedência | ASSISTANT channel / DB secrets vencem ENV; production não mocka se DB configurado |

## Testes

- Suite completa: **46** testes passando (fase1 + fase2 + fase3 + ajuste).
- Arquivo novo: `tests/ajuste-whatsapp-first.test.ts` (17 casos).

## Typecheck / Build

- `tsc --noEmit`: OK
- `next build` (NODE_ENV=production): OK

## Blockers para o primeiro “Oi” real

1. API Key Zernio no Admin + sincronizar números
2. Definir canal ASSISTANT (Meu Assessor)
3. Webhook Zernio → `/api/webhooks/zernio`
4. Worker + scheduler rodando
5. OpenAI / Mailserver / R2 homologados se o fluxo de onboarding precisar deles
6. **BLOCKER:** `PROACTIVE_TEMPLATE_NOT_IMPLEMENTED` / `TEMPLATE_NOT_CONFIGURED` — lembrete fora da janela ainda exige template WhatsApp real aprovado na Zernio (não bloqueia o “Oi” conversacional)

## Não feito (de propósito)

Portal cliente, split frontend/backend, billing gateway, Open Finance, multi-agent, Fase 4.
