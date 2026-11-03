# Grupo de trabalho, Meet e agenda — pendências

**Atualizado em:** 28/09/2026  
**Estado:** reuniões base publicadas; melhorias de UX de grupos e recebimentos por período aguardam publicação final.

## Já está disponível em produção

- Criar grupos e incluir contatos já cadastrados.
- Convidar cada contato para autorizar lembretes pelo próprio WhatsApp. Cadastro na lista não equivale a consentimento.
- Criar lembrete de ocorrência única para um grupo, escolher membros numerados ou `todos` e confirmar antes de agendar.
- Membro MOOPE recebe lembrete no próprio workspace; contato externo recebe template Utility aprovado.
- Opt-out com `SAIR LEMBRETES`; revogação também pode ser feita pelo organizador.
- A autorização e a associação ao grupo são revalidadas no disparo. Remoção ou opt-out cancela lembrete ainda pendente.
- O envio externo usa o número empresarial do Assessor, sem criar grupo nativo e sem ler conversas.

## Reuniões de equipe publicadas

1. **Compromisso e recorrência**
   - Compromisso do organizador guarda Meet/material, regra e ID Google; os padrões suportados (`daily`, `weekly`, `weekly:N`, `monthly`) sincronizam como RRULE.
   - Lembretes são individuais por participante; remarcação atualiza reminders, outbox e calendários espelho sem cancelar acidentalmente o reminder do organizador.
   - Edição e cancelamento atuam sobre a série inteira. O organizador pode encerrar recorrência; não há edição de ocorrência isolada nem data final configurável nesta entrega.

2. **Meet e Google Agenda**
   - Com Google conectado, Meet é criado em `conferenceData.createRequest`, reutilizado no evento estável do organizador e não duplicado no sync.
   - Sem Google conectado, aceita link HTTPS fornecido pelo organizador e não afirma que criou uma sala.
   - Participante MOOPE recebe evento espelho somente no próprio workspace; o espelho Google é criado se aquele participante também conectou a conta. Não há acesso ao calendário de contato externo.
   - Cancelamento do organizador apaga o evento mestre; cancelar/dar baixa individual afeta apenas o espelho e reminder daquele participante.

3. **Participantes e consentimento**
   - Organizador cancela a série; participante usa `cancelar minha reunião` ou `baixa reunião` para parar só seus próprios avisos.
   - Consentimento e membership são verificados antes de enviar; opt-out, revogação e remoção cancelam reminders/outbox e o espelho Google vinculado.
   - Leads recebem convite, alteração e cancelamento apenas por template Utility aprovado. Falha de template não vira texto livre; uma falha na alteração é reportada sem deixar a reunião na data antiga.

4. **Links e convites externos**
   - Meet/material acompanham compromisso, reminder e template pela variável existente; não altera corpo aprovado da Meta.
   - O link é compartilhado como recebido; arquivos privados do Drive não são copiados nem tornados públicos.
   - Lead exige opt-in, seleção/telefone confirmado e confirmação do organizador antes do envio.

5. **Ajuda e experiência**
   - Manual central atualizado com seleção, confirmação, Meet, materiais, recorrência, remarcação e comandos individuais. A página web renderiza esse manual e não requer mudança de layout.
   - As mensagens informam convidados, horário e resultado por pessoa; falha no template de atualização fica visível ao organizador.

## Melhorias em validação local

 - Inclusão em grupo mantém o destino solicitado enquanto aguarda cartão ou telefone; cartão com nome diferente é recusado. Nome e telefone ficam visíveis antes de qualquer convite.
 - Grupos podem ser listados por número ou nome; o detalhe mostra os membros e o estado da autorização. A seleção de uma pessoa da lista não convida os demais membros.
 - Mensagens de reunião usam português claro e ícones; não exibem UUID. Horário passado é recusado, e o lembrete de antecedência é criado de verdade.
 - A ajuda HTML pessoal, locadora e FaceJus explica esse fluxo; nos dois últimos contextos, deixa claro que reuniões ficam na agenda pessoal.

## Recebimentos da locadora

 - `query_locadora` mantém empresa ativa e tenant selecionado e consulta o Finance com o WhatsApp ligado; o Finance continua aplicando o papel do usuário antes de devolver valores.
 - Pedidos de hoje, amanhã, semana ou mês preservam o período. A mensagem mostra o total e os lançamentos e oferece PDF/planilha no mesmo intervalo.
 - O link do calendário `/calendariorecebimentos` abre no MOOPE Gestão autenticado. Valores não são copiados para painel temporário com link bearer do Assessor.
 - O DEV master (tenant 9, papel gerente) foi consultado; logs omitiram valores monetários. O teste de arquivos foi parcial e a resposta agora identifica exatamente os formatos entregues.

## Fora desta entrega

- Convites Google Calendar por e-mail para contatos externos não são enviados; não inferimos e-mail nem acessamos calendário externo.
- Não há cópia/importação de arquivos do Drive, edição de uma ocorrência isolada ou limite final configurável da série.
- O Google Meet automático depende da conta Google conectada do organizador. Contas de participantes são independentes.

## Critérios para considerar pronto

- Google conectado: cria compromisso organizador, Meet opcional e RRULE correta; não duplica evento em sync posterior.
- Google desconectado: permite link manual e explica que Meet automático não foi criado.
- Grupo misto: seleção numerada/`todos`, confirmação explícita, evento/Meet compartilhado e lembretes individuais por participante.
- Opt-out, remoção de grupo e cancelamento de participante impedem apenas os envios futuros correspondentes; cancelamento do organizador encerra a série toda.
- Repetição não duplica mensagens/eventos; falhas de template são rastreadas e nunca viram texto livre.
- Modo família atual, lembretes pessoais, isolamento de workspaces e identidade WhatsApp continuam passando nos testes de regressão.
- Nenhuma alteração em `src/domain/whatsapp-templates-catalog.ts` ou nome/match do webhook Zernio.

## Verificação e publicação

- Suítes focadas: 33 testes passaram em equipe, contatos, Meet, templates, seleção de recebimentos e painéis.
- `npm run build` passou localmente, incluindo verificação de tipos. O `npm run typecheck` isolado tem o diagnóstico conhecido `tests/fase1-foundation.test.ts:401`.
- Build `app` e `worker`, publicação, health check e novo teste de envio PDF/planilha no DEV master ainda pendentes.
- Esta revisão ainda precisa ser enviada à VPS, reconstruída e validada em `/api/ready` antes do aviso final ao DEV master.
- Produção do Assessor: `root@assessor.facejus.com.br` (`179.236.66.68`), `/opt/moope-assessor`; senha somente em `~/.config/moopecrm/vps-ssh-pass`. Não use `147.79.83.207`.
- Não foi necessária migration. Se publicar esta revisão, atualizar `app` e `worker`; não reiniciar Postgres nem scheduler.
- Não fazer commit/push sem pedido explícito.
