# Levantamento — intenção, mundos e contaminação no WhatsApp

Data: 13/10/2026. Fonte: prints das 15:33–16:45 e o código atual do Assessor.
Escopo: diagnóstico e estratégia. Nenhuma correção de roteamento entra antes desta regra fechar.

## Veredito

O Assessor não está “confundindo com a IA” no sentido de não saber português. Ele decide o módulo **antes** de entender o pedido, por palavra solta. A primeira porta que casa ganha e **encerra o turno**. O assunto do compromisso vira gatilho de locadora, IoT, rota ou lista do dia. O que a pessoa pediu não é gravado.

Pessoal, locadora, Facejus e CRM podem coexistir no mesmo número. O pessoal é a faixa de baixo e nunca fecha. O contexto empresarial é só uma lente para **consulta** daquele mundo. Hoje o código trata contexto como modo que sequestra a próxima frase.

A IA entra tarde demais, nas frases que nenhum atalho pegou, e cedo demais no prompt: o próprio prompt manda tratar “rota / carrinhos” como locadora **mesmo dentro de um compromisso**. Memória e histórico não podem preencher título de registro novo.

## O que cada print foi, de fato

### 1. “Ligar 17h00 para Locadora MOve GO para falar com Adan” → “está anotada… 15 minutos antes”

Resposta livre do modelo. Essa frase **não existe** em nenhum template do código (`está anotada` não aparece no repositório).

O pedido também não entra no atalho de compromisso. `looksLikeAppointmentCreate` só aceita agenda, agendar, marque, marcar, compromisso ou reunião. “Ligar às 17h” não é nenhum desses. “Me lembra” também não está na frase, então não é lembrete determinístico.

Duas portas ainda podem roubar essa frase no código atual:

- A palavra **Locadora** no assunto liga `isBusinessWorldCommand`. Se o número tem mais de uma empresa e nenhuma ativa, o turno vira o menu “qual contexto?” e o compromisso morre.
- “falar com Adan” liga a mesa de recados (`routeDeskTurn`) e perguntaria se deve avisar o Adan. Não foi isso que saiu no print, então esse turno chegou no modelo.

A trava anti-fantasma não pega “está anotada / vou te lembrar”. Ela só bloqueia “agendei / compromisso criado” junto com “pronto” ou ✅. O modelo pode confirmar sem ter gravado.

### 2. “18h00 verificar o aplicativo do Bistek… recolher carrinhos e criar rotas” → menu SOLUTT / SOLUTT

Não é pergunta de locadora. É outro compromisso, sem o verbo que o atalho reconhece (“anotar” não está em `isPersonalLifeCommand`).

`looksLikeIotQuestion` vê **carrinhos** e desvia para `query_locadora` sem passar pelo modelo. A tool, sem empresa ativa, devolve `formatChooser`. O texto do print é esse menu, palavra por palavra.

O assunto “criar rotas pelo aplicativo” era o que a pessoa ia fazer às 18h. O roteador leu como operação IoT.

O print lista a mesma SOLUTT duas vezes. `dedupeBusinessOptions` já existe e colapsa o mesmo nome. Se o Zap ainda mostra duas linhas iguais, o processo em produção está atrás deste código, ou os dois vínculos não normalizam para a mesma chave. Mesmo com uma linha só, o menu não deveria ter aberto.

### 3. “Anotar compromisso para as 18h00 … para gerar rotas” → card Rotas

Esta porta fica no worker, **antes** do agente (`process-job`, bloco Rotas).

`looksLikeRouteIntent` casa se o texto tem menos de 200 caracteres, contém `rota` (e “rotas” contém `rota`) e contém `para`. A exclusão de carrinho/locadora **não está nesta frase** — estava na anterior. `parseRouteDestination` não acha um lugar, então `handleRouteTurn` manda o card de exemplos: aeroporto, Taguatinga, Asa Norte. É o print.

O compromisso das 18h não foi criado.

### 4. “Anotar compromisso 15h30 ligar para o senhor Adam da movie Go” → “Seu dia” com LOCACAR

Não criou LOCACAR. Listou o dia.

`looksLikeDayList` aceita qualquer texto com até 80 caracteres que contenha `compromisso`. A frase do Adam cabe e contém essa palavra. Esse atalho roda no runtime **antes** de `appointment-direct`. A tool chamada é `list_reminders` de hoje.

O único item era um compromisso **já salvo**: “Reunião com cliente LOCACAR”, 13/10 às 17:00. O assunto longo (contratos de investidores, mensagens para locatários, acesso em massa) é o que foi dito num dia anterior — o teste `reliability-intake` usa quase a mesma frase, com “LOCACCAR”. O nome não veio da memória solta no momento do Adam. Veio de um registro antigo, exibido porque o pedido novo foi classificado como “me mostra o dia”.

### 5. 16:45 “Lembrete: Reunião com cliente LOCACAR” + `appointment:42b7c542-…`

Disparo dos 15 minutos anteriores às 17:00. Não é resposta ao Adam.

`create_appointment` grava o lembrete com:

```text
note: appointment:<uuid>
<descrição>
```

`formatReminderDelivery` imprime `payload.note` cru, até 180 caracteres, com o emoji de nota. O UUID é chave interna para achar o compromisso na baixa (`reminder-baixa`, `day-agenda`). Nunca deveria aparecer no Zap.

### 6. “Alerta confiabilidade Assessor” no meio do chat

Job de saúde (phantoms, jobs failed, gaps). Não é resposta da frase. Cai no mesmo fio e parece mensagem sem sentido. Phantoms (1h): 1 combina com confirmação falada sem gravação, ou com lembrete que não fechou entrega. É sintoma, não a causa do roteamento.

## Por que os mundos se cruzam

Há dezenas de `looksLike*` em série. O primeiro `true` responde e dá `return`. Não existe um classificador único que diga o **ato** e depois o **mundo**.

Ordem que importa neste incidente:

1. Worker, antes do agente: preferências, painel, câmbio, família, viagem, memória, **saí de casa**, **rotas**.
2. Runtime: troca de contexto; se há várias empresas e a frase parece “mundo empresa”, **menu e para**.
3. Atalhos de locadora/IoT (rendimento, investidor, veículo, locatário, status, carrinho).
4. Mesa de recados (`falar com`, cobrar, reunião com gente).
5. `looksLikeDayList` — a palavra compromisso vira lista.
6. Só então `create_reminder` / `create_appointment` determinísticos.
7. O que sobrou vai para o modelo, com as últimas 8 mensagens e até 8 memórias.

`isPersonalLifeCommand` só protege o que **começa** com agendar/agenda/marcar/compromisso/reunião, ou tem “me lembra” / “gastei”. “Anotar compromisso…”, “ligar 17h…”, “18h00 verificar…” passam batido e caem na porta errada.

O prompt se contradiz no mesmo bloco:

- Linha da “rota / recolha / carrinhos”: **nunca** é compromisso, use `query_locadora`.
- Linha da regra de ouro: lembrete e compromisso são **sempre** pessoais.

As duas instruções estão ativas. O atalho de IoT obedece a primeira.

## Matriz do que não pode se misturar

| Ato da pessoa | Mundo | O que gravar / consultar | O que está proibido |
|---|---|---|---|
| Anotar, agendar, marcar, lembrar, ligar às, compromisso com horário | Pessoal, sempre | Título = o que foi dito agora. Aviso 15 min se não pedirem outro | Menu de empresa, rota, IoT, Facejus, CRM, lista do dia, memória antiga no título |
| Quanto tempo / rota até / trânsito para **um lugar** | Pessoal (mapa) | Destino explícito | Qualquer frase que só mencione a palavra rota dentro de um assunto |
| Gastei, recebi, quem me deve | Pessoal | Lançamento | Locadora financeira |
| Locatários, veículos, frota, inadimplência, rendimento, “como está a locadora” | Locadora | `query_locadora` no tenant ativo | Agenda pessoal |
| Carrinhos, TAG, fora da loja, rota **de recolha** como pedido | IoT | `query_locadora` no tenant IoT | Assunto de compromisso que cita carrinho ou rota |
| Processos, OAB, prazos judiciais, agenda jurídica | Facejus | `query_escritorio` | Nunca locadora. “Processo” dentro de assunto pessoal não conta |
| Leads, funil, CRM | CRM | Consulta CRM | Não herda título de compromisso nem tenant da locadora |
| Onde estou / trocar empresa / agora a locadora NOME | Lente | Só troca a lente empresarial | Não apaga pessoal e não engole a frase seguinte |
| Seu dia, o que tenho hoje, quais compromissos | Lista | `list_reminders` do dia | Frase que **cria** compromisso |

O mesmo telefone pode ter pessoal + uma locadora + Facejus + CRM, ou só o pessoal. Com uma empresa só, a lente liga sozinha. Com duas empresas **diferentes** e uma consulta de fato empresarial, aí sim pergunta qual. Duas linhas da mesma razão social não são escolha.

Palavra no **assunto** não escolhe mundo. “Locadora MOve GO”, “carrinhos”, “rotas”, “processo”, “investidor”, “locatário” dentro de “anotar compromisso …” são texto do título.

## O que a IA deve e não deve fazer

A IA não decide o módulo quando o ato já está claro. “Anotar compromisso 15h30 ligar para o Adam da Movie Go” é ato fechado: gravar, título literal, horário 15:30, confirmar o que foi salvo.

A IA serve para o resto: frase ambígua sem verbo e sem horário, resumo, tom de recado, pesquisa. Mesmo aí ela recebe o ato já classificado e não pode trocar de ferramenta por causa do histórico.

Título de registro novo sai só da frase atual. Memória, último compromisso e as 8 mensagens anteriores não entram nesse campo. Foi isso que fez o dia do Adam parecer o dia do LOCACAR: a lista mostrou o registro velho, e o disparo das 16:45 repetiu o assunto velho com UUID.

Confirmação só depois do insert, com o título que está na linha salva. Se não salvou, a frase é “não gravei”, nunca “está anotada”.

## Estratégia definitiva (antes de codar)

### 1. Uma porta só, no início do turno

Antes de rotas, IoT, menu de empresa e lista do dia, classificar o **ato**:

- `registrar_pessoal` — anotar, agendar, marcar, compromisso, lembrete, me lembra, ligar + horário, tenho compromisso.
- `listar_dia` — só pergunta: o que tenho, minha agenda, quais compromissos, seu dia. A palavra compromisso sozinha não lista.
- `consultar_locadora` / `consultar_iot` / `consultar_facejus` / `consultar_crm` — o pedido **é** a consulta, não um substantivo no meio.
- `rota_deslocamento` — quanto tempo, trânsito, “até [lugar]”, “rota até”. “Gerar rotas” como assunto não entra.
- `trocar_lente` — onde estou, trocar empresa, mudar contexto, agora a locadora NOME. Nada mais.
- `residual` — aí o modelo, com o ato travado se a porta anterior já soube.

`registrar_pessoal` não lê e não grava contexto empresarial. Não pergunta empresa. Não muda a lente.

### 2. Título fechado na frase

Extrair horário e título no código, como `buildCreateAppointmentArgs` já faz quando chega lá. Incluir os verbos que a pessoa usa de verdade: anotar, ligar às, deixar marcado, verificar às. O título não passa pelo modelo.

### 3. Nota do Zap sem chave interna

`appointment:<uuid>` fica só em `payload.appointment_id`. O Zap mostra título, horário e, se a pessoa escreveu um detalhe, uma linha “Assunto:”. Sem UUID, sem nome de tool, sem id de job.

### 4. Lente empresarial

Perguntar empresa apenas quando o ato é consulta locadora/IoT/Facejus/CRM **e** existem dois tenants de fato diferentes sem lente ativa. Consulta com um tenant só segue. Compromisso nunca pergunta. “Onde estou?” responde e para; não rearma o menu no próximo compromisso.

### 5. Prompt

Apagar a regra “rota / carrinhos nunca é compromisso”. Substituir por: substantivo no assunto não escolhe tool. O modelo não reescreve título. O modelo não confirma gravação sem tool ok.

### 6. Prova, uma frase por exemplo do manual

Cada exemplo de `help-manuals.ts` (pessoal, locadora, Facejus, CRM) vira um caso: ato esperado, módulo esperado, e a garantia de que a frase **não** cai no módulo vizinho. Os quatro prints desta conversa entram como regressão fixa:

- “Ligar 17h00 para Locadora MOve GO para falar com Adan” → compromisso pessoal, título com MOve GO e Adan, sem menu.
- “18h00 verificar o aplicativo do Bistek… carrinhos e criar rotas” → compromisso, sem IoT e sem chooser.
- “Anotar compromisso … para gerar rotas” → compromisso, sem card Rotas.
- “Anotar compromisso 15h30 ligar para o senhor Adam da movie Go” → grava esse título às 15:30, não lista o LOCACAR.
- Disparo do lembrete → sem `appointment:` e sem UUID.

Enquanto esses cinco não passarem, não se mexe em prompt solto nem se acrescenta outro `looksLike*`.
