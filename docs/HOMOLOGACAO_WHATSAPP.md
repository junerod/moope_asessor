# Homologação WhatsApp — MOOPE Meu Assessor

Checklist para validar o caminho vertical com credenciais reais.

Pré-requisitos: app + worker + scheduler rodando; `/admin` com Zernio, OpenAI e Email configurados e testados; webhook público apontando para `/api/webhooks/zernio`.

```text
[ ] Zernio configurada no Admin
[ ] OpenAI configurada no Admin
[ ] Email configurado no Admin
[ ] Template "reminder" status=active (se for testar fora da janela)
[ ] Número oficial visível no Admin

[ ] mandar "Oi" de número novo
[ ] onboarding inicia
[ ] informar nome
[ ] informar email
[ ] receber código
[ ] validar código
[ ] aceitar termos

[ ] "Guarda que meu contador é Marcos"
[ ] "Quem é meu contador?"

[ ] "Me lembra daqui a 5 minutos de testar"
[ ] receber lembrete

[ ] "Agenda reunião sexta às 14h"
[ ] "O que tenho sexta?"

[ ] enviar PDF
[ ] "Resume isso"
[ ] perguntar informação específica do PDF

[ ] enviar foto
[ ] perguntar sobre foto

[ ] enviar áudio:
    "Carlos pediu 10% de desconto e amanhã
     me lembra de responder"

[ ] validar memory + reminder
```

Smoke opcional (APIs externas, fora de `npm test`):

```bash
npm run smoke:zernio
npm run smoke:openai
npm run smoke:email
```

Se alguma etapa falhar, registrar no Admin → Jobs (dead letter) e Audit.
