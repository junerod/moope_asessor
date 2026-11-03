# Docker — MOOPE Meu Assessor

Stack local pronto; o mesmo compose sobe na VPS depois (com `docker-compose.prod.yml`).

## Serviços

| Serviço | Função | Porta host (local) |
| --- | --- | --- |
| `postgres` | Postgres 16 + pgvector | `54329` |
| `migrate` | aplica migrations (one-shot) | — |
| `app` | Next.js (Admin + APIs + webhook) | `3010` |
| `worker` | processa jobs do Assessor | — |
| `scheduler` | lembretes / ticks | — |

## Local

```bash
# 1) sobe tudo (gera .env.docker a partir de .env.local se preciso)
npm run docker:up

# 2) cria superadmin
npm run docker:bootstrap-admin

# 3) abrir
open http://localhost:3010/admin
# admin@moope.com.br / BMW@m00pes   (ou ASSESSOR_ADMIN_*)
```

Outros:

```bash
npm run docker:logs          # todos
npm run docker:logs app      # só app
npm run docker:migrate
npm run docker:rebuild
npm run docker:down
```

## VPS (quando informar a máquina)

1. Copiar repo + `.env.docker` (secrets fortes, `APP_BASE_URL=https://...`)
2. No servidor:

```bash
export ASSESSOR_DOCKER_PROD=1
# ou:
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.docker up -d --build

npm run docker:bootstrap-admin   # com ASSESSOR_HTTP_PORT se diferente
```

3. Proxy HTTPS (Traefik/Caddy/Apache) → `127.0.0.1:3010`
4. Webhook Zernio: no Admin → **Criar webhook na Zernio** (precisa URL pública)

## Notas

- Banco **próprio** do Assessor (não misturar com CRM/Supabase).
- Mídia pesada em **R2** (não no disco do container).
- RAM típica desta stack: ~2,5–3,5 GB com os `mem_limit`s do compose.
