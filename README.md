# MOOPE Assessor

Assistente no WhatsApp. O usuário fala no Zap; o Assessor responde no mesmo chat. **Não é Open Finance nem app de banco.**

Nome do produto: **MOOPE Assessor**. Não chame de Deskcomm, MOOPE Finance ou Meu Assessor como se fosse o nome nosso. Parceiros (Gestão de Frotas, Facejus, CRM) entram no *mesmo* Zap quando o número é liberado — o Assessor continua um só.

| | |
|---|---|
| Site | https://assessor.moope.com.br |
| Manual pessoal | https://assessor.moope.com.br/ajuda/pessoal |
| Manual locadora | https://assessor.moope.com.br/ajuda/locadora |
| Manual Facejus | https://assessor.moope.com.br/ajuda/facejus |
| Painel (só ensina) | https://assessor.moope.com.br/painel |
| Gestão de frotas | https://frotas.moope.com.br |
| Facejus | https://web.facejus.com.br |
| Fonte do texto de ajuda | `src/content/help-manuals.ts` |

O pedido de números **não** fica numa URL fixa. A pessoa pede no Zap; a resposta traz um link `/v/[token]` (24h, só aquela consulta). `/painel` lista frases. PDF/Excel saem no WhatsApp.

---

## Arquitetura

Três processos + Postgres (pgvector). Sem os três, o Zap não conversa.

| Processo | Comando | Função |
|----------|---------|--------|
| **App** (Next.js) | `npm run dev` / imagem `app` | Webhook Zernio, `/ajuda`, `/v/[token]`, `/livre/[token]`, admin, OAuth Google, APIs de parceiro |
| **Worker** | `npm run worker` | Consome `agent_jobs` (`FOR UPDATE SKIP LOCKED`) e manda a resposta no Zap |
| **Scheduler** | `npm run scheduler` | Lembretes vencidos + resumos e alertas sozinhos |

```text
WhatsApp → Zernio → POST /api/webhooks/zernio
                         → inbound-webhook (HMAC, user, conversation)
                         → agent_jobs
                         → worker/process-job
                              ├ onboarding
                              ├ mídia / documento
                              ├ deliver_reminder
                              └ runAgentTurn (atalhos + desk-router + tools + LLM)
                         → sendText / sendProactiveMessage
                         → Zernio → WhatsApp
```

Isolamento: todo dado de domínio filtra `workspace_id`. Um cliente não lê o outro.

Telefone BR: o 9 do celular é completado (`src/integrations/moope-finance-assessor.ts` → `normalizePhoneE164Br`).

Acesso comercial (locadora/escritório): whitelist. O Finance/Facejus/CRM podem liberar o número; sem whitelist o Assessor responde no pessoal e recusa dado de empresa.

---

## O que o Assessor faz (pessoal)

Tudo abaixo vive no mesmo Zap, sem app extra. Fonte de frases: manuais + `src/domain/*` + tools.

### Conversar

| Função | Como pedir | Onde |
|--------|------------|------|
| Falar natural | “bom dia”, “o que você pode fazer?”, “ajuda” | runtime + `memory.ts` `coach_spending` |
| Áudio → ação | manda áudio; resposta começa com “Ouvi: …” | `inbound-media.ts` |
| Preferências | “preferências”, “desliga o resumo do dia” | `user-preferences.ts` |
| Onboarding | primeiro contato: nome, etc. | `onboarding.ts` |

### Agenda e tempo

| Função | Como pedir | Onde |
|--------|------------|------|
| Lembrete | “me lembra amanhã às 9h de ligar pro dentista” | `reminders.ts` |
| Recorrente | “toda segunda às 8h me lembre de tomar vitaminas” | `reminders.ts` + `lib/recurrence.ts` |
| Compromisso | “reunião amanhã às 15h” | `appointments.ts` |
| O que tenho | “o que tenho hoje?”, “o que tenho amanhã?”, “essa semana?” | `day-agenda.ts` |
| Dar baixa | “baixa 1”, “baixa lembrete 1 e 3”, “concluí o que já passou” | `reminder-baixa.ts` |
| Choque de horário | marca e avisa se bate; “sim” confirma | appointments + `agenda-gaps.ts` |
| Buracos livres | “sexta de manhã livre?” | `agenda-gaps.ts` |
| Choque na agenda | “tem choque na agenda?” | `agenda-gaps.ts` |
| Link para marcar | “me dá um link pra a pessoa marcar” → `/livre/[token]` (só horários livres) | `public-slots.ts` |
| Encerramento | ~21h (ou o horário dela): o que ficou aberto | `evening-wrap.ts` |
| Resumo da manhã | 07:00–09:59 SP, se `daily_brief` ligado | `daily-brief.ts` |
| Resumo semanal | domingo 09:00–11:59 SP | `weekly-digest.ts` |
| Semana à frente | “o que tenho essa semana?” / tool `week_ahead` | `exports.ts` |
| ICS | exporta agenda | `export_agenda_ics` |

### Google (opcional, um “conectar google”)

| Função | Como pedir | Onde |
|--------|------------|------|
| Ligar | “conectar google” | `tools/google.ts` + `integrations/google/oauth.ts` |
| Status / desligar | “status google”, “desconectar google” | idem |
| Puxar agenda | “sincronizar agenda” | `sync_google_calendar`, `pull.ts` |
| Mandar para o Google | cria evento / planilha quando faz sentido | `auto-push.ts`, `calendar.ts`, `sheets.ts` |
| RSVP | *sim* / *não* / *talvez* no convite | `rsvp.ts` |
| Convite no e-mail | “tem convite no email?” → “sim 1” | `gmail-invites.ts` (eventTypes `fromGmail`, sem OAuth novo) |
| Aviso ~30 min | sozinho, se `daily_brief` ou alertas de conta ligados | `google-event-nudges.ts` |
| Evento novo | anuncia o que acabou de cair na agenda | idem |

### Dinheiro pessoal (sem extrato de banco)

| Função | Como pedir | Onde |
|--------|------------|------|
| Gasto | “gastei R$ 80 de gasolina” ou foto da nota | `save_expense` |
| Foto nota/boleto | sem legenda: propõe e só grava no *sim* | `propose_bill` / `confirm_pending_bill` |
| Desfazer / corrigir | “desfaz o último gasto”, “não era 80, era 50” | `receipt-undo.ts`, `finance-ops.ts` |
| Receita | “recebi 3500 do salário” | `save_income` |
| Balanço | “balanço do mês”, “quanto sobrou?” | `monthly_balance` |
| Insight | “como estou de gastos?” | `spending_insight` |
| Teto | “quero gastar no máximo R$ 3000”, “como está o teto” | `goals.ts`, `recurring-money.ts` |
| Radar | avisa em **70%**; alerta em **80%** ou estouro | `goals.ts`, `finance-alerts.ts` |
| Todo mês | “Academia 89,90 todo mês” | `recurring-money.ts` |
| Fora do padrão | “isso saiu do padrão hoje?” (vs últimos 14 dias lançados) | `spend-anomaly.ts` |
| Vale / IOU | “emprestei 200 pro Lucas”, “quem me deve?”, “recebi 200 do Lucas” | `personal-iou.ts` |
| Relatório | “me manda o relatório” → PDF + Excel no Zap | `reports.ts`, `exports.ts` |

### Cobrar e avisar outra pessoa (`desk-router`)

Frase com outra pessoa **não** vai solta no LLM. Passa por `src/domain/desk-router.ts`.

| Função | Como pedir | Comportamento |
|--------|------------|----------------|
| Cobrar agora | “José me deve R$ 50 cobre ele agora” | Manda na hora, **sem sim**. Sem número: pede 📎. Template Zernio + `wa.me` do **organizador** |
| Trocar telefone | “troca o telefone do José” + contato | `family-contacts.ts` `replaceContactPhone` |
| Quem me deve | lista; **não** manda Zap — para mandar use “cobre agora” | `personal-iou.ts` |
| Cobrar depois | “cobrar Pedro em 2 dias se não responder” | lembrete para *você* | `social-followup.ts` |
| Tom | no rascunho: “mais curto”, “mais formal”, “mais direto” | `notice-tone.ts` |
| Reunião com gente | assunto + data + hora; se faltar, pergunta uma coisa | Meet se Google ligado; confirma lista; `todos` / `confirmar` |
| Desistir | “cancelar” ou mudou de assunto | rascunho cai (`isAbandon` / `isFreshCommand`) |

Quem **não** usa o Assessor: template aprovado (`assessor_reminder` / `assessor_notification`) + link do telefone de quem pediu. Arquivo: `external-notice.ts`.

### Família, grupos, ata, tarefas, docs

| Função | Como pedir | Onde |
|--------|------------|------|
| Família | “família” + 📎 contato | `family-contacts.ts` |
| Grupo | “criar grupo CRM”, “meus grupos”, “adicionar Tatiana ao grupo CRM” | `team-reminders.ts` |
| Avisar grupo | “reunião às 15h para o grupo Trabalho” | idem; quem não usa recebe convite-template |
| Ata | “faz a ata” | `meeting-notes.ts` |
| Tarefa + projeto | “projeto Casa: pintar muro até sexta” | `task-projects.ts` |
| Atraso | “tarefas atrasadas”, “o que atrasou” | idem |
| Relatório de tarefas | “relatório de tarefas” | PDF no Zap |
| Pasta | “guarda na pasta contratos”, “documentos da pasta contratos”, “acha a foto do RG” | `doc-folders.ts` |
| Receita médica | foto da receita | documents + memória |
| Lista de mercado | “lista de mercado: leite, pão” | `lists.ts` |
| Memória | “lembra que meu dentista é…”, “o que você lembra de mim?” | `save_memory` |
| Pesquisa | “pesquisa preço médio de IPVA” → resposta com *Fonte* | `web-research.ts` |

### Deslocamento, tempo, câmbio, viagem

| Função | Como pedir | Onde |
|--------|------------|------|
| Tempo de rota | “quanto tempo até o aeroporto” (pede pin 📎) | `routes.ts`, `leave-home.ts` |
| Mapa | “me dá o mapa até o shopping” | idem |
| Saí de casa | “que horas sair pra reunião das 15h” | `leave-home.ts` |
| Base | “salvar base”, “minha base” | weather/routes prefs |
| Tempo | “como está o tempo?”, “tempo em Curitiba PR” | `weather.ts` |
| Tempo todo dia | “me avisa o tempo todo dia às 7h” | `weather-prefs.ts`, `weather-alerts.ts` |
| Câmbio | “cotação do dólar”, “100 dólares em reais” | `exchange.ts` |
| Modo viagem | “modo viagem em Lisboa” / “desliga modo viagem” | `travel-mode.ts` |
| Horóscopo | só se a pessoa ligou e escolheu signo/hora | `horoscope.ts` |

### Mídia

- Foto nota/cupom/boleto → propõe gasto; boleto só depois de *sim* claro
- Foto de comida → kcal / macros
- Outra foto → o que viu; perguntar se manda ou guarda
- Áudio → transcreve e executa
- Comprovante depois do lembrete de conta → “já paguei” / “depois” / foto

---

## Locadora (MOOPE Gestão / moope-finance)

No mesmo Zap, **depois** que o dono libera o WhatsApp em Configurações → **Assessor MOOPE** em https://frotas.moope.com.br.

O Assessor **não** lê o banco do Finance. Ele chama HTTP o Finance; o Finance devolve texto, cards e arquivos. Papel do telefone manda: gerente/financeiro veem R$; operação/atendimento não.

### O que a pessoa pede no Zap

| Intent canônico | Frases | Quadro / arquivo |
|-----------------|--------|------------------|
| `capacidades` | “o que o assessor pode fazer pela locadora?” | texto |
| `resumo` | “resumo da locadora”, “como está a locadora?” | `/v` |
| `inadimplencia` | “inadimplentes”, “quem deve” | `/v` |
| `receita` | “rendimentos da locadora”, “lucro da locadora” | gráfico + PDF/Excel |
| `recebimentos` | “o que entra hoje”, “calendário de recebimentos” | `/v` |
| `frota` | “carros disponíveis”, “frota por filial/operação” | texto / `/v` |
| `veiculos` | “veículos da locadora”, “minha frota”, “veículo ABC1D23” | cards + ficha |
| `investidores` | “investidores da locadora” | só quem tem carro ativo, último repasse, acumulado do ano |
| `locatarios` | “locatários da locadora”, “locatário Maria Souza” | atraso / semana / mês / pago |
| `alertas` | “alertas da locadora”, fora 24/48/72h, TAG | `/v` |
| `vistorias` | vistorias abertas + link | texto |
| `manutencoes` | OS / manutenções | texto |
| `preventivas` | preventivas, CNH a vencer | texto |
| (passthrough) | “onde está a placa ABC1D23”, sinistros, multas, contratos, devoluções, IoT/TAG/carrinho | o Finance interpreta o `q` |

Intent no Assessor: `src/domain/locadora-intent.ts` (`detectLocadoraIntent`). Tools: `check_locadora_integration`, `query_locadora`, `locadora_snapshot`. Board: `src/domain/locadora-board.ts`.

### Assessor → Finance (o Finance precisa implementar)

Base: `MOOPE_FINANCE_API_URL` (default `https://frotas.moope.com.br`)  
Header: `X-Assessor-Moope-Secret: {MOOPE_FINANCE_ASSESSOR_SECRET}`  
Cliente: `src/integrations/moope-finance-assessor.ts`

| Método | Path | Query | Uso |
|--------|------|-------|-----|
| GET | `/api/assessor-moope/resolve` | `phone=+55…` | Este Zap está ligado? papéis, empresas |
| GET | `/api/assessor-moope/ask` | `phone`, `q`, `tenant_id?` | Pergunta livre / intent |
| GET | `/api/assessor-moope/snapshot` | `phone`, `tenant_id?` | Pacote do painel |
| GET | `/api/assessor-moope/rendimentos/arquivo` | `userid`, `start`, `end`, `kind=pdf\|xlsx` | Arquivo de rendimentos |

Resposta típica de `ask`/`resolve` (`LocadoraResolveResult`):

```json
{
  "ok": true,
  "integrated": true,
  "text": "markdown para o Zap",
  "links": [{ "userid": 1, "empresa_nome": "X", "papel": "gerente", "scopes": [], "phone_e164": "+55…" }],
  "rendimentos": {},
  "investidores": {},
  "locatarios": {},
  "veiculos": {},
  "snapshot": {},
  "send_xlsx": false,
  "xlsx_base64": null,
  "xlsx_name": null
}
```

`integrated: false` → o Assessor ensina a ligar em Configurações → Assessor MOOPE.  
Retry único em 401/403/5xx (restart do Finance). Timeout 25s (arquivo 60s).

### Finance → Assessor (o Finance chama)

Mesmo secret, header `X-Assessor-Moope-Secret`.

**Liberar / tirar o WhatsApp da whitelist**

`POST https://assessor.moope.com.br/api/partner/moope-finance/whitelist`

```json
{ "action": "add", "phone": "61999990000", "label": "opcional", "notes": "opcional" }
{ "action": "remove", "phone": "61999990000" }
```

**Pedir link curto do painel da locadora** (24h)

`POST https://assessor.moope.com.br/api/partner/moope-finance/painel`

```json
{ "phone": "+5561999990000", "org": "Locadora X", "snapshot": {} }
```

Resposta: `{ "ok": true, "url": "https://assessor.moope.com.br/v/…" }`.

Quando o número está integrado, o Assessor também espelha sozinho na whitelist (`ensureWhitelistFromLocadora`).

Código: `src/app/api/partner/moope-finance/*`.

---

## Facejus (escritório)

Mesmo Zap, depois que o admin liga Administração → Assessor MOOPE no Facejus.

| Função | Frases |
|--------|--------|
| Ligado? | “tenho integração facejus?”, “meu escritório está ligado?” |
| Processos | “meus processos”, CNJ, cliente, CPF/CNPJ, área, filial |
| KPIs | “resumo do escritório”, “quantos processos ativos” |
| Andamento | “andamento do processo 0001234-…” |
| Agenda de atendimento | “agenda de atendimento”, filial, OAB, “PDF agenda de atendimento” |
| Agenda de prazos | “agenda de prazos processuais”, “PDF agenda de prazos” |
| Agenda jurídica (legado) | “agenda jurídica de hoje” |

Papéis: *sócio* vê o escritório; *advogado* só o que é dele. Duas agendas **não** misturam (`src/domain/facejus-commands.ts`).

### Assessor → Facejus

Base: `FACEJUS_API_URL` (default `https://web.facejus.com.br`)  
Header: `X-Assessor-Facejus-Secret`  
Cliente: `src/integrations/facejus-assessor.ts`

| GET | Path | Query |
|-----|------|-------|
| resolve | `/api/assessor-escritorio/resolve` | `phone` |
| ask | `/api/assessor-escritorio/ask` | `phone`, `q`, `tenant_id?` |
| buscar | `/api/assessor-escritorio/buscar` | `phone`, `tenant_id`, `q` |
| andamento | `/api/assessor-escritorio/andamento` | `phone`, `tenant_id`, `numero` |
| agenda | `/api/assessor-escritorio/agenda` | `phone`, `tenant_id`, `dia`, `natureza?`, `escritorio_id?` |
| agenda-pdf | `/api/assessor-escritorio/agenda-pdf` | idem, `Accept: application/pdf` |

`ask` pode devolver `send_pdf` + `pdf_base64` / `pdf_url` — o Assessor manda o PDF no Zap.

Tools: `check_escritorio_integration`, `query_escritorio`. Board: `src/domain/facejus-board.ts`.

---

## CRM (parceiro, não é o nome do Assessor)

O CRM avisa no Zap do *dono* que entrou lead ou que o lead respondeu. A resposta ao cliente é **no CRM**, não neste bot.

`POST https://assessor.moope.com.br/api/partner/deskcomm/alert`  
Header: `X-Assessor-Moope-Secret` (o mesmo da locadora)

```json
{ "action": "add", "phone": "61999990000", "organization": "Escritório X" }
{ "action": "remove", "phone": "61999990000" }
{ "action": "alert", "notice": "new", "phone": "61988880000", "phones": ["61988880000"],
  "client_name": "Ana", "client_phone": "61977770000", "preview": "Oi, quero alugar",
  "organization": "CRM", "line_label": "Site", "conversation_id": "abc", "event_id": "opcional" }
```

`notice`: `new` | `reply`. Código: `src/app/api/partner/deskcomm/alert/route.ts`.

---

## Google

OAuth: `GET /api/integrations/google/start` → callback `/api/integrations/google/callback`.  
Arquivos: `src/integrations/google/{oauth,calendar,sheets,pull,auto-push,rsvp,gmail-invites}.ts`.  
Não pedir scope novo de Gmail: convite usa Calendar `eventTypes=fromGmail`.

---

## Zernio (canal WhatsApp)

### Nós recebemos

`POST /api/webhooks/zernio`  
Header `X-Zernio-Signature` (HMAC do body).  
Inbound → `messages` + job `inbound:{eventId}`.  
`message.sent` / `delivered` / `failed` só auditam — **não** reenviam.

### Nós mandamos

Sempre `Idempotency-Key`.

| Caso | Função | Arquivo |
|------|--------|---------|
| Resposta na janela 24h | `sendText` | `channels/zernio/client.ts` |
| Proativo / fora da janela | `sendProactiveMessage` | `channels/zernio/proactive.ts` |
| Template na conversa | `sendWhatsAppTemplateMessage` | `templates-api.ts` |
| Template sem conversa | `createWhatsAppTemplateConversation` | idem |

```http
POST {ZERNIO_API_URL}/inbox/conversations/{id}/messages
Authorization: Bearer {key}
Idempotency-Key: {chave}
{ "accountId": "{account}", "message": "…" }
```

Template: mesmo path + `templateName`, `templateLanguage`, `templateParams`.

Catálogo lógico (`src/domain/whatsapp-templates-catalog.ts`) — **não mudar o nome do webhook “MOOPE Meu Assessor”**:

`reminder`, `daily_brief`, `notification`, `weekly_digest`, `finance_alert`, `bill_due`, `appointment`, `conflict`, `welcome`, `goal_alert`, `pending_boleto`, `news`, `infra_alert`.

Trava nossa: `outbound_send_keys` + `usage_counters` (`send-once.ts`). Uma chave = um POST *nosso*.  
O Cloud API já entregou **dois** `wamid` para um POST — isso é no Zernio, não se resolve com mais lock no scheduler.

Credencial efetiva: admin/banco (`resolveZernioRuntimeConfig`). `.env` é bootstrap.

---

## Tools do agente (LLM)

Registradas em `src/agent/tools/index.ts`. Policy: `src/agent/policy/engine.ts`.

| Tool | Faz |
|------|-----|
| `save_memory` `search_memory` `coach_spending` | memória / menu ajuda |
| `save_expense` `list_expenses` | gastos |
| `save_income` `list_income` `undo_last_*` `update_*` | receitas / correção |
| `propose_bill` `confirm_pending_bill` `reject_pending_bill` | boleto/nota no *sim* |
| `set_spending_goal` `check_spending_goal` | teto |
| `monthly_balance` `spending_insight` | balanço |
| `create_reminder` `list_reminders` `complete_reminder` `cancel_reminder` `undo_last_reminder` | lembretes |
| `create_appointment` `list_appointments` `update_appointment` `cancel_appointment` `undo_last_appointment` | agenda |
| `create_task` `list_tasks` `complete_task` | tarefas |
| `search_documents` `summarize_document` `resend_document_media` | arquivos |
| `upsert_shopping_list` `show_shopping_list` | mercado |
| `connect_google` `google_status` `sync_google_calendar` `sync_google_sheets` `disconnect_google` | Google |
| `get_weather` `get_exchange_rate` | tempo / câmbio |
| `web_research` | pesquisa com *Fonte* |
| `generate_report_pdf` `daily_briefing` `export_expenses_sheet` `export_expenses_pdf` `export_agenda_ics` `week_ahead` | relatórios |
| `update_user_profile` `get_user_profile` | perfil |
| `check_business_context` `switch_business_context` | pessoal ↔ locadora ↔ escritório |
| `check_locadora_integration` `query_locadora` `locadora_snapshot` | Finance |
| `check_escritorio_integration` `query_escritorio` | Facejus |
| `search_moope_knowledge` | texto institucional |

Atalhos **antes** do LLM: locadora (rendimentos, investidores, veículos, locatários, status, IoT), desk (cobrar/avisar), dia, baixa, gasto, sync Google, painel, livre/choque.

Contexto de negócio: se o número tem locadora **e** escritório, o Assessor pergunta qual usar (`business-context.ts`).

---

## Scheduler (sozinho)

`src/scheduler/index.ts` — poll ~5s; bloco pesado ~60s.

| Job | Arquivo | Quando |
|-----|---------|--------|
| Lembretes | `queue-reminders.ts` | contínuo |
| Resumo do dia | `daily-brief.ts` | 07:00–09:59 SP |
| Semanal | `weekly-digest.ts` | domingo 09–12 SP |
| Encerramento | `evening-wrap.ts` | hora do usuário (default 21h, 15 min) |
| Meta / boleto | `finance-alerts.ts` | 08–21h |
| Tempo | `weather-alerts.ts` | hora escolhida |
| Horóscopo | `horoscope-alerts.ts` | se ligou |
| Google | `google-event-nudges.ts` | no bloco de digest |

---

## Rotas HTTP do Assessor

| Rota | Quem chama | Uso |
|------|------------|-----|
| `POST /api/webhooks/zernio` | Zernio | inbound |
| `GET /api/health` `GET /api/ready` | infra | saúde |
| `POST /api/partner/moope-finance/whitelist` | Finance | libera Zap |
| `POST /api/partner/moope-finance/painel` | Finance | link `/v` |
| `POST /api/partner/deskcomm/alert` | CRM | whitelist + alerta de lead |
| `GET /api/integrations/google/start` | usuário | OAuth |
| `GET /api/integrations/google/callback` | Google | OAuth |
| `GET /api/livre/[token]` `POST` | quem marca horário | slots |
| `GET /v/[token]` | celular | card 24h |
| `/ajuda/*` `/painel` `/admin` | humano | docs / ops |
| `POST /api/auth/login` | admin | JWT |

---

## Env de integração

| Variável | Uso |
|----------|-----|
| `MOOPE_FINANCE_API_URL` | default `https://frotas.moope.com.br` |
| `MOOPE_FINANCE_ASSESSOR_SECRET` | Assessor↔Finance **e** APIs `/api/partner/*` |
| `FACEJUS_API_URL` | default `https://web.facejus.com.br` |
| `FACEJUS_ASSESSOR_SECRET` | Assessor↔Facejus |
| `ZERNIO_API_URL` `ZERNIO_API_KEY` `ZERNIO_ACCOUNT_ID` `ZERNIO_WEBHOOK_SECRET` | canal Zap |
| `DATABASE_URL` | Postgres |

Definição: `src/config/env.ts`. Exemplo: `.env.example`.

---

## Arquivos-chave

| Área | Path |
|------|------|
| Webhook | `src/services/inbound-webhook.ts` |
| Worker | `src/worker/process-job.ts` |
| Turno | `src/agent/runtime.ts` |
| Desk (outra pessoa) | `src/domain/desk-router.ts` |
| Aviso externo | `src/domain/external-notice.ts` |
| Envio único | `src/domain/send-once.ts` |
| Cliente Zernio | `src/channels/zernio/client.ts` `proactive.ts` |
| Finance | `src/integrations/moope-finance-assessor.ts` |
| Intent locadora | `src/domain/locadora-intent.ts` |
| Facejus | `src/integrations/facejus-assessor.ts` |
| Google | `src/integrations/google/*` |
| Schema | `src/db/schema/index.ts` |
| Manuais | `src/content/help-manuals.ts` |
| Frases do painel | `src/domain/painel-menu.ts` |

---

## Local e produção

```bash
cp .env.example .env.local
npm run docker:up          # PG :54329, app :3010
npm install && npm run db:migrate && npm test
npm run dev && npm run worker && npm run scheduler
```

Produção: `root@assessor.facejus.com.br` (`179.236.66.68`, o mesmo do ping) `/opt/moope-assessor`. Não use `147.79.83.207`.  
`docker-compose.yml` + `docker-compose.prod.yml --env-file .env.docker`.  
**rsync sem `--delete`.** Worker/scheduler: `docker cp` o `.ts` → `/app/...`, `chown assessor:nodejs`, restart. Next (`/ajuda`, `/v`, `/livre`): rebuild `moope-assessor-app:local`. Scheduler só se `src/scheduler/` mudou.  
DEV: `npx tsx scripts/notify-dev-whatsapp.ts` (4 linhas).

Webhook prod: `https://assessor.moope.com.br/api/webhooks/zernio`.

Testes de trava: `tests/nao-trava.test.ts`, `tests/send-once.test.ts`, `tests/remaining-36.test.ts`.

---

## Regras para outro sistema / outro agente

- Uma voz. Sem Open Finance.
- Outra pessoa (cobrar, reunião com, avisar X) → `desk-router`.
- Cobrar **agora** = template na hora, sem *sim*. Sem número = pede contato.
- Quem não usa o Assessor: template + `wa.me` do organizador.
- Zap: uma pergunta, nome *negrito*, `R$ 50,00`, `sexta 10/10 · 15h`. Sem inventar 10:00.
- Pedido misturado = uma mensagem.
- Locadora/escritório: o Assessor **pergunta**; o Finance/Facejus **calculam e devolvem**. Não duplicar regra de negócio aqui.
- Não editar Frotas, Facejus, admin, landing como se fossem o produto Assessor.
- Não alterar o catálogo de templates nem o nome do webhook.
- Não regressar: resumo do dia, baixa, gasto/receita, boleto+sim, lista, memória, locadora, escritório, RSVP.
- Commit só se pedirem.

Fora de escopo (não implementar daqui): extrato bancário, agentes nomeados, heatmap, link de pagamento extra, drive 50MB, mesa de pesquisa.

Fundação antiga: `docs/FASE_1_FUNDACAO_RESULTADO.md`.
