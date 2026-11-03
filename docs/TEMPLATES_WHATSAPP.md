# Templates WhatsApp — Meu Assessor (Zernio → Meta)

## Regras (obrigatórias)

| Onde | Quebra de linha |
|---|---|
| Texto **fixo** do template (fora de `{{n}}`) | Enter / `\n` normal |
| Dentro de variável `{{n}}` | **`\r`** (Meta barra `\n` → erro **132018**) |
| Linha em branco dentro de `{{n}}` | `\r\r` |

- Template **não pode começar** com parâmetro.
- Template **não pode terminar** com parâmetro.
- Nome: `^[a-z][a-z0-9_]*$`, idioma `pt_BR`.

Helper: `src/lib/whatsapp-template-params.ts` (`toTemplateParam`).

## Estratégia P0 → P2

| Fase | Templates | Uso no código |
|---|---|---|
| **P0** | `assessor_reminder`, `assessor_daily_brief`, `assessor_notification` | lembrete / brief / fallback |
| **P1** | `assessor_weekly_digest`, `assessor_finance_alert`, `assessor_bill_due`, `assessor_appointment`, `assessor_conflict` | digest / meta / contas / agenda |
| **P2** | `assessor_welcome`, `assessor_goal_alert`, `assessor_pending_boleto`, `assessor_news` (MARKETING), `assessor_infra_alert` | welcome / boleto / broadcast / DEV |

**OTP / AUTH abandonado** — código de onboarding fica em free-form (janela 24h). Catálogo: 13 templates.

Envio fora da janela 24h: `sendProactiveMessage` → API real `templateName` + `templateParams` (com `\r` nos params). Só dispara se status local = `active`/`approved`.

## Relatório — passo publicar (2026-09-24)

| Resultado | Qtd | Detalhe |
|---|---|---|
| Criados e **PENDING** Meta | **13** | P0–P2 utilitários + news |
| OTP | **abandonado** | não vamos usar AUTH no Zap |

**Próximo:** aguardar APPROVED · `/templates_sync` · testar envio fora da janela.

## Limite de mensagens Meta (WABA)

O contador do Manager é de **conversas iniciadas pelo negócio / 24h** (não “cada bolha”).

| Faixa atual | Significado |
|---|---|
| **2.000 / 24h** | Teto de conversas *business-initiated* (template / fora da janela) |
| Subir p/ 10k | Precisa ~1.000 clientes únicos em 7 dias + qualidade alta |

**Não atrapalha agora** (poucos usuários). Atrapaalha só em escala com muitos briefs/lembretes **fora** da janela 24h. Respostas dentro da janela (usuário falou) **não** consomem esse limite da mesma forma.

## Comandos

```bash
npx tsx scripts/zernio-templates-publish.ts
npx tsx scripts/zernio-templates-publish.ts --sync
npx tsx scripts/zernio-templates-report-dev.ts

# DEV WhatsApp
/templates
/templates_sync
```
