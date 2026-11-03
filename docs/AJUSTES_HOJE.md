# Ajustes · hoje

Canal **DEV master** (WhatsApp `+5561996715985`) ↔ Cursor.

## No Zap (só esse número)

- `/ajuste sua ideia` — entra na fila; Assessor responde
- `/ajustes` — lista do dia
- `/agente` — engenheiro online ou *fora do ar*

Se o Cursor não estiver com heartbeat recente, o Assessor diz:
**Agente de (dev fora do ar** — o pedido fica na fila mesmo assim.

## No Cursor (engenheiro)

```bash
npx tsx scripts/dev-agent-heartbeat.ts          # marca online
npx tsx scripts/dev-ajustes-pull.ts             # vê pendentes
npx tsx scripts/dev-ajuste-reply.ts 1 "feito"   # fecha + avisa no Zap
```

Fila persiste em `platform_settings` (`dev` / `ajustes_hoje`).

---
