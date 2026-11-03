# VS Code no MOOPE Assessor

Guia para continuar o trabalho neste repositório sem misturar servidor, sem usar o banco local vazio e sem alterar o que a Meta já aprovou.

Produto visível ao cliente: **MOOPE Assessor**. Cliente da locadora: **MOOPE Gestão de Frotas e Locação**. Repositório da plataforma (frotas): `~/meus-moopes/moope-finance`. São projetos diferentes.

## Dois servidores

| O quê | Onde entra | Pasta no servidor |
| --- | --- | --- |
| Assessor | senha em `~/.config/moopecrm/vps-ssh-pass`, host `root@assessor.facejus.com.br` (`179.236.66.68`) | `/opt/moope-assessor` |
| Plataforma (frotas) | `~/.config/moope/vps.env` (`VPS_HOST`, `VPS_USER`, `VPS_DIR`, `SSHPASS`) | a pasta de `VPS_DIR` |

Não há chave SSH da plataforma. O acesso é senha via `sshpass`. Não copie senha para o Git, para regra, nem para este arquivo.

Entrar no assessor:

```bash
export SSHPASS
SSHPASS=$(cat "$HOME/.config/moopecrm/vps-ssh-pass")
sshpass -e ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  root@assessor.facejus.com.br
```

Entrar na plataforma:

```bash
set -a
source ~/.config/moope/vps.env
set +a
sshpass -e ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  "${VPS_USER}@${VPS_HOST}"
```

Publicar a plataforma: na pasta `moope-finance`, `./scripts/deploy-vps.sh` (git pull + `./compila-sem-queda.sh`). Não use esse script para o assessor.

## O que não mudar

- Corpo dos templates já aprovados na Meta: `src/domain/whatsapp-templates-catalog.ts`.
- Nome do webhook Zernio: `MOOPE_ASSESSOR_WEBHOOK_NAME = "MOOPE Meu Assessor"` e o match `w.name === "MOOPE Meu Assessor"` em `src/app/api/admin/providers/zernio/webhook/route.ts`.
- Banco de produção. O `.env.local` deste Mac aponta para `127.0.0.1:54329` e está vazio. Fila `/ajuste`, heartbeat e WhatsApp do DEV rodam **dentro do container `worker` na VPS**.
- Não reinicie o `scheduler` se o arquivo alterado não for de agendamento.
- Não faça commit nem push sem pedido explícito.
- Horóscopo continua pack oculto. Não crie motor novo de água, pausa ou remédio.

## Mapa de funções

Não existe um arquivo único com todas as funções. O mapa é este.

Entrada do WhatsApp: `src/services/inbound-webhook.ts` (a mensagem chega) → job → `src/worker/process-job.ts` (decide o que responder). O modelo chama ferramentas registradas em `src/agent/tools/index.ts`. Cada arquivo abaixo faz `registerTool({ name })`.

| Arquivo | Funções (nome da ferramenta) |
| --- | --- |
| `src/agent/tools/memory.ts` | `save_memory`, `search_memory`, `save_expense`, `list_expenses`, `coach_spending` |
| `src/agent/tools/finance-ops.ts` | `undo_last_expense`, `update_expense`, `save_income`, `list_income`, `undo_last_income` |
| `src/agent/tools/personal.ts` | `monthly_balance`, `spending_insight` |
| `src/agent/tools/pending-bills.ts` | `propose_bill`, `confirm_pending_bill`, `reject_pending_bill` |
| `src/agent/tools/goals.ts` | `set_spending_goal`, `check_spending_goal` |
| `src/agent/tools/lists.ts` | `upsert_shopping_list`, `show_shopping_list` |
| `src/agent/tools/reminders.ts` | `create_reminder`, `list_reminders`, `complete_reminder`, `cancel_reminder` |
| `src/agent/tools/appointments.ts` | `create_appointment`, `list_appointments`, `update_appointment`, `cancel_appointment`, `undo_last_appointment` |
| `src/agent/tools/tasks.ts` | `create_task`, `list_tasks`, `complete_task` |
| `src/agent/tools/documents.ts` | `search_documents`, `summarize_document`, `resend_document_media` |
| `src/agent/tools/exports.ts` | `export_expenses_sheet`, `export_expenses_pdf`, `export_agenda_ics`, `week_ahead` |
| `src/agent/tools/reports.ts` | `generate_report_pdf`, `daily_briefing` |
| `src/agent/tools/google.ts` | `connect_google`, `google_status`, `sync_google_calendar`, `sync_google_sheets`, `disconnect_google` |
| `src/agent/tools/weather.ts` | `get_weather` |
| `src/agent/tools/exchange.ts` | `get_exchange_rate` |
| `src/agent/tools/web-research.ts` | `web_research` |
| `src/agent/tools/profile.ts` | `update_user_profile`, `get_user_profile` |
| `src/agent/tools/business-context.ts` | `check_business_context`, `switch_business_context` |
| `src/agent/tools/locadora.ts` | `check_locadora_integration`, `query_locadora`, `locadora_snapshot` |
| `src/agent/tools/escritorio.ts` | `check_escritorio_integration`, `query_escritorio` |
| `src/agent/tools/moope-knowledge.ts` | `search_moope_knowledge` |
| `src/domain/balance-route.ts` | escolhe balanço pessoal, locadora ou escritório antes do modelo |
| `src/domain/visual-board.ts` | link `/v/TOKEN` de 24 h, só daquela consulta |
| `src/domain/locadora-board.ts` | painel visual da locadora |
| `src/integrations/moope-finance-assessor.ts` | o assessor **consulta** a plataforma; não envia lembrete de cliente |
| `src/domain/dev-ajustes.ts` | fila `/ajuste` e heartbeat |
| `src/domain/dev-ops-commands.ts` | `/saude`, `/uso`, `/consumo`, `/ops`, `/crm on`, `/crm off` |

Agenda (container `scheduler`, `src/scheduler/index.ts`): lembretes, resumo do dia, digest semanal, alertas de gasto, clima, horóscopo, fechamento da noite, cutucão de evento do Google.

Site: `src/app/painel` só explica o que pedir. O desenho abre em `src/app/v/[token]`. Manuais em `src/app/ajuda/`.

## Como o VS Code atualiza o assessor

1. Edite em `/Users/junerod/moope-assessor`.
2. Envie só `src/` (e o que mais mudou) para `/opt/moope-assessor` na VPS.
3. Rebuild da imagem que contém o arquivo:
   - página, CSS ou webhook (`src/app`, `src/services/inbound-webhook.ts`): imagem **app**
   - ferramenta, fila, resposta do bot (`src/agent`, `src/worker`, `src/domain` usado pelo worker): imagem **worker** (a imagem copia o código na build)
   - `src/scheduler`: imagem **scheduler**, e só aí reinicie o scheduler
4. Suba de novo sem recriar o banco:

```bash
cd /opt/moope-assessor
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.docker \
  up -d --no-deps app worker
```

Site público: `https://assessor.moope.com.br`. App no host: `127.0.0.1:3010`.

Não rode `dev-ajustes-pull` neste Mac. O Postgres daqui não é o de produção.

## Mensagem para o DEV master

Número fixo: `+5561996715985`. Os scripts de notificação DEV localizam a conversa somente pela identidade desse telefone e falham sem enviar se não encontrarem uma conversa correspondente. Não usam conversa fallback nem permitem sobrescrever o destinatário por variável de ambiente.

Tudo isso roda **no worker de produção**, porque o banco certo está lá.

Aviso livre (não fecha ajuste):

```bash
npx tsx scripts/notify-dev-whatsapp.ts "texto"
```

Fechar um `/ajuste` e avisar (o script monta o texto com pedido e resposta):

```bash
npx tsx scripts/dev-ajuste-reply.ts 9 "o que foi feito"
```

No SSH, mensagem longa vai em base64. Colocar o texto direto dentro de aspas simples remotas perde a mensagem. O `exec` do claim precisa de `</dev/null`, senão o heredoc some.

```bash
export SSHPASS
SSHPASS=$(cat "$HOME/.config/moopecrm/vps-ssh-pass")
B64=$(printf '%s' "$MSG" | base64 | tr -d '\n')
sshpass -e ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  root@assessor.facejus.com.br \
  "cd /opt/moope-assessor && docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.docker exec -T -e B64=${B64} worker bash -lc 'cd /app && npx --yes tsx scripts/dev-ajuste-reply.ts ID \"\$(printf %s \"\$B64\" | base64 -d)\"'"
```

Só avise no WhatsApp quando houver mudança de verdade. Poll ocioso não manda mensagem.

CRM comercial (`comercial@moope.com.br`): avisa a Tatiana `+5531984246434` e o DEV. `/crm off` e `/crm on` valem só para o DEV. A Tatiana continua recebendo.

## Modo de espera do `/ajuste`

No WhatsApp, só o número DEV:

- `/ajuste texto` — entra na fila do dia. O assessor confirma na hora. O código fica em `src/worker/process-job.ts` e `src/domain/dev-ajustes.ts`.
- `/ajustes` — lista do dia.
- `/agente` — online ou fora do ar.

A fila fica em `platform_settings`, namespace `dev`, chave `ajustes_hoje`. Status: `pending` → `in_progress` → `done`.

O assessor considera o engenheiro online se o heartbeat tiver menos de **12 minutos** (`AGENT_ONLINE_TTL_MS`). Sem ping, ele responde que o agente está fora do ar e **mesmo assim guarda o pedido**.

Quem marca o ping é o pull, no worker:

```bash
npx tsx scripts/dev-ajustes-pull.ts
npx tsx scripts/dev-ajustes-pull.ts --claim 9
```

No VS Code, um loop local só acorda o agente. Ele não lê a fila sozinho:

```bash
while true; do
  sleep 600
  echo 'AGENT_LOOP_TICK_dev_ajustes'
done
```

A cada tick o agente entra na VPS e roda o pull. Se `pending_count` for 0, uma linha no chat basta. Se houver item novo: `--claim ID`, faz o trabalho, publica se o pedido for de produção, e só então `dev-ajuste-reply.ts`. Não responda “feito” antes de estar no ar.

Heartbeat avulso, se precisar só renovar a presença: `npx tsx scripts/dev-agent-heartbeat.ts` (também no worker).
