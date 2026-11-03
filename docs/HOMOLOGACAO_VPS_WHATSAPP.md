# Homologação VPS WhatsApp — MOOPE Meu Assessor

Documento factual. Sem secrets.

## VPS

```text
OS:             Ubuntu 22.04.5 LTS (facejus)
Docker:         29.7.2 + Compose v2.29.7
Proxy:          Apache2 → 127.0.0.1:3010
Domínio:        https://assessor.moope.com.br  (canônico / APP_BASE_URL)
                https://assessor.facejus.com.br (mesmo backend)
HTTPS:          VALID
App/Worker/Scheduler/Postgres: ONLINE
```

## Admin (NÃO é acesso.facejus.com.br)

```text
URL:   https://assessor.moope.com.br/admin
       https://assessor.facejus.com.br/admin
User:  admin@moope.com.br
```

`acesso.facejus.com.br` é outro produto (Facejus). Assessor = `/admin` nos hosts acima.

## Providers

```text
OpenAI:     REAL API TESTED
Mailserver: NÃO TESTADO (falta SMOKE_EMAIL_TO)
Zernio:     REAL API TESTED
```

## WhatsApp

```text
ASSISTANT:   ACTIVE — MOOPE Assessor (+1 323-250-****)
Webhook:     CONFIGURED → https://assessor.facejus.com.br/api/webhooks/zernio
APP_BASE_URL: https://assessor.facejus.com.br
Inbound:     PASSOU (após fix parse sender.phoneNumber)
Outbound:    AGUARDANDO confirmação no celular
Onboarding:  job onboarding_message completed
```

## Fix aplicado

Payload Zernio real traz telefone em `message.sender.phoneNumber` (não em `contact`).
Parser atualizado + teste de regressão `tests/zernio-parse-real-payload.test.ts`.
Replay do "Oi" enfileirou onboarding com sucesso.

## Whitelist

```text
Migration: 0005_client_access_whitelist.sql
Admin UI:  /admin/whitelist
Paywall:   DESLIGADO (homologação — qualquer número onboards)
```

Números na whitelist passam mesmo com paywall ligado (sem cobrança / sem “em dia”).

## Blockers restantes

1. Você enviar `Oi` no WhatsApp para o número MOOPE Assessor
2. Smoke email (opcional para onboarding completo)
3. Template fora da janela (conhecido; não bloqueia Oi conversacional)
