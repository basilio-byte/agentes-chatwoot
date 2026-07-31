<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Seahub Agentes

Plataforma de agentes de I.A. que atendem no Chatwoot da Seahub Coworking.

- Stack e arquitetura: **`docs/00-stack-e-arquitetura.md`** — leia antes de mudar estrutura.
- Deploy: **`docs/01-deploy-easypanel.md`** — imagem publicada no GHCR a cada push na `main`.

### Contexto que não dá para inferir do código

- **Single-tenant.** Atende só a Seahub. Não existe `tenantId` e não se deve
  adicionar sem pedido explícito.
- **Chatwoot é self-hosted.** A versão exata ainda não foi confirmada — a API de
  Agent Bots mudou entre versões, então confira antes de escrever o cliente (Fase 2).
- **ClickUp e ERP Conexa:** a documentação de API ainda não foi fornecida. Não
  invente endpoints nem shapes de payload dessas duas integrações.
- Documentos, UI e mensagens ao operador em **pt-BR**. Código e identificadores em inglês.

### Versões que fogem do treino

| Pacote | Versão | Pegadinha |
| --- | --- | --- |
| Next | 16 | `middleware.ts` virou `proxy.ts`. `params` é `Promise` e precisa de `await`. |
| Prisma | 7 | Exige **driver adapter** (`@prisma/adapter-pg`). A URL do banco fica em `prisma.config.ts`, não no `schema.prisma`. Cliente gerado em `src/generated/prisma/`. |
| Zod | 4 | `z.toJSONSchema()` é nativo — não instale `zod-to-json-schema`. |
| openai | 7 | Usado como cliente da **OpenRouter** (`baseURL` trocada), não da OpenAI. |
| Auth.js | v5 beta | Config dividida: `auth.config.ts` (edge, sem providers) e `auth.ts` (Node, com bcrypt + Prisma). |

### LLM: OpenRouter, não Anthropic

Decisão do usuário em 2026-07-28. **Não reintroduza o SDK da Anthropic** nem
modelos `anthropic/*` como padrão.

- Cliente: SDK `openai` com `baseURL` da OpenRouter (`src/server/agents/openrouter.ts`).
  `OPENROUTER_BASE_URL` sobrescreve o endpoint — serve para mock em teste.
- `model` no banco é o **slug da OpenRouter** (`provedor/modelo`), validado contra
  o catálogo ao vivo antes de salvar.
- O catálogo vem de `GET /models` (público, sem chave) com cache de 1h em memória
  e lista de reserva se a API cair — ver `src/server/agents/catalogo.ts`.
- `usage: { include: true }` no request faz a OpenRouter devolver o custo real em
  `usage.cost`. É ele que vai para `AgentRun.costUsd`.
- `reasoning: { effort }` só é enviado se o modelo declarar suporte e o effort não
  for `none`.

### Chatwoot: um bot por agente

- Cada agente tem o **seu** Agent Bot, com token e secret próprios em
  `AgentChatwootBot` (blob AES-256-GCM). Por isso o webhook é
  `/api/webhooks/chatwoot/<agentId>` — a URL identifica o bot **antes** de
  verificar a assinatura, sem depender do payload.
- Assinatura: `HMAC-SHA256(secret, "{timestamp}.{corpo cru}")`. O corpo tem de
  ser o texto cru de `req.text()`; reserializar o JSON quebra a verificação.
- `message_type` é **string** no webhook (`incoming`) e **número** na API de
  mensagens (0 entrada, 1 saída). Confundir faz o bot ler as próprias respostas.
- `jobId` do BullMQ **não aceita `:`** — use `conversa-<id>`.
- **`add` com `jobId` existente é ignorado em silêncio**, inclusive quando o job
  já terminou. Como o id é fixo por conversa, um job que falhou de vez envenenava
  a conversa por 24h (`removeOnFail`): toda mensagem seguinte sumia, o webhook
  respondia "agendado" e o worker nunca via nada. `agendarAtendimento` remove o
  job existente em **qualquer** estado menos `active`.
- **O formato do payload muda por evento.** Em `message_created` a conversa vem
  aninhada em `conversation`; em `conversation_status_changed` e
  `conversation_updated` o payload **é** a conversa — id no topo, sem
  `conversation`. Ler só o aninhado fazia a resolução passar batido. Ver
  `lerConversa`, e a guarda de que o id do topo só vale para evento de conversa
  (em mensagem, aquele id é da MENSAGEM, e resolveria a conversa errada).
- **Resolver é detectado por QUALQUER entrega**, dos dois webhooks. Mensagem
  nova depois disso reabre o atendimento — só de `CLOSED`, porque `HUMAN`
  continua com quem assumiu. Sem reabrir, o worker recusaria a conversa para
  sempre, já que ele só processa `BOT`.
- **Chatwoot nasce ligado em todo agente.** Não é integração opcional: é o
  canal. Desligá-lo não cala o agente, só tira as tools de transferência — quem
  quer um agente que nunca transfere usa a allowlist. Antes só quem tinha bot
  ganhava o vínculo, e com a porta única o especialista nascia sem transferir.
- **Silêncio precisa deixar rastro.** Batimento do worker no Redis, entregas de
  webhook com resultado e detalhe (inclusive as recusadas, cujo corpo NÃO é
  guardado por não ter sido verificado), e `Conversation.ultimaFalha` para falha
  anterior à chamada do modelo — que não cria `AgentRun` e ficaria invisível.
- **O token de Agent Bot escreve mas não lê.** `GET /conversations/{id}` responde
  `Access to this endpoint is not authorized for bots`. Por isso o
  `ChatwootClient` recebe dois tokens: o do bot para agir e um **token de
  usuário** para ler estado e histórico (global, em Integrações). Sem o de
  leitura o atendimento morre antes de chamar o modelo.

### ClickUp: armadilhas da API v2

Todas cobertas por teste em `src/server/integrations/clickup/client.test.ts` —
se mexer no cliente, rode-o.

- **Auth sem `Bearer`**: o header é `Authorization: pk_...` cru. Quem vem de
  outras APIs erra aqui.
- **`assignees` muda de forma**: array `[1,2]` no *create*, objeto
  `{add:[1], rem:[2]}` no *update*. Mandar array no update não dá erro — apenas
  não atribui ninguém.
- **Não existe busca textual.** Só filtros estruturados; casar por nome é feito
  no cliente (`filtrarPorTexto`).
- **Prioridade vem em três formas**: id `"1".."4"`, rótulo em inglês
  (`urgent`/`high`/…) e o nome em português que usamos. `nomeDaPrioridade`
  aceita as três.
- **Status é texto livre por lista.** Antes de atualizar, o agente precisa dos
  status válidos — vêm de `clickup_listar_estrutura`.
- **Tag vai no caminho, não no corpo** (`/task/{id}/tag/{nome}`), precisa
  `encodeURIComponent` e só aplica tag que **já existe** no espaço.
- **Item de checklist carrega o id do checklist na rota**
  (`/checklist/{chk}/checklist_item/{item}`), não só o id do item.
- **Tempo usa `tid`**, não `task_id`, e é sempre do dono do token — a API não
  cronometra em nome de outra pessoa.
- **Comentário é endereçado direto** (`/comment/{id}`), sem a tarefa na rota.

### Campos personalizados: por que o agente fugia deles

O agente coletava os dados e escrevia tudo num **comentário**. Não era o prompt:
preencher campo exigia descobrir ids e **uma chamada por campo**, e o caminho
estourava o `maxToolIterations` (padrão 8) antes de terminar. Modelo que não
consegue pagar o caminho certo pega o atalho.

`campos.ts` é puro e testado — mexeu, rode `campos.test.ts`.

- **`custom_fields` vai no create** (`[{id, value}]`). Sem isso a única via era
  criar e depois definir campo a campo.
- **O id do campo é por lista.** Em tarefa que já existe, descobrimos a lista
  pela própria tarefa (`obterTarefa().list.id`) — o agente não sabe disso.
- **`drop_down` e `labels` querem o id da *opção***, não o rótulo. O agente
  conhece "Mensal"; a API quer o UUID.
- **`Number("")` é 0.** "a combinar" num campo de moeda gravava **R$ 0,00** em
  silêncio. Sem dígito no texto, é erro — tem teste.
- **Campo errado aborta o lote inteiro**, e a resposta devolve os nomes que
  existem. Tarefa criada com metade dos dados é pior do que pedir correção.
- **Escrever em `formula`/`rollup` é recusado aqui**, não na API.

### Catálogo de tools: 32 em 10 categorias

`categoria` em `ToolDefinition` existe **só para a tela do agente** agrupar. A
ordem que vai para a API continua sendo alfabética por nome.

- **A UI agrupa na ordem do catálogo.** Espalhar tools da mesma categoria em
  pontos diferentes do array cria dois grupos com o mesmo título — tem teste
  em `clickup/catalogo.test.ts`.
- **`requiresConfirmation` é o que marca "escreve" na interface.** Toda tool que
  altera o ClickUp precisa dele; consulta nenhuma pode ter. O teste trava a
  lista inteira, então incluir tool nova exige atualizá-lo conscientemente.
- **Capacidade duplicada fura a allowlist.** Status saiu de
  `clickup_atualizar_tarefa` e virou `clickup_mudar_status`: bloquear uma tool
  não adianta se outra faz a mesma coisa.
- **A allowlist de espaços vale para escrita também** (`espacoBloqueado`) —
  senão restringir espaços só limitaria a leitura.
- Todas as 32 ligadas pesam **~3,9k tokens em toda mensagem**. A tela mostra a
  estimativa (`tokensAproximadosDaTool`) para a escolha ser informada.

### Regras globais de atendimento

Em `src/server/integrations/chatwoot/regras.ts`, puras e testadas. Aplicadas em
três pontos, e o terceiro é o que as torna absolutas:

1. Na chegada do webhook — filtro barato, evita encher a fila.
2. No início do processamento — estado do nosso banco.
3. **Antes de enviar, contra o estado ao vivo do Chatwoot** — e de novo depois da
   chamada ao modelo, porque um humano pode assumir enquanto o agente pensa.

As regras:

- **Conversa atribuída a humano: o agente cala.** Vale mesmo com a conversa aberta.
- **Conversa resolvida: nenhuma interação.**
- **Conversa do bot nunca fica pendente.** O Chatwoot põe em `pending` a
  conversa de caixa com Agent Bot, e `pending` não aparece na visualização
  padrão — ficaria invisível para a equipe. O bot **age** em `open` e
  `pending`, mas **termina sempre em `open`** (`precisaAbrir`). E nunca
  resolve: encerrar é decisão de pessoa.
- **Resolver corta o histórico** (`Conversation.historicoDesde`). Reabriu, começa
  do zero: o mesmo cliente costuma voltar por outro assunto, e arrastar contexto
  antigo faz o agente responder a pergunta errada.

⚠ O webhook de **Agent Bot pode não entregar `conversation_status_changed`**. Por
isso existe o webhook **de conta** (`/api/webhooks/chatwoot/conta`), com secret
próprio: ele dá precisão ao corte quando a conversa é resolvida sem ninguém
escrever. As regras 1 e 2 não dependem dele — o worker checa ao vivo.

### Equipe de agentes: o bot é a porta

O Chatwoot amarra **um Agent Bot por caixa de entrada**. Por isso o bot não é
"do agente": ele é a **porta**. Atrás dela, `Conversation.agentId` decide quem
pensa, e toda resposta sai pela porta — o cliente vê uma identidade só.

- **O worker lê `conversa.agentId` antes do `agentId` do job.** O job carrega a
  porta; o dono da conversa é quem manda. Ordem: dono → agente de entrada → porta.
  A porta no fim é o que impede o atendimento de virar silêncio quando não há
  entrada configurada.
- **`Agent.key` não acompanha o nome.** Os colegas referenciam o agente por ela
  nos prompts; renomear não pode quebrar transferência já escrita.
- **`routingDescription` vazio esconde o agente do roster.** É proposital: sem a
  descrição, o modelo não tem como decidir e transferiria no escuro.
- **O roster vai no system prompt; o bastão vai como mensagem.** O roster é
  estável (só muda quando alguém mexe na equipe), então cacheia. O bastão muda
  por conversa — no prefixo, destruiria o cache a cada mensagem.
- **A transferência acontece no mesmo ciclo.** O colega assume e responde no
  mesmo turno. Se fosse assíncrono, o cliente ficaria mudo até escrever de novo.
- **A tool só registra a intenção; quem envia é o worker.** Todo envio ao cliente
  sai de um lugar só — senão uma transferência que falha depois deixaria um
  "vou te passar" solto na conversa.
- **`aviso` é parâmetro obrigatório da tool.** O cliente sempre é avisado
  (decisão do usuário). Deixar isso para o prompt faria o modelo esquecer às
  vezes; obrigatório, o modelo escreve o texto e o sistema garante o envio.
- **Resolver zera dono e bastão** junto com `historicoDesde` — senão a conversa
  reabre direto no especialista do atendimento anterior.

#### Arquivar é diferente de desligar

`Agent.archivedAt` é um terceiro estado, não um sinônimo de `active: false`.
Desligado é pausa e continua na lista; arquivado saiu de circulação.

- **Arquivar desliga e limpa `isEntry`** na mesma operação — arquivado que
  seguisse atendendo, ou que continuasse sendo a entrada, seria pior que não ter
  arquivado.
- **Restaurar devolve DESLIGADO.** Voltar a falar com cliente é uma segunda
  decisão; religar junto faria um agente antigo reaparecer sem ninguém conferir
  o prompt.
- **`alternarAtivo` recusa ligar agente arquivado** — restaurar primeiro.
- **Arquivado sai das consultas de equipe** (`where: { archivedAt: null }` no
  runner, no worker e na tool de transferência): não roteia, não recebe
  transferência e não aparece no prompt de ninguém.
- **Excluir cascateia para `AgentRun`** e leva junto histórico de custo e tool
  calls. Por isso a exclusão fica atrás de confirmação que diz quantas execuções
  e versões somem, e sugere arquivar.

#### Escopo: conta e caixa de entrada

- **Só um agente de entrada, garantido por índice parcial** (`Agent_unico_de_entrada`).
  A checagem na ação existe para dar mensagem boa; quem realmente impede dois é
  o banco — tem verificação mostrando o `Unique constraint` disparando.
- **`Agent.inboxMode`/`inboxIds`** definem onde o agente atua. Filtra a escolha
  da **entrada** e o **roster** (não adianta oferecer colega que não atende
  aquela caixa), mas **nunca** o dono da conversa nem a porta — tirar o
  atendimento de quem já assumiu, ou calar a porta, é pior que atender fora do
  escopo.
- **Escopo ausente ou pela metade atende.** `specific` com lista vazia, ou caixa
  desconhecida, resolve como "atende": transformar campo esquecido em silêncio é
  o pior desfecho possível. `atendeInbox` tem teste para os dois casos.
- **`AgentChatwootBot.accountId` sobrescreve a conta global.** A instância
  (`baseUrl`) continua uma só; a conta é por bot, porque é o token dele que fala
  com aquela conta. Nulo = herda a de Integrações.
- O model `AgentInbox` foi **removido** (estava vazio e nunca foi lido) — o
  escopo vive em `Agent.inboxIds`, que é o que a tela edita por vírgula.

#### Travas do laço (`travas.ts`)

Quatro, porque pegam coisas diferentes. `LIMITE_POR_PAR` **tem de ser ≤**
`LIMITE_DE_VISITAS`: se as visitas mordessem antes, o pinga-pong seria
diagnosticado como "agente acionado demais" e a nota interna perderia a
informação que resolve o problema. Tem teste travando essa ordem.

Cadeia longa é **legítima** (reservas → documentos → serviços → suporte →
recurso), e um agente concentrador é visitado várias vezes — os limites são
generosos por isso, e só são seguros porque encostar neles escala para humano.

#### O relógio da espera (`aguardandoDesde`)

Mede **uma coisa só**: há quanto tempo o cliente está sem resposta do bot. Não é
o tempo da conversa, nem silêncio do cliente, nem SLA de pessoa.

- **Acende** quando a mensagem do cliente chega ao webhook — e só se ninguém já
  estava esperando: três mensagens picotadas são UMA espera.
- **Para** quando o agente responde. Se não parasse, viraria o tempo total da
  conversa e toda conversa longa acabaria escalada, com o agente respondendo na
  hora. Tem teste em `worker.test.ts`.
- **Segue correndo durante as transferências.** O aviso de passagem não é
  atendimento — o cliente continua esperando a resposta de verdade, e não se
  importa por quantas mãos a conversa passou.
- **Para também ao entregar a conversa a uma pessoa**, em qualquer um dos seis
  caminhos. Por isso `entregarAoHumano` é a **única porta** para o estado
  `HUMAN`: a tripa de campos estava repetida em seis lugares, e quando
  `aguardandoDesde` entrou, cinco esqueceram — o vigia reescalava conversa que
  já estava com alguém.
- **Resolver zera.** Sem isso o relógio sobrevivia à reabertura e o vigia
  escalava a conversa nova no primeiro minuto, sem ninguém entender por quê.

- **Invariante acima de tudo: o turno nunca termina com o cliente sem nada.**
  `garantirRespostaAoCliente` roda no `finally` e cobre exceção, agente sem
  texto e destino que sumiu. Humano assumido no meio não conta como falha.

### Regras do projeto

- **Toda rota em `/api/` checa a própria sessão.** O `proxy.ts` não cobre `/api/*`
  de propósito: um redirect devolveria HTML onde o cliente espera JSON.
- **O `proxy.ts` também não pode cobrir arquivos estáticos.** O otimizador de
  imagem do Next busca a origem **server-side, sem o cookie do usuário**: se o
  proxy interceptar `/algo.png`, ele recebe o HTML do login e a imagem quebra.
  O matcher exclui qualquer caminho com extensão.
- **Mudou um `@default`? Migre as linhas existentes.** Default novo só vale para
  linha nova — os agentes que já existem ficam no valor antigo e a mudança
  parece não ter funcionado. Suba só quem está exatamente no default anterior;
  quem escolheu outro valor de propósito não pode ser sobrescrito. Ver a
  migration `limites_mais_altos`.
- **`maxTokens` é cortado pelo limite do modelo** (`limitarSaida`, com o
  `maxSaida` do catálogo). O padrão é alto — 16k — porque um turno encadeia
  transferências e usos de tool; mas pedir mais saída do que o modelo aceita é
  400 em vários provedores, e aí o cliente fica sem resposta por causa de um
  número de configuração.
- **Mudou uma lista de valores (`EFFORTS`, enums de UI)? Migre as linhas
  existentes.** Um `<select>` controlado com valor sem opção correspondente
  exibe a primeira opção e **envia ela** — grava algo que ninguém escolheu.
  Ver `normalizarEffort` e a migration `normaliza_effort_legado`.
- **Nada de timestamp, UUID ou data dentro do system prompt.** Invalida o prompt
  cache a cada request e multiplica o custo. Contexto dinâmico entra como mensagem.
- **Todo agente recebe data/hora de São Paulo** em toda execução, como mensagem
  `system` imediatamente antes da mensagem do cliente (`mensagemDeContextoTemporal`
  em `src/lib/tempo.ts`). É a posição que preserva o cache — no início do prompt,
  a data mudaria o prefixo a cada requisição.
- **O container roda em UTC: toda data exibida precisa de `timeZone` explícito.**
  As telas são componentes de servidor, então `Intl` sem fuso pega o do
  container e mostra três horas adiantado. `formatarData` fixa `FUSO_SEAHUB`, e
  fixar também evita divergência de hidratação entre servidor e navegador.
  Vale para qualquer formatação nova de data — nada de `toLocaleString()` cru.
- **Autoria é obrigatória**: `criarAgente` grava `ownerId`, e toda alteração grava
  `updatedById`. As regras que impedem o painel de ficar sem proprietário estão
  isoladas e testadas em `src/server/usuarios/regras.ts`.
- **Página longa usa `<Abas>`** (`src/components/abas.tsx`). O conteúdo chega já
  renderizado do servidor e só é escondido/mostrado: trocar de aba não refaz
  requisição nem perde rascunho de formulário em outra aba. A aba vai para a URL
  por `history.replaceState` — **não** use `router.replace`, que reexecuta o
  componente de servidor e mata a troca instantânea. O playground fica **fora**
  das abas, para dar para testar enquanto se mexe em qualquer configuração.
- **O logo da Seahub só existe em branco.** No tema claro ele é invertido por CSS
  (`.logo-seahub`) em vez de manter dois arquivos.
- **Tools são ordenadas por nome** antes de ir para a API (`paraFerramentasAnthropic`).
  Reordenar invalida o cache do prefixo inteiro. Existe teste cobrindo isso.
- **Toggle de integração é de dois níveis** (`Integration.enabled` ∧
  `AgentIntegration.enabled` + allowlist). Integração desligada não aparece para o
  modelo — não existe tool que responde "desabilitado".
- **Credenciais nunca em texto plano.** `cifrar`/`decifrar` em `src/lib/crypto.ts`;
  a API devolve só o `hint`.
- Alterar prompt, modelo ou effort cria uma `AgentVersion`. Editar nome/descrição não.

### Comandos

```bash
npm run db:up       # Postgres (5434) + Redis (6380) locais
npm run db:migrate  # migration de desenvolvimento
npm run db:seed     # usuário inicial + linhas de integração
npm run dev
npm run typecheck && npm test && npm run build
```

Login de desenvolvimento: `admin@seahub.local` / `seahub123` (definido no seed).
