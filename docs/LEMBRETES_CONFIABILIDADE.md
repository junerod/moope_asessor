# Confiabilidade de lembretes (Assessor)

## Problema que quebrava o produto

O LLM (gpt-4o-mini) respondia *“Vou te lembrar… Pronto ✅”* **sem** chamar `create_reminder`.
Resultado: confirmação no Zap, **zero** linha em `reminders` → cron/scheduler não tinham o que disparar.

Isso **não** era falha de entrega. Era falha de **gravação**.

## Arquitetura em 4 blocos (não misturar)

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐     ┌──────────────┐
│ 1. INTAKE   │────▶│ 2. PERSISTENCE   │────▶│ 3. DELIVERY     │────▶│ 4. INTEGRITY │
│ intent+hora │     │ reminder+outbox  │     │ claim→job→Zap   │     │ varredura    │
└─────────────┘     └──────────────────┘     └─────────────────┘     └──────────────┘
```

### 1) Intake (criação)
- Arquivos: `domain/reminder-intent.ts`, atalho em `agent/runtime.ts` (`reminder-direct`)
- Compromissos: `domain/appointment-intent.ts` → `appointment-direct` (mesma garantia)
- Regra: pedido “me lembre + horário” **não passa pelo LLM** para gravar
- Rede de segurança: se o LLM “confirmar” sem tool → força `create_reminder` / `create_appointment`
- Hard gate: **nunca** envia “Pronto te lembro / agendei” sem tool ok

### 2) Persistence
- Tool: `agent/tools/reminders.ts` → tabela `reminders` + `alert_outbox`
- Status inicial: `scheduled`, `next_attempt_at = fire_at`

### 3) Delivery
- Scheduler: `queue-reminders.ts` → claim `SKIP LOCKED` → job `deliver_reminder`
- Watchdog: `alert-delivery.ts` `runAlertWatchdog` (outbox órfã / stuck)
- Worker: `process-job.ts` entrega WhatsApp

### 4) Integrity (varredura contínua)
- Arquivo: `domain/reminder-integrity.ts`
- A cada ~60s o scheduler roda `runReminderIntegritySweep`
- Detecta inbound “me lembre+hora” **sem** reminder criado na janela
- Cura: cria reminder (+ outbox) com `payload.recovered_from_message_id`
- Horários passados → dispara em ~2 min (atrasado, mas ainda avisa)
- Alertas: `domain/reliability-alerts.ts` → WhatsApp DEV + `/admin/reliability`

## Operação

```bash
# Dry-run (lista gaps)
npx tsx scripts/heal-reminder-integrity.ts --dry-run --hours=168

# Cura de verdade (últimos 7 dias)
npx tsx scripts/heal-reminder-integrity.ts --hours=168

# Smoke create → claim → enqueue (no worker)
npm run smoke:reminder
npm run smoke:reminder:deliver   # também enfileira delivery
```

## Admin

| Página | Quem | O quê |
| --- | --- | --- |
| `/admin/broadcast` | só `super_admin` | mensagem em massa (todos / geral / locadora / iot / facejus) com contagem + prévia + dry-run |
| `/admin/reliability` | só `super_admin` | phantoms, healed, overdue, jobs failed, heartbeats |

## Métricas / alertas a observar
- `phantom_reminder_confirm_blocked` / `phantom_reminder_reply_blocked`
- `phantom_appointment_confirm_blocked` / `phantom_appointment_reply_blocked`
- `reminder_integrity_healed` / `reminder_integrity_sweep`
- `reliability_threshold_breach`
- `reminder_queued` / `reminders_reclaimed_stuck` / `alert_watchdog_repaired`
- `admin_broadcast_done`

## Regra de ouro de produto
> Confirmação no WhatsApp **só** depois do `INSERT` em `reminders` / `appointments` ter sucesso.
> Qualquer outro caminho é bug.
