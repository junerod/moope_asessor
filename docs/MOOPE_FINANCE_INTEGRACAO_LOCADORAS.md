# Integração Assessor MOOPE ↔ MOOPE Gestão de Frotas e Locação

> Nome de cliente: **MOOPE Gestão de Frotas e Locação** ([frotas.moope.com.br](https://frotas.moope.com.br)).  
> “Finance” / `moope-finance` = nome interno técnico (API, repo, env).

Visão de produto: o Assessor no WhatsApp como canal conversacional; o MOOPE Gestão como fonte de verdade operacional da locadora.

## Modelo de vínculo (implementado)

1. No MOOPE Gestão (`frotas.moope.com.br`): **Configurações → Assessor MOOPE** (`/empresaassessormoope`).
2. Dono da conta liga a integração e cadastra WhatsApps **por número**, com papel:
   - **Gerente** — frota + contratos + ops + **R$**
   - **Financeiro** — foco em **R$** (receita/despesa/inadimplência/faturas)
   - **Operação / frota** — frota/contratos/ops, **sem R$**
   - **Atendimento** — contratos/resumo leve, **sem R$**
3. Tabelas: `assessor_moope_config`, `assessor_moope_contatos` (migration `217_assessor_moope.sql`).
4. Assessor chama Finance com header `X-Assessor-Moope-Secret` + telefone E.164 da conversa.
5. Finance só responde se o número estiver ativo e a integração ligada — nunca mistura tenants.
6. Telefone BR: 9 do celular normalizado automaticamente (com/sem 9).
7. Assessor **pessoal** (finanças da pessoa) é independente — escopos só cortam dados da **locadora**.

## APIs Finance

| Rota | Auth | Uso |
|------|------|-----|
| `GET/PUT /api/assessor-moope/config` | JWT dono | Ligar integração |
| `POST/DELETE /api/assessor-moope/contatos` | JWT dono | Liberar telefones |
| `PATCH /api/assessor-moope/contatos/:id` | JWT dono | Trocar papel / ativo |
| `GET /api/assessor-moope/resolve?phone=` | shared secret | “Tenho integração?” |
| `GET /api/assessor-moope/ask?phone=&q=` | shared secret | Pergunta dirigida |
| `GET /api/assessor-moope/snapshot?phone=` | shared secret | Resumo completo |

## Como o usuário usa no WhatsApp (no ar)

1. `o que o assessor pode fazer pela locadora?` → menu de capacidades
2. `tenho integração moope locadora?`
3. `minha locadora: resumo` / `carros disponíveis` / `receita deste mês` / `inadimplência`
4. `recebido hoje` / `recebido esta semana` / `fluxo de caixa` / `ticket médio`
5. `devoluções dos próximos 7 dias` / `devoluções 24h` / `renovações desta semana`
6. `sinistros abertos` / `multas a pagar` (valores só com papel Gerente/Financeiro)
7. `frota por filial` / `frota por operação` / `carros da operação Uber`
8. `alertas da locadora` / `alertas de rastreamento` (por **placa**)
9. `contratos a vencer` / `CNH a vencer` / `preventivas da semana`
10. `quem está com o carro ABC1D23`
11. `vistorias abertas` / `vistoria da placa ABC1D23`
12. `manutenções do mês da placa ABC1D23`
13. `lançamentos` / `faturas` / `extrato do contrato` da placa
14. `onde está o carro ABC1D23` — mapa, online/offline, bateria V / TAG %

## Lista ampla

### Frota e disponibilidade
- [x] Carros disponíveis agora
- [x] Por filial (`veiculos.filial_id` + `filiais`)
- [x] Por operação (`veiculos.operacao_id` + `operacoes.nome` — ex.: Uber, Particular)
- [x] Carros em manutenção (no resumo)
- [x] Previsão de devolução 24h/7 dias
- [x] Status/posição por placa (mapa, online/offline)
- [x] Bateria veículo (V) vs TAG (%)
- [x] Alertas por placa (24/48/72h, duplo, TAG)
- [ ] Quilometragem e alerta de revisão por KM do odômetro ao vivo
- [ ] CRLV / documentos do veículo vencendo

### Contratos e locação
- [x] Contratos ativos / a vencer
- [x] Quem está com o carro X
- [x] Extrato contratual + faturas abertas da placa
- [x] Renovações previstas na semana (lista dedicada)
- [ ] Check-in / check-out pendentes
- [ ] PDF do contrato no Zap (com confirmação)

### Financeiro / rendimentos
- [x] Faturamento do mês / mês passado
- [x] Despesas do mês
- [x] Inadimplência resumida
- [x] Lançamentos por placa/período
- [x] Faturas Asaas em aberto com link
- [x] Recebido hoje / esta semana
- [x] Ticket médio de locação
- [x] Fluxo de caixa resumido (receita − despesa do mês)

### Operação / sinistros / multas
- [x] Vistorias abertas + link relatório
- [x] Preventivas / OS
- [x] Sinistros em aberto (lista)
- [x] Multas a pagar (lista; valor só com papel c/ R$)
- [ ] Corte de energia 48h (eventos de rastreamento Moope)

## Cobrança / multi-usuário
- [x] Escopos por papel (gerente/financeiro/operação/atendimento) + texto UX do que cada um libera (com/sem R$)
- [ ] Cobrança via link com confirmação explícita
- [ ] Resumo matinal automático da loja
- [ ] Auditoria de perguntas no Assessor

## Manuais (HTML)

- Hub: https://assessor.moope.com.br/ajuda
- Pessoal: https://assessor.moope.com.br/ajuda/pessoal
- Locadora: https://assessor.moope.com.br/ajuda/locadora

Só páginas web — sem PDF de manual (abrir o link já basta).

## Próximas (deixar para depois)

PDF do contrato no Zap, cobrança com confirmação, resumo matinal, auditoria, corte 48h de rastreamento Moope, odômetro ao vivo, CRLV.

## Princípios
- WhatsApp = interface; Finance = sistema de registro
- Contagem de rastreamento **por placa**, não por aparelho
- Confirmação explícita para qualquer ação de cobrança/alteração
- Sempre link institucional https://moope.com.br para comercial/planos
- R$ da locadora só com papel gerente/financeiro no **telefone** liberado
- Sempre dizer **Moope** (rastreamento Moope) — nunca citar nomes de plataformas de terceiros

## Memória do Assessor

Playbook: `platform_knowledge` slug `moope-assessor-locadora-integracao` + memória `locadora_playbook`.

Seed: `npx tsx scripts/seed-locadora-playbook.ts`.
