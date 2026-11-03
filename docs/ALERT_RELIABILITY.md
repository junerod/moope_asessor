# Confiabilidade de alertas e agenda — MOOPE Assessor

## Princípio

**Nenhum alerta pode depender de um único passo em memória.**  
Cada ocorrência (lembrete X no horário T) vira um registro durável na **outbox** e só sai de `pending` quando o WhatsApp confirma envio (mensagem persistida).

## Arquitetura

```text
create_reminder / create_appointment
        │
        ▼
   reminders (scheduled)  ──►  alert_outbox (pending, occurrence_key único)
        │
        ▼
   scheduler (poll 5s)
     1. reclaim stuck queued (>3 min)
     2. FOR UPDATE SKIP LOCKED nos devidos
     3. enqueue agent_jobs (idempotente por ocorrência + tentativa)
     4. watchdog (~30s): fecha outbox de lembrete encerrado;
        reabre só processing com lock velho; cria outbox que não existe
        │
        ▼
   worker deliver_reminder
     send WhatsApp + persiste messages
     mark outbox delivered
     se recorrente → novo fire_at + nova outbox
```

## Garantias

| Risco | Mitigação |
|---|---|
| Dois schedulers no mesmo segundo | `SKIP LOCKED` no claim |
| Job completed sem envio real | Retry com chave `:aN`; o claim é quem reenfileira |
| Queued eterno | Reclaim >3 min → scheduled |
| Lembrete cancelado/sent com outbox aberta | Watchdog cancela a outbox uma vez e para |
| Outbox `processing` com lock > 5 min | Watchdog devolve ao claim |
| Outbox `pending` de lembrete ainda ativo | Não é órfã: o claim do poll entrega |
| Falha WhatsApp / template | Outbox `pending` + `next_attempt_at` backoff (até 12 tentativas) |
| Deploy no meio do disparo | Outbox sobrevive; watchdog reabre |
| Lista “final do dia” some após alerta | Também cria **tarefa aberta** + briefing traz pendências de ontem |
| Compromisso sem alerta | `create_appointment` cria reminder + outbox |
| Tick do scheduler quebra tudo | Cada parte em `safeTick` isolado |
| Escala (1 → milhares) | Claim em lotes 150; índices `(status, fire_at)` / outbox due |

## Tabelas

- `reminders`: `attempt_count`, `next_attempt_at`, `last_error`, `last_delivered_at`, `locked_*`, `occurrence_key`
- `alert_outbox`: verdade da entrega por ocorrência (`occurrence_key` UNIQUE)

## Operação

- Migration: `0010_alert_reliability.sql`
- Logs: `reminder_queued`, `reminder_delivered`, `alert_watchdog_repaired`, `alert_outbox_closed_with_reminder`, `reminders_reclaimed_stuck`
- `alert_watchdog_repaired` repetindo o mesmo número a cada tick é laço, não atraso. A outbox de lembrete cancelado ou já enviado tem que ir para `cancelled` uma vez e sair do conjunto.

## Regra de produto

- Alerta pontual: outbox → delivered → reminder `sent`
- Recorrente: delivered da ocorrência + nova outbox da próxima
- Briefing matinal: agenda de hoje + pendências de ontem + tarefas abertas + recorrentes
