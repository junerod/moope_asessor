# Roadmap — Assessor pessoal (ferramenta de apoio)

Princípios: **sem regressão**, WhatsApp-first, mensagens bonitas e fáceis.

## P0 / P1 / P2 — status

| Fase | Status |
|---|---|
| P0 hábito (brief, prefs, alertas, onboarding) | ✅ |
| P1 diferenciação (conflitos, boleto UX, rotinas) | ✅ |
| P2 memória no brief | ✅ |
| P2 resiliência fora da janela 24h (fallback free-form) | ✅ |
| Ajuda HTML + novidades | ✅ |
| Aviso WhatsApp aos usuários | ✅ script `broadcast-whats-new.ts` (manual `--send`) |
| Google Calendar upsert (sem duplicar) | ✅ 2026-09-26 |
| Google ler Agenda + “o que tenho hoje?” | ✅ 2026-09-26 |
| Google nudge ~30 min antes | ✅ 2026-09-26 |
| Sheets ao vivo após gasto | ✅ 2026-09-26 |
| Follow-up WhatsApp após process_document | ✅ 2026-09-26 |
| Modo família (contato 📎 + avisa também) | ✅ 2026-09-26 |
| Mini-portal web fora do Zap | ⏳ backlog baixo |

## Comandos úteis

```bash
# Simular destinatários
npx tsx scripts/broadcast-whats-new.ts

# Enviar de verdade (todos)
npx tsx scripts/broadcast-whats-new.ts --send

# Só geral (sem locadora/facejus)
npx tsx scripts/broadcast-whats-new.ts --send --audience=geral
```
