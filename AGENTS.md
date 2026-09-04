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
- **ERP Conexa:** a documentação chegou em 31/07/2026. A fonte é a coleção
  Postman em `docs/`, e a leitura humana dela está em
  **`docs/02-api-conexa.md`** (83 endpoints, extraídos). Fora do que está ali,
  continua valendo: não invente endpoint nem shape de payload.
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
- **Exceção única: mídia.** Transcrição de áudio e leitura de imagem/documento
  falam com a **OpenAI direta** (`src/server/integrations/openai/`), porque
  `/audio/transcriptions` não existe na OpenRouter. Mesmo SDK, outra `baseURL`,
  outra chave, outra fatura. A conversa continua 100% na OpenRouter — não use um
  cliente pelo outro.

### Regras da Casa: o bloco que o sistema injeta em todo prompt

Os agentes em produção derrapavam — respondiam em espanhol, opinavam fora do
escopo, confirmavam ao cliente o que a tool não tinha feito. O modelo não
obedece o que não está escrito, e reescrever o prompt de cada agente teria
sobrescrito o que alguém escolheu de propósito. Por isso as regras são
**injetadas** em `runner.ts`, do mesmo jeito que o roster:
`agente.systemPrompt + blocoDeConduta(...) + blocoDeRoster(...)`. Módulo puro
e testado em `src/server/agents/conduta.ts`.

- **Injetar é o que faz a regra valer para quem já existe.** Migration de
  `systemPrompt` seria exatamente o "sobrescrever quem escolheu outro valor de
  propósito" que a regra de `@default` proíbe. Prompt antigo que repita uma
  regra do bloco não quebra nada — só é cobrado duas vezes; quem apara isso é
  o operador ao abrir a tela, agente a agente, nunca um script em lote.
- ⚠ **O `PROMPT_BASE` REPETE as regras, e isso é decisão do usuário (31/08/2026).**
  Cheguei a removê-las de lá por serem redundantes; ele recusou três vezes, cada
  vez mais claro: *"as regras gerais devem aparecer dentro do prompt do agente,
  sem seção nova"*. O raciocínio é dele e é bom: o campo de prompt é onde ele lê
  e edita o agente, e regra que só existe injetada é regra que ele não vê nem
  controla. Exemplo completo ensina o que escrever; esqueleto ensina a deixar em
  branco.
  O custo está aceito: ~265 tokens a mais por mensagem (a parte de regras do
  exemplo). Quem quiser pagar uma vez só apaga do campo — o `blocoDeConduta`
  continua garantindo tudo, inclusive o que for apagado.
  ⚠ **Mexeu no bloco? Atualize o `PROMPT_BASE` no MESMO commit.** Foi o que não
  se fez em 24/08, e por um mês o exemplo prometeu regras noutra redação.
  `prompt-base.test.ts` exige que cada assunto do bloco tenha contraparte no
  exemplo — trava o ASSUNTO, não a palavra.
- **Vai entre o prompt do operador e o roster.** O bloco diz "as instruções
  acima": as regras de escopo e de fonte-de-verdade se definem POR EXCLUSÃO do
  que o operador escreveu, e antes dele "acima" não aponta para nada.
  ⚠ **Depois do roster seria pior**, não melhor: "as instruções acima" passaria
  a incluir a lista de colegas, autorizando o agente a tratar o assunto dos
  outros — que é o próprio sintoma de fuga de escopo.
- **Núcleo igual nas quatro origens, cauda por tipo de turno.** Veracidade
  (idioma, não inventar, data e hora do sistema, só afirmar o que aconteceu,
  escopo, parar na dúvida, não se deixar reprogramar) vale sempre — inclusive
  em nota interna, comentário do ClickUp e argumento de tool. Forma de conversa
  é outra história.
- ⚠ **O formato brasileiro da regra 1 NÃO vale dentro de campo de ferramenta**,
  e a frase que faz essa dobradiça é obrigatória. A regra manda escrever no
  padrão daqui e alcança "texto que você manda para outro sistema"; o cabeçalho
  declara que as Regras da Casa vencem em conflito. Junte os dois e o agente
  converte a data antes de preencher um campo que pede ISO — há pelo menos oito
  no catálogo (`vencimento` do ClickUp, datas do Conexa, coluna de data da
  planilha). O ClickUp faz `Date.parse` do que chega, recebe `NaN`, e a tarefa
  nasce **sem prazo**: sem erro e sem rastro. Achado por red team em 29/08/2026,
  já em produção, e travado por teste.
- **Sete regras em TRÊS grupos** (`== COMO VOCÊ ESCREVE ==`, `== O QUE VOCÊ
  PODE AFIRMAR ==`, `== ATÉ ONDE VOCÊ VAI ==`), e a divisão não é enfeite: sete
  regras em fila se leem como lista de avisos, agrupadas por PERGUNTA cada uma
  ganha um lugar e a que governa o caso fica achável no meio do prompt. O grupo
  do meio é o que combate o delírio, e é o maior de propósito.
- ⚠ **Regra que o código já garante NÃO entra no bloco.** O bot nunca resolve a
  conversa, o cliente nunca fica sem resposta (`garantirRespostaAoCliente`) e
  toda transferência avisa a pessoa (`aviso` é parâmetro obrigatório) — as três
  são impostas pelo worker. Repeti-las custaria token em toda mensagem para
  ensinar o que já não pode falhar. Aqui só entra o que depende de o modelo
  escolher fazer.
- ⚠ **"No máximo três parágrafos" e "na dúvida, passe para uma pessoa" são
  FALSOS em gatilho e agendamento.** Não há cliente, não há canal de resposta,
  e toda tool de transferência exige conversa existente. Regra falsa é pior
  que regra ausente: ela ensina o modelo a ler o bloco inteiro como
  decorativo. Por isso `tipoDeTurno` — e `switch` sem `default`, para origem
  nova quebrar o typecheck em vez de cair num padrão silencioso.
- **PLAYGROUND recebe a cauda de conversa, apesar de não ter conversa.** Ele
  existe para prever a produção; playground com prompt diferente do de
  produção deixa de ser teste, e o operador afinaria o tom contra um
  comportamento que não existe.
- **A cauda sem conversa diz PARA QUEM escrever.** `agenda/mensagem.ts` e
  `gatilho/payload.ts` já dizem ao modelo que a resposta "não vai para
  ninguém", o que sozinho é convite a não escrever nada de útil. A cauda
  aponta o registro em Execuções, lido pela equipe, sem contradizer aquele
  preâmbulo.
- ⚠ **Fora do Chatwoot, a tarefa NÃO está no system prompt.** A instrução do
  agendamento (`AgentSchedule.instrucao`) e o payload do gatilho chegam como
  mensagem do turno, e a regra de escopo do núcleo fala de "instruções acima"
  — sozinha, ela autoriza o agente a responder que "isso não é comigo" para o
  próprio agendamento. Pior desfecho possível: o worker encerra como
  `executado`, não conta como `falhou`, não desliga nada, e o agendamento fica
  inútil todo dia sem erro nenhum. Por isso a cauda sem conversa abre dizendo
  que a tarefa está na mensagem e é para ser cumprida.
- ⚠ **Texto não é prova de ação — nem o do próprio agente.** O histórico que o
  modelo recebe é texto puro (`chatwoot/historico.ts`): nenhuma `ToolCall`
  anterior chega até ele. Até 29/08/2026 a regra abria uma exceção para isso —
  podia afirmar quando "a própria conversa acima já registrar que foi feito
  antes" —, e a exceção aceitava como prova exatamente o que não é: o "pronto,
  já reservei" que o agente escreveu no turno anterior **sem ter reservado**.
  A alucinação virava a evidência dela mesma e era repetida com convicção
  crescente; o cliente afirmando "vocês já cancelaram" tinha o mesmo efeito.
  A doutrina sobrevive pela SAÍDA, não pela exceção: sem prova de um lado nem
  do outro, o agente **não afirma e não nega**. É isso que continua impedindo
  de negar no turno 2 o que foi feito no turno 1 — e continua proibido repetir
  uma tool de escrita só para confirmar, que duplicaria reserva em sistema de
  terceiro.
- **A linha de encaminhamento é condicionada ao que o turno tem**
  (`handoffEnabled` ∧ `transferir_para_humano` resolvida ∧ ferramentas indo no
  request — `podeEncaminharParaHumano`). Prometer transferência inexistente é
  o sintoma de origem: o agente anuncia "vou te passar" e não passa, queimando
  uma iteração com `Tool "X" não está disponível para este agente.`
  ⚠ **Modelo sem suporte a tools entra nessa conta**: o runner zera o envio de
  ferramentas e deixa a allowlist intacta no banco, então as duas primeiras
  condições continuam verdadeiras com zero ferramentas na requisição.
- **O bloco não cita o nome de tool nenhuma**, e tem teste para isso. Quando e
  como usar a tool já está na descrição dela, que é onde o modelo lê; repetir
  no prompt de todo agente é pagar duas vezes e arriscar mentir para quem tem
  allowlist restrita. ⚠ O `blocoDeRoster` **ainda** faz isso — cita
  `transferir_para_agente` nas quatro origens, sem conferir se a tool foi
  resolvida. É defeito preexistente, não exemplo a seguir; `resolvidas` está
  a duas linhas dali quando alguém for consertar.
- **Custa ~1.190 tokens no atendimento** (~925 do núcleo, ~265 da cauda) e
  ~1.125 em gatilho/agendamento, pela régua de `tokensAproximadosDaTool` —
  cerca de 29% do que pesam as 32 tools ligadas, tudo no prefixo cacheável. A
  tela mostra o número, pelo mesmo motivo que a tela de integrações mostra o
  custo de cada tool, e o teste trava um teto por variante para a próxima
  pessoa pensar antes de acrescentar parágrafo.
  ⚠ **Subiu de ~840 para ~1.190 na revisão de 29/08/2026**, e o teto do teste
  de 900 para 1250. Foram +300 tokens em toda mensagem de todo agente para
  comprar três coisas que o bloco não dizia: de onde vem a data, que o que o
  modelo sabe do mundo não vale como fato da Seahub, e que na dúvida se para.
  Um turno que inventa preço custa mais do que isso — mas a conta tem de ser
  refeita a cada regra nova, e o caminho barato é sempre tirar redundância
  antes de acrescentar parágrafo (foi assim que a linha de "na dúvida" saiu da
  cauda de gatilho e virou regra do núcleo).
- **Três prefixos de cache por agente** (conversa · conversa sem
  encaminhamento · sem conversa). Não custa no caminho quente: origem e tools
  são constantes ao longo de uma conversa, e só o Chatwoot é multi-turno de
  volume. O que custaria é conteúdo variável por requisição, e o módulo é puro
  justamente para isso ser impossível.
- ⚠ **Mudar o bloco muda TODOS os agentes de uma vez e NÃO cria
  `AgentVersion`.** `actions/agents.ts` só versiona quando `systemPrompt`,
  `model` ou `effort` do agente mudam; a apuração por versão continuará
  atribuindo à versão antiga. O rastro é o git e a transcrição em Execuções.
  Edite com a mesma cerimônia de uma migration.
- **O operador precisa VER o que é injetado.** O roster está no prompt de todo
  mundo há meses e ninguém nunca o viu — é assim que se escreve um prompt que
  contradiz uma regra invisível. O bloco aparece na tela do agente, logo abaixo
  do campo, com o texto exato que o runner concatena — inclusive a variante
  certa da linha de encaminhamento, calculada pela **mesma** função. Mostrar
  ao operador uma linha que aquele agente não recebe reabriria a divergência
  que o módulo existe para fechar.

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
- **`active` é o buraco que sobrou desse conserto**, e some pelo Redis. Não dá
  para remover o job que está rodando, então a mensagem que chega durante o
  turno deixa um recado (`atendimento:pendente:<id>`) e o worker o consome no
  evento **`completed`** — de dentro do handler não adianta, o job ainda está
  `active`. Sem isso a mensagem sumia de vez: o agente responde ao turno
  anterior, zera `aguardandoDesde`, e o vigia para de vigiar justamente a
  mensagem que ninguém leu. `consumirPendente` lê e apaga numa operação só,
  porque a concorrência é 4.
- **Retry só vale para turno que não falou com o cliente.** O BullMQ reexecuta o
  turno **inteiro**, e ele não é idempotente: o modelo roda de novo, o cliente
  recebe a mesma resposta (ou o mesmo "vou te passar") de novo, e a OpenRouter
  cobra de novo. Falha depois do envio é registrada em `ultimaFalha` e **não**
  relançada — `EstadoDoTurno.clienteRecebeuResposta` é quem decide.
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

### Leitura de mídia: áudio, imagem e documento viram contexto

O cliente que manda áudio em vez de digitar era **silêncio**: `content` vazio, o
webhook recusava com "mensagem sem texto (anexo?)", nenhum job era criado e nada
ficava registrado. Agora o anexo vira texto **antes** de o agente pensar.

Módulo em `src/server/integrations/openai/`.

- **É a OpenAI direta, não a OpenRouter — e isso não contradiz a decisão de
  2026-07-28.** A conversa continua inteira na OpenRouter; aqui é só mídia,
  porque `/audio/transcriptions` não existe lá. Mesmo SDK (`openai`, já era
  dependência), duas `baseURL`. Trocar um cliente pelo outro é erro silencioso.
- **Passo de preparo, não tool.** Zero tools no registry, de propósito: o agente
  não escolhe se vai ouvir o cliente. Sistema garante, prompt decora.
- **Está no registry mesmo sem tool** porque precisa exatamente do que o registry
  já resolve — credencial cifrada, toggle global, toggle por agente, um lugar
  conhecido no painel. Tabela paralela seria capacidade duplicada.
- **Quem decide é a PORTA**, não quem pensa. O webhook precisa decidir se agenda
  uma mensagem só-com-anexo e lá ainda não se sabe quem vai pensar; e a
  transcrição é da CONVERSA — o colega que assume por transferência lê a mesma,
  sem precisar ter nada ligado. Porta e pensador discordando viraria mensagem
  agendada e nunca respondida.
- **Desligada, o comportamento é exatamente o de antes**: mensagem só com anexo
  não vira atendimento. A diferença é que agora fica escrito por quê em Entregas
  recebidas, em vez de silêncio. Estava em produção quando isto foi escrito —
  ligar é decisão consciente, agente a agente.
- **O cache não é otimização, é o que segura a conta.** O worker relê o histórico
  INTEIRO do Chatwoot a cada turno: sem `MediaAnalysis`, o mesmo áudio seria
  transcrito de novo a cada mensagem seguinte, e o gasto cresceria com o tamanho
  da conversa em vez de com a quantidade de mídia. A chave identifica o
  **arquivo** (`chatwoot:<id>`, ou hash da URL **sem a query** — assinatura de
  ActiveStorage expira e mudaria a chave do mesmo arquivo).
- **`OK` e `SKIPPED` são definitivos; só `ERROR` volta.** E com teto de 3
  tentativas, senão um arquivo corrompido seria reprocessado — e cobrado — a
  cada turno para sempre. Arquivo grande demais e 4xx nem chegam a ser `ERROR`.
- **Tipo desligado na configuração NÃO vai para o cache.** Religar tem de voltar
  a ler sem ninguém precisar limpar tabela.
- **Falha de leitura vira texto, nunca silêncio.** `[áudio transcrito — a.ogg]`,
  `[anexo não lido — v.mp4] o cliente enviou um vídeo…`. O colchete é o que
  separa "o cliente escreveu" de "o sistema leu para você" — sem ele o modelo
  responde "conforme você escreveu" sobre algo que foi falado.
- **Só anexo de ENTRADA é lido.** Descrever o PDF que nós mesmos mandamos é
  pagar para ler o que já sabemos.
- **Vídeo, localização e contato viram texto sem chamar modelo nenhum** — "o
  cliente enviou uma localização (-23.5, -46.6)" é contexto, não é nada. E
  `.txt`/`.csv` são lidos direto, sem modelo e sem custo.
- **O token do Chatwoot só vai para a origem do Chatwoot.** O `data_url` vem de
  dentro de um payload; mandar a credencial de atendimento para um host
  arbitrário porque ele apareceu num JSON é vazamento. O arquivo sobe para a
  OpenAI como data URI, e não como link — a instância pode ser privada.
- **O download é lido em pedaços com teto**, e não `arrayBuffer()` direto: o
  `content-length` é opcional, e um arquivo enorme derrubaria o worker, que
  atende 4 conversas ao mesmo tempo.
- **O custo NÃO aparece em `/consumo`.** A OpenAI não devolve custo por
  requisição — inventar estimativa quebraria a única coisa que aquela tela
  promete (conferir contra a fatura). Ficam gravados tokens e segundos de áudio,
  e a tela diz em letras claras que a mídia é fatura separada.
- **Formato é lista fechada** (`classificar.ts`): mandar `.heic` para a visão ou
  `.amr` para a transcrição é 400 **pago**. Melhor recusar de graça e dizer ao
  agente o que chegou. `mp4`/`webm` são de áudio E de vídeo — o ramo do vídeo vem
  primeiro, senão mandaríamos 40 MB para transcrever.
- **O seletor de modelo vem da conta ao vivo** (`catalogo.ts`, cache de 1h como
  o da OpenRouter, esvaziado ao trocar a chave). A diferença para o catálogo da
  OpenRouter é o que a API **não** diz: `GET /models` devolve só
  `{ id, created, owned_by }` — nada sobre enxergar imagem ou transcrever. Por
  isso o agrupamento é **palpite declarado**, feito por **exclusão** (fora
  embedding, TTS, geração de imagem, moderação, realtime, legado), e **nunca
  esconde**: o que não reconhecemos cai em "outros modelos da conta", senão
  usar um lançamento novo exigiria deploy. `*-audio-preview` fica fora dos
  prováveis de propósito — parece de áudio pelo nome, mas é chat, e
  `/audio/transcriptions` o recusa.
- **`comSelecionado` não é detalhe de UI.** É a trava do defeito já documentado
  neste arquivo: `<select>` com valor sem opção correspondente exibe a primeira
  e **envia ela**. Bastaria a chave perder acesso a um modelo para o painel
  trocar o modelo de todo mundo em silêncio, na primeira vez que alguém
  salvasse a tela. Sem lista (chave restrita, 403), o campo **cai para texto
  livre** em vez de virar um seletor vazio que impediria de configurar.

### Gatilho HTTP: aciona um agente sem Chatwoot nenhum

Um agente também pode ser acionado direto por POST de um sistema externo
(ClickUp, n8n, `curl`) — `/api/webhooks/gatilho/<agentId>/<token>`. Sem
conversa, sem cliente, sem canal de resposta: o agente só age pelas tools que
tiver ligadas, e o payload vira a `mensagem` do turno (`RunSource.TRIGGER`).

- **O token vai no PATH, não em header.** Pesquisado antes de escrever: a API
  de webhook do ClickUp não permite anexar cabeçalho nenhum ao registrar — só a
  URL é configurável. Header custom não é universal por definição; path é.
- **Aqui o segredo nasce do NOSSO lado**, ao contrário de toda outra credencial
  do projeto (que o operador cola de um sistema que já existe). Por isso é
  cifrado como sempre, mas devolvido em texto puro **uma única vez**, na
  criação/rotação — mesmo padrão de qualquer chave de API (Stripe, GitHub).
- **Nasce desligado**, mesma doutrina de `Agent.active`/`Integration.enabled`.
  Gerar o token não liga sozinho.
- **Responde `200` para quase tudo**, inclusive gatilho desligado, cooldown ou
  teto estourado — só `401`/`404` são erro de protocolo de verdade. A maioria
  dos sistemas de webhook trata não-2xx como falha e reage agressivamente
  (reenvio, ou desativa o webhook do lado dele); manter `200` deixa a decisão
  inteiramente do nosso lado.
- **Trava anti-loop, porque o risco é real**: o agente reage a um evento
  mudando o mesmo recurso que disparou o evento, o sistema externo chama de
  volta, e vira laço queimando crédito da OpenRouter sem ninguém perceber.
  Cooldown de 20s por `recursoChave` (extraída do payload — `task_id` e
  afins) pega a causa raiz; um teto de execuções por janela é a rede de
  segurança e **desliga o gatilho sozinho** quando estoura, deixando rastro em
  `AgentTrigger.pausadoAutomaticamenteMotivo` — silêncio precisa deixar rastro
  vale aqui também.
- **Retry só para falha ANTES de qualquer tool.** Mesmo bug já corrigido para o
  atendimento do Chatwoot nesta sessão, reaplicado de propósito: o BullMQ
  reexecuta o job inteiro, e uma tool que já rodou pode ter mudado algo de
  verdade num sistema externo. `runner.ts` anota `runId` no erro antes de
  relançar; o worker do gatilho confere se alguma `ToolCall` já foi persistida
  para decidir se é seguro deixar o BullMQ tentar de novo.
- **Fila e worker próprios** (`FILA_GATILHO`), mas no MESMO processo do worker
  de atendimento — `iniciarWorker()` sobe os dois. Zero serviço novo de deploy.

### Conferência de documento: o que dá e o que NÃO dá para provar

Provedor `DOCUMENTOS`, sem credencial — algoritmo público e uma consulta
gratuita. O agente confere o documento que o cliente mandou no WhatsApp e grava
o resultado no cadastro.

- ⚠ **Nada disto detecta falsificação.** Prova que um número é bem formado e,
  no CNPJ, que a empresa existe e está ativa. Não prova autenticidade nem que o
  documento é de quem mandou. As descrições das tools dizem isso ao modelo de
  propósito: é ele quem escreve a conclusão que uma pessoa vai ler, e "CPF
  válido" soa como muito mais do que é.
- **Não existe consulta oficial gratuita de CPF nem de CNH.** A da Receita é
  página com captcha; a do Serpro é paga. Sobra o dígito verificador. Só o
  **CNPJ** tem base pública utilizável (BrasilAPI, sobre os dados abertos).
  **RG não tem nada** — não há base nacional, cada estado tem formato próprio.
- **Dígito verificador é tool, nunca prompt.** Modelo erra conta, e erra para os
  dois lados: recusa documento bom e aceita número inventado.
- ⚠ **O algoritmo da CNH tem variantes circulando**, e elas divergem quando o
  primeiro dígito estoura. Por isso a mensagem de recusa manda **conferir à
  mão** em vez de declarar o documento inválido — recusar uma CNH boa é pior que
  mandar conferir uma suspeita. Os testes de CPF e CNPJ usam números reais e
  públicos, não gerados pelo próprio algoritmo (senão a verificação seria
  circular); a CNH não tem referência assim, e isso está registrado no teste.
- **Falha da consulta pública nunca vira "não existe".** Só `404` autoriza dizer
  não encontrado; timeout, 5xx e queda de rede viram `indeterminado`. A
  BrasilAPI é projeto comunitário, sem compromisso de disponibilidade —
  concluir inexistência a partir de um problema nosso recusaria um cliente.

**Onde o resultado é gravado:** atributo personalizado do **CONTATO**, não da
conversa (`anotar_no_contato`). A conversa é resolvida e some da vista; a pessoa
permanece, e no atendimento seguinte a informação ainda está lá. Campo separado
porque campo dá para **filtrar** ("quem está com documento vencido"), coisa que
nota não permite. A explicação do que bateu e do que divergiu vai junto em
`registrar_nota_interna` — campo para a máquina, nota para o humano.

⚠ **`custom_attributes` do Chatwoot SUBSTITUI o objeto inteiro.** Mandar um
atributo apagaria todos os outros — mesma armadilha dos labels, mesma solução:
ler, mesclar, escrever. Vale o GET a mais, porque o que se perderia são dados
que outra equipe pode ter cadastrado.

### Gatilho por horário: o agente roda sozinho

Terceiro jeito de acionar um agente, ao lado da mensagem do Chatwoot e do
gatilho HTTP. `AgentSchedule`, vários por agente — "resumo às 8h" e "cobranças
às 18h" são dois agendamentos do mesmo agente, cada um ligando e desligando por
conta própria.

- ⚠ **O agendamento NÃO fala no WhatsApp.** Ele age só pelas tools ligadas.
  Toda tool de Chatwoot exige uma conversa existente, e quem envia mensagem no
  atendimento é o worker, não uma tool. "Às 9h manda cobrança para os
  inadimplentes" **não funciona** — precisaria de uma tool que inicia conversa,
  que não existe. A tela diz isso em letras claras, porque é a expectativa que
  mais naturalmente se cria.
- **O relógio é o Job Scheduler do BullMQ** (`upsertJobScheduler`), não um
  `setInterval` no worker: duas réplicas não disparam em dobro, sobrevive a
  reinício, e dá para perguntar quando é a próxima.
- ⚠ **`tz: FUSO_SEAHUB` é obrigatório e não tem padrão seguro.** O container
  roda em UTC: `0 9 * * *` sem fuso dispara às 6h da manhã em São Paulo. Três
  horas errado, todo dia, sem erro nenhum — a mesma armadilha das datas
  exibidas, e pior, porque data errada alguém nota e execução na hora errada
  não. Por isso a tela **mostra as próximas execuções** antes de salvar.
- **Postgres manda, Redis executa.** O relógio vive no Redis, mas Redis limpo
  apagaria todos os agendamentos em silêncio — a tela continuaria dizendo
  "ligado" e nada dispararia nunca. `reconciliarAgendadores()` roda a cada boot
  do worker e refaz o Redis a partir do banco, nos dois sentidos (cria o que
  falta, remove órfão).
- **Cinco campos, nunca seis.** O cron-parser aceita segundos, e isso seria uma
  porta lateral para furar o piso de frequência.
- **Piso de `INTERVALO_MINIMO_MINUTOS`**, medido pelo MENOR intervalo entre
  ocorrências e não pela média: uma expressão que dispara de minuto em minuto
  durante uma hora tem média mansa e é justo o que o piso existe para pegar.
- ⚠ **`prev()` devolve a ocorrência ESTRITAMENTE anterior.** Chegando pontual
  no segundo marcado, o atraso calculado seria de 24h e o agendamento diário
  seria descartado **todo dia**. Por isso `ocorrenciaAnterior` consulta a partir
  de `agora + 1s`.
- **Atraso é medido pelo cron, não pelo relógio do job.** Worker fora do ar na
  hora marcada faz o BullMQ entregar a ocorrência quando volta, e nada no job
  diz que ele chegou tarde. Passou de `toleranciaMinutos`, pula e registra —
  rodar "o resumo das 8h" às 15h é pior que não rodar.
- **Trava de sobreposição no Redis** (`SET NX`): agendamento curto com turno
  longo empilharia execuções. Falha de Redis libera em vez de barrar — o pior
  caso vira sobreposição, e recusar por soluço seria agendamento que não roda.
- **A ocorrência entra na chave de idempotência** (`<scheduleId>:<ISO>`), então
  reentrega do BullMQ não custa uma execução paga.
- **`pulado` e `interrompido` não contam como falha.** Pular por atraso é o
  sistema funcionando e parar é decisão de alguém; contá-los desligaria por
  engano um agendamento são. Só `falhou` conta, e ao bater
  `FALHAS_ATE_DESLIGAR` o agendamento se desliga **e sai do relógio** — só
  desligar no banco continuaria disparando até o próximo boot.

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

### Assinatura eletrônica: dois caminhos

Conexa (D4Sign por dentro) e **ZapSign**. A ClickSign foi **cancelada em
03/08/2026** e o cliente que existia saiu do repositório — se voltar, está no
histórico do git; não a reintroduza sem pedido.

Qual usar: o Conexa assina o **contrato do ERP**, já vinculado a plano e
cliente. A ZapSign assina **qualquer documento**, a partir de modelo DOCX. Um
agente que tenha as duas ligadas precisa de prompt dizendo qual — não deixe o
modelo escolher fornecedor.

- **A barra final da ZapSign não é decorativa.** É Django REST: `/docs` sem
  barra vira redirect e o corpo do POST se perde. Toda rota termina em `/`.
- **Modelo tem dois prefixos na ZapSign.** Listar e detalhar é `/templates/`;
  criar documento a partir de um é `/models/create-doc/`. Mesmo conceito, dois
  caminhos — trocar um pelo outro dá 404 sem explicação.
- **`inputs[].variable` vem com as chaves** (`{{NOME COMPLETO}}`) e é isso que
  vai em `data[].de`. Por isso `zapsign_ver_modelo` existe: sem ela o agente
  adivinharia o nome da variável.
- **Criar por modelo aceita UM signatário no corpo.** Os demais entram por
  `add-signer`, um por chamada — `zapsign_gerar_contrato` faz isso por dentro,
  senão o agente pararia com contrato criado e metade dos signatários faltando.
- **Cancelar é `POST /refuse/` com o token no CORPO**, não na rota. O documento
  não some: fica com marca d'água. Excluir (`DELETE /docs/{token}/`) existe e
  ficou fora do catálogo de propósito.
- **O status do signatário muda de vocabulário por endpoint** — `signed` no
  detalhe, `assinou` na listagem. Comparar sem normalizar conclui que ninguém
  assinou; usar `normalizarStatusDeSignatario`.
- **URL de arquivo da ZapSign expira em 60 min** e a listagem tem cache de 60 s
  (documento recém-criado não aparece nela — use `detalhar`).
- **WhatsApp automático nasce desligado**: a ZapSign cobra por envio.
- **README de MCP não é fonte de rota.** O MCP oficial da ZapSign lista
  `GET /documents`; a API real é `GET /api/v1/docs/`.

### Google Workspace: Sheets, Docs e Drive por uma conta de serviço

O agente lê e escreve planilha, lê e gera documento, e lista pasta. O caso que
motivou tudo: o cliente manda um PDF no WhatsApp, a leitura de mídia transforma
em texto, e o agente grava uma linha na planilha de controle.

- **Um provider, não três.** `IntegrationCredential` é 1:1 com `Integration`, e a
  credencial aqui é uma só — a chave da conta de serviço. Três providers
  (SHEETS/DOCS/DRIVE) obrigariam a colar o mesmo JSON três vezes e a rotacioná-lo
  em três lugares; na primeira rotação alguém esquece um, e a integração
  esquecida passa a falhar sozinha enquanto as outras duas funcionam. Além disso,
  gerar documento de modelo atravessa Drive e Docs **na mesma tool**, e ela
  ficaria partida entre dois toggles. Quem separa Sheets de Docs para o operador
  é `categoria` e a allowlist — onde a separação custa zero.
- **Conta de serviço, e não OAuth de um usuário.** `resolve.ts` só **decifra**:
  não existe caminho de escrita de credencial a partir do runner, e um
  `refresh_token` precisaria de um. Pior: ele morre por três caminhos silenciosos
  (revogação, seis meses sem uso, teto de tokens por conta) e some junto com a
  pessoa que autorizou, no dia em que ela sai da empresa.
- **JWT assinado com `node:crypto`, sem SDK.** `googleapis` traz centenas de
  módulos para o que cabe em cem linhas, e o worker é um bundle esbuild com lista
  explícita de externals — dependência nova ali é risco que só aparece em
  produção. Mesmo motivo de ClickUp, Conexa e ZapSign serem clientes escritos à
  mão.
- ⚠ **`aud` é a constante `URL_DO_TOKEN`, nunca o `token_uri` do JSON.** O
  arquivo traz o endereço antigo (`accounts.google.com/o/oauth2/token`); o fluxo
  JWT exige `oauth2.googleapis.com/token`.
- ⚠ **O cache do access token é chaveado por `(client_email, escopos,
  personificar)`.** Chavear só pela conta devolveria o token de OUTRO usuário
  quando a personificação estivesse em uso — e o sintoma seria "o agente escreveu
  na planilha errada". Tem dedupe de voo único porque a concorrência do worker é
  4: sem ele, quatro conversas simultâneas fazem quatro assinaturas RSA e jogam
  três fora.
- ⚠ **`invalid_grant` tem três causas e a mensagem do Google não distingue
  nenhuma**: JSON de outro projeto, relógio do container fora de hora (o
  assertion vale no máximo 1h e o Google confere), ou quebras de linha destruídas
  na `private_key`. A tradução em `auth.ts` cita as três, em ordem de
  probabilidade — sem ela o operador rotaciona uma credencial que está boa.

#### O cadastro por nome é a allowlist de arquivos

Planilhas, documentos, modelos e pastas entram na config como `nome = id`, e o
modelo **nunca vê um id**.

- **Não é conveniência, é contenção.** `resolverCadastro` **recusa id cru** — ao
  contrário do `resolverModelo` da ZapSign, que aceita o que "parece uuid". Lá o
  token tem forma reconhecível; aqui o id do Google é uma string opaca qualquer,
  e aceitar o que parece id deixaria o agente escrever em qualquer planilha que a
  conta enxergasse, inclusive numa que ele alucinou. Allowlist com porta lateral
  não é allowlist.
- **Nome desconhecido devolve os nomes que existem**, e nunca lança: o modelo se
  corrige no mesmo turno, em vez de queimar o turno inteiro. ⚠ **Lista vazia é
  outra conversa**: "use um dos nomes abaixo" seguido de nada manda o agente
  chutar, receber a mesma frase e chutar de novo até o teto de iterações — e é o
  estado mais comum de todos, a integração ligada no primeiro dia. Nesse caso o
  retorno diz que **falta configuração** e que não há como contornar.
- **Leitura longa devolve `proximaLinha`.** "Peça uma faixa menor" levava o
  agente a reler o COMEÇO com outro tamanho, receber `truncado: false` e
  concluir que percorreu a planilha inteira — respondendo ao cliente que não há
  registro em nome dele com o registro na linha 640. O campo `total` virou
  `linhasDevolvidas` pelo mesmo motivo: o nome antigo sugeria o total da aba.
- ⚠ **A config nunca chega ao prompt.** `ToolDefinition.description` é string
  estática, montada no carregamento do módulo — o cadastro não aparece lá. Por
  isso `google_sheets_ver_estrutura` **sem parâmetro nenhum** lista as planilhas
  disponíveis: é a porta de descoberta, e ela não custa chamada HTTP. Ainda
  assim, o `systemPrompt` do agente é o lugar certo para dizer em qual planilha
  ele grava.

#### Escrever numa planilha que já existe é diferente de criar arquivo

⚠ **A conta de serviço tem quota de armazenamento ZERO e não pode ser dona de
arquivo nenhum.** Não é quota pequena, e não há tela para aumentar.

- **Mas isso só morde em criar, copiar e subir.** Escrever numa planilha que já
  existe não muda o dono e não toca quota. É o que faz o caso de uso principal
  funcionar sem Workspace pago, sem Drive compartilhado e sem Admin console:
  basta compartilhar a planilha com o e-mail da conta de serviço, como Editor.
- **Pôr a pasta de destino em `parents` NÃO transfere a propriedade.** Quem cria
  é o dono, e quem cria é a conta de serviço — mesmo `403 storageQuotaExceeded`.
  Só um Drive compartilhado resolve, e por isso `google_docs_criar_de_modelo`
  recusa **antes de gastar chamada** quando `driveCompartilhadoId` está vazio:
  deixar o 403 cru chegar ao modelo não diz a ninguém o que precisa ser feito.
- ⚠ **`spreadsheets.create` e `documents.create` não aceitam `parents`** e criam
  na raiz do My Drive do chamador — que, para a conta de serviço, é o nada. E
  `documents.create` **ignora o conteúdo enviado, em silêncio**. Criar arquivo é
  sempre pelo Drive (`files.copy`), nunca pela API do produto.
- ⚠ **O e-mail da conta termina em `gserviceaccount.com`, que é domínio
  externo**, e o Google não permite cadastrá-lo como domínio confiável. Se o
  Admin do Workspace restringiu compartilhamento, não há como compartilhar nada
  com ela e o único caminho é `personificar` (domain-wide delegation). O campo
  existe, nasce vazio, e não é o caminho padrão.
- ⚠ **`drive.file` não serve.** "Arquivos que o app abriu" significa Google
  Picker, no navegador; um worker headless nunca abre nada, e a planilha
  compartilhada por e-mail fica invisível com `403 appNotAuthorizedToFile`.
  Escolher o escopo restrito "por segurança" produz um agente que não enxerga
  nada. Quem restringe é o compartilhamento.

#### Sheets: os dois parâmetros que apagam dados em silêncio

- ⚠⚠ **`insertDataOption: "INSERT_ROWS"`, sempre explícito.** A referência da API
  documenta os dois valores e **não documenta qual é o padrão**. Com `OVERWRITE`,
  uma aba que tenha qualquer coisa abaixo da tabela — linha de totais, rodapé,
  segunda tabela — é gravada por cima, e a resposta volta `200` com
  `updatedCells` correto. Perda de dados silenciosa, sem desfazer. Tem teste.
- ⚠ **`valueInputOption: "RAW"`, sempre.** `USER_ENTERED` interpreta como se
  alguém tivesse digitado: `01234567890` vira o número `1234567890` e o zero do
  CPF some; `28/08/2026` é lido conforme o `locale` da planilha, que um humano
  pode mudar; e um valor começando com `=` vira **fórmula** — texto de cliente
  executando fórmula em planilha corporativa é exfiltração. A formatação visual
  (R$, dd/mm/aaaa) é atributo da coluna, definido uma vez.
- ⚠ **O `range` do append não é o destino** — é "onde procurar a tabela", e a
  escrita começa na primeira coluna da tabela **detectada**, não na coluna A.
  Mandar a aba inteira fazia uma planilha cujo cabeçalho comece em `B1` (coluna
  A deixada vazia por estética) sair com a linha deslocada uma casa, e o último
  valor caindo fora do cabeçalho — com `200` e `gravado: true`. Por isso a faixa
  é ancorada em `A:<última coluna do cabeçalho>`, e o retorno **confere** que o
  `updates.updatedRange` começa em A antes de afirmar que gravou. Quem diz onde
  caiu é sempre a resposta do Google, nunca a suposição de quem chamou.
- ⚠ **Falha depois do envio não é "não gravou".** Um `5xx`, um timeout de 30 s ou
  uma queda de rede não dizem se a linha entrou, e o runner entrega a exceção ao
  modelo como resultado de tool comum — o que o ensina a corrigir e chamar de
  novo. Duas linhas da mesma pessoa, e o `atualizar_linha` do atendimento
  seguinte recusando alterar qualquer uma por achar duas ocorrências: o cadastro
  trava até alguém abrir a planilha à mão. As tools de escrita devolvem
  `resultado: "indeterminado"` mandando **conferir antes de tentar de novo**.
  `4xx` (inclusive `429`) continua sendo relançado: é recusa antes de aplicar.
- ⚠ **`UNFORMATTED_VALUE` sozinho transforma toda data num inteiro de cinco
  dígitos**, porque `dateTimeRenderOption` fica no padrão `SERIAL_NUMBER`. Os
  dois andam juntos: `UNFORMATTED_VALUE` + `FORMATTED_STRING`.
- ⚠ **`values` some da resposta quando a faixa está vazia** — não vem `[]`, vem
  ausente. E "empty trailing rows and columns will not be included": as linhas
  chegam com comprimentos diferentes, e `linha[4]` é `undefined`, não `""`. É o
  que `normalizarLinhas` conserta.
- **Não existe busca na Sheets API.** `procurar_linha` lê a coluna com
  `majorDimension=COLUMNS` e compara aqui — com `ROWS` chegariam mil arrays de um
  elemento.
- **Não existe concorrência otimista nem idempotência**: sem ETag, sem
  `If-Match`, sem chave de requisição. Por isso a política de retry do cliente é
  assimétrica: leitura repete em `429` e `5xx`; **escrita repete só em `429`**,
  que é recusa definitiva. Um `5xx` numa escrita é ambíguo — pode ter sido
  aplicada antes de o erro voltar —, e repetir gravaria a linha duas vezes.

#### Coluna errada aborta a gravação inteira

`casarComCabecalho` devolve `ok: false` e **nada é escrito** quando o agente
informa uma coluna que não existe no cabeçalho.

- **É a lição de `clickup/campos.ts`, e aqui vale mais.** Lá dá para editar a
  tarefa depois; aqui não existe desfazer e não há tool de exclusão. Gravar a
  linha faltando o CPF e devolver `gravado: true` faria o agente confirmar ao
  cliente um registro incompleto — e a Regra 3 manda ele confirmar, justamente
  porque a ferramenta devolveu sucesso.
- **O retorno traz o `cabecalhoReal`**, para o modelo se corrigir no mesmo turno.
- **Coluna do cabeçalho que o agente NÃO informou fica em branco, sem
  reclamar.** Ninguém preenche todas as colunas a cada linha.
- **Coluna informada duas vezes também aborta**, nos dois caminhos de escrita.
  "Última vence" gravaria um valor que o agente não escolheu conscientemente.
- ⚠ **Cabeçalho com duas colunas de nome equivalente aborta a LEITURA também.**
  `"CPF"` na coluna B e `"CPF "` (com um espaço no fim, invisível na tela) na D
  é o caso real: a escrita resolvia para B, e a leitura — que monta o registro
  por nome de coluna — deixava a chave `CPF` ser reatribuída pela D, vazia. O
  agente lia "falta o CPF", mandava atualizar, e a atualização sobrescrevia o
  CPF correto. `atualizado: true`, e a leitura seguinte continuava mostrando
  vazio. Leitura e escrita discordando sobre a mesma coluna é o pior estado
  possível numa planilha sem desfazer, então as duas recusam — e o retorno manda
  escalar, porque nenhuma reformulação do pedido resolve.

#### Atualizar localiza pela chave de negócio, nunca pelo número da linha

`google_sheets_atualizar_linha` recebe `colunaChave` + `valorChave` e acha a linha
por dentro, recusando com zero ou mais de uma ocorrência.

⚠ **Aceitar o número da linha do modelo seria a pior falha desta integração.** O
histórico que o modelo recebe é texto puro — nenhuma `ToolCall` anterior chega até
ele —, então num turno seguinte ele só poderia **chutar** o número. E um humano
que insira ou remova uma linha entre a busca e a escrita desloca tudo. Nos dois
casos o resultado é sobrescrever o registro de outra pessoa, com `200` de resposta
e ninguém sabendo.

E a escrita é **célula a célula** (`values:batchUpdate`), nunca um `values.update`
da linha inteira — que apagaria todas as colunas não informadas.

#### Docs: índice nenhum, e conferir antes de copiar

- ⚠ **Os índices do Docs são UTF-16 e cascateiam**: toda inserção desloca os
  maiores, e um índice calculado antes da requisição já está errado quando ela
  chega. O módulo evita o problema **por construção** — só `replaceAllText` (que
  não usa índice) e `endOfSegmentLocation` (que o Google resolve). Se algum dia
  entrar `insertText` com `index`, a regra é aplicar de trás para frente.
- ⚠ **`endOfSegmentLocation` sem `tabId` escreve na PRIMEIRA aba, não no fim do
  documento.** Só `replaceAllText`, `deleteNamedRange` e
  `replaceNamedRangeContent` valem para todas as abas quando o `tabId` é
  omitido; `insertText` não está nessa lista. Numa ata com abas `2025` e `2026`,
  a ocorrência de hoje ia para o fim do arquivo morto, com `anexado: true` e uma
  descrição de tool afirmando "ao FINAL do documento". Por isso
  `google_docs_anexar_texto` **recusa documento com mais de uma aba** em vez de
  escolher: "o final" de um documento com abas não é uma coisa só, e adivinhar
  errado aqui é indetectável.
- ⚠ **`occurrencesChanged: 0` volta com HTTP 200.** Placeholder que alguém quebrou
  por autocorreção no Google Docs não casa, e o contrato sai com `{{cliente}}`
  impresso. O retorno nomeia o que não foi trocado e manda o agente avisar que
  precisa de revisão humana.
- ⚠ **Conferir por um critério e substituir por outro não protege nada.** A
  conferência do pedido do agente é tolerante (casa `cliente` com `Cliente`),
  mas `replaceAllText` é literal e com `matchCase`. Um modelo escrito
  `{{ Cliente }}` aprovava o pedido, o `files.copy` criava o documento, e a
  substituição achava zero ocorrências — sobrava um contrato órfão no Drive, e
  mais um a cada tentativa do agente. Por isso `camposDoModelo` devolve **o
  nome E o literal**: casa-se pelo nome, substitui-se pelo literal.
- ⚠ **A conferência acontece nos DOIS sentidos, e antes do `files.copy`.** Campo
  informado que não existe no modelo já era recusado; faltava o inverso —
  campo que existe no modelo e o agente não informou sai impresso como
  `{{Vigência}}` no contrato, e o retorno dizia `criado: true` sem ressalva
  nenhuma. Os dois recusam antes de copiar: se a checagem viesse depois, o
  documento já existiria, o erro voltaria ao modelo como resultado normal, ele
  corrigiria e chamaria de novo — e cada tentativa deixaria no Drive um
  documento que **nenhuma tool apaga**.
- **Chamar sem `campos` consulta o modelo sem criar nada.** É o
  `zapsign_ver_modelo` desta integração, embutido na mesma tool em vez de custar
  uma tool inteira no prompt de todo agente. Sem ela o agente não teria como
  saber quais campos existem, e o caminho provável era criar o documento com
  metade deles cru.
- ⚠ **`includeTabsContent=true` é obrigatório.** No padrão, um documento com abas
  devolve só a primeira, sem erro nenhum. E documento organizado por abas tem o
  `body` vazio: quem lê só `body` recebe string vazia justamente dos documentos
  mais organizados. Tabela também tem árvore própria — `docs.ts` é puro e testado
  por isso.

#### Drive: três parâmetros cuja ausência devolve 200 com nada

- ⚠ **`includeItemsFromAllDrives=true` na listagem.** Sem ele, `files.list`
  devolve `200` com `files: []` — silêncio, não erro, e o agente conclui que a
  pasta está vazia. `supportsAllDrives` sozinho **não** basta na listagem.
- ⚠ **`corpora`/`driveId` NÃO entram na listagem**, por mais que o
  `driveCompartilhadoId` esteja configurado. `corpora=drive` restringe a
  consulta aos itens **daquele** Drive compartilhado, e o campo existe para
  dizer onde CRIAR arquivo, não onde procurar. Mandá-lo fazia uma pasta do Meu
  Drive de alguém — o caminho normal — passar a devolver lista vazia no dia em
  que o operador preenchesse o Drive compartilhado para poder gerar documento.
  `200`, sem erro, sem rastro: o mesmo desfecho que os dois parâmetros acima
  existem para evitar. Os dois juntos já alcançam os dois mundos.
- ⚠ **`fields` omitido devolve só `kind,id,name,mimeType`** — nada de tamanho,
  data ou link. E `fields=files(...)` **sem `nextPageToken`** mata a paginação na
  primeira página, também em silêncio.
- ⚠ **`404 File not found` significa "não existe OU não foi compartilhado"**, de
  propósito, para não vazar a existência do arquivo. Repassado cru, o modelo diz
  ao cliente que a planilha não existe e o operador vai trocar um id que está
  certo. A tradução cita o `client_email` — que é a coisa que falta ser feita.
- ⚠ **`403` no Drive é cota tanto quanto permissão**, e só
  `error.errors[0].reason` separa. Tratar todo `403` como fatal faz desistir de um
  pico que passaria sozinho; tratar como retentável faz martelar um
  `insufficientFilePermissions` com o cliente esperando.
- **`name contains` casa o COMEÇO do nome, não um pedaço do meio**, e `parents` é
  um nível só — não há listagem recursiva. As duas coisas estão escritas na
  descrição da tool, porque o modelo que não sabe disso diz ao cliente que o
  arquivo não existe.
- **`trashed = false` em toda listagem**, senão a lixeira aparece como conteúdo
  vivo.

#### O que ficou de fora, e por quê

- **Excluir, mover e compartilhar arquivo.** Dar a um modelo que lê mensagem de
  cliente o poder de apagar arquivo ou de conceder acesso a terceiros é risco sem
  contrapartida. Mesmo tratamento do `DELETE` da ZapSign — e há teste no catálogo
  travando que nenhuma tool tenha `excluir`/`apagar`/`remover` ou
  `permiss`/`compartilh` no nome.
- **Arquivar no Drive o anexo que o cliente mandou.** Precisa dos bytes, e
  `ToolContext` não os tem. É possível sem mudar o contrato
  (`chatwootConversationId` + `listarMensagens` + `baixarArquivo`), mas é
  capacidade nova, acopla o módulo Google ao do Chatwoot, e um upload de 5 MB não
  cabe no orçamento de 3 minutos do vigia de espera.
- **Criar planilha ou aba nova.** Exige quota de criação e resolve um problema que
  ninguém tem: a planilha de controle já existe.
- **Config de Google por agente.** `AgentIntegration` só tem `enabled` +
  `allowedTools`. O cadastro é global e quem restringe é o `systemPrompt` do
  agente. Se virar requisito, o molde é `AgentChatwootBot`.

#### Pré-requisito que não é adivinhável

⚠ **Sem a leitura de mídia ligada no agente da PORTA, o caso de uso morre antes de
começar.** Mensagem só com anexo e leitura desligada vira entrega `ignorado` no
webhook e **nenhum job é criado** — o PDF não chega a agente nenhum. Quem liga o
Google não pensa em ir na aba da OpenAI, e o sintoma é silêncio.

E ⚠ **PDF que chegue por gatilho HTTP ou por agendamento não vira texto**: só o
worker de atendimento chama `lerMidiaDaConversa`. As tools de planilha funcionam
nas quatro origens; a leitura do anexo, não.

⚠ **Afiar `instrucaoDocumento` muda TODOS os agentes.** É campo único da linha
única da integração OPENAI. Trocar "resuma" por "transcreva literalmente" para
melhorar a extração muda o contexto de todo atendimento que recebe PDF — e **não
reprocessa** o que já está em `MediaAnalysis` com status `OK`, porque a chave do
cache é o arquivo. Teste sempre com arquivo novo.

### Regras globais de atendimento

Em `src/server/integrations/chatwoot/regras.ts`, puras e testadas. Aplicadas em
três pontos, e o terceiro é o que as torna absolutas:

1. Na chegada do webhook — filtro barato, evita encher a fila.
2. No início do processamento — estado do nosso banco.
3. **Antes de enviar, contra o estado ao vivo do Chatwoot** — e de novo depois da
   chamada ao modelo, porque um humano pode assumir enquanto o agente pensa.

As regras:

- **Conversa atribuída a humano: o agente cala.** Vale mesmo com a conversa aberta.
- ⚠ **O Chatwoot atribui o PRÓPRIO Agent Bot à conversa, e isso é normal.** Não
  é automação nem auto-assignment mal configurado: numa caixa com robô, a
  conversa nasce `pending` com o bot como responsável. Ler isso como "um humano
  assumiu" calava o bot para sempre — a conversa resolvida nem reabria, porque
  reabrir exige não ter dono, e nada mais mudaria aquele estado. Pior: `pending`
  não aparece na visualização padrão, então ela ficava **invisível** para a
  equipe inteira. Ninguém descobria.
- **Quem separa pessoa de robô é `meta.assignee_type`** (`User` · `AgentBot`),
  em `humanidadeDoDono`. **Não dá para comparar o id**: as tabelas de usuário e
  de AgentBot do Chatwoot têm sequências independentes e **colidem** — na conta
  da Seahub o bot "Seahub Coworking" e a agente Maria Eduarda são ambos o id 4.
  Uma primeira versão desta correção comparava contra `GET /agents` e não
  funcionava por causa exatamente disso.
- ⚠ **`assignee_id` não existe na resposta desta API.** `GET /conversations/{id}`
  devolve o responsável só em `meta.assignee`. O `??` para `assignee_id` continua
  no código por segurança, mas quem manda é o meta.
- **Na dúvida sobre o tipo do dono, cale.** `assignee_type` ausente devolve
  `undefined` e mantém o comportamento antigo. Falar por cima de um atendente de
  verdade é pior que ficar quieto — a incerteza sempre pende para o silêncio.
- **Ao encontrar a si mesmo como responsável, o worker desatribui**
  (`assignee_id: 0`) e **abre a conversa ao assumir**, não só depois de
  responder: se o turno falhar, ela precisa estar visível justamente aí.
- **Nós nunca atribuímos o bot.** Os quatro caminhos que atribuem
  (`atribuir_para_atendente`, `atribuir_por_rodizio`, `transferir_para_humano`
  e o vigia) resolvem o nome contra `GET /agents`, então só chegam a pessoas.
  Não procure a automação culpada: não existe.
- **Conversa resolvida: nenhuma interação.** Vale para a rede de segurança
  também: se resolverem no meio do turno, o contorno **não** sai — reabriria a
  discussão numa conversa que alguém acabou de encerrar. O que **não** é
  interação em conversa resolvida é a **mensagem nova do cliente**: ela é o
  sinal de que a conversa voltou, e o worker reabre no Chatwoot antes de
  responder (`reabrirSeResolvida`). O Chatwoot costuma reabrir sozinho e em
  2026-08-03 não reabriu — sem isso, nada mais mudaria aquele status e a
  conversa ficava muda para sempre. **Só reabre o que não tem dono**, e só no
  começo do turno: resolução que acontece durante o turno ganha.
  E `message_created` **nunca** conta como sinal de resolução — o status ali é
  só contexto, e tratá-lo como resolução engolia a mensagem que reabriria tudo.
- **Conversa do bot nunca fica pendente.** O Chatwoot põe em `pending` a
  conversa de caixa com Agent Bot, e `pending` não aparece na visualização
  padrão — ficaria invisível para a equipe. O bot **age** em `open` e
  `pending`, mas **termina sempre em `open`** (`precisaAbrir`). E nunca
  resolve: encerrar é decisão de pessoa.
- **Resolver corta o histórico** (`Conversation.historicoDesde`). Reabriu, começa
  do zero: o mesmo cliente costuma voltar por outro assunto, e arrastar contexto
  antigo faz o agente responder a pergunta errada.

⚠ **Resolver no Chatwoot não desatribui ninguém.** A conversa resolvida continua
com o dono que tinha, e dono é justamente o que cala o bot — então ela fica muda
para sempre, sem erro nenhum. Quem tira o dono é uma **automação nativa do
Chatwoot**, do lado de lá, e ela precisa existir **em cada conta/caixa** que este
sistema atende. Não a reimplemente aqui: capacidade duplicada é a que diverge.
Caixa nova sem a automação = bot silencioso; o diagnóstico está em Entregas
recebidas, com `conversa atribuída a um humano` no detalhe.

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
  Tool que já avisou o cliente marca `sinais.avisouCliente` — sem isso o
  contorno sairia por cima de uma transferência bem-sucedida.

#### "Passar para a equipe" precisa entregar a alguém

`transferir_para_humano` deixava a conversa **órfã**: status humano, dono
nenhum, e o vigia não olha para ela porque só vigia conversa do bot. A nota
dizia "Transferido pelo agente" e ninguém estava a caminho — sem erro nenhum,
como sempre.

- **O responsável padrão do agente (`fallbackAtendente`) é quem assume.** O
  campo servia só ao vigia; agora vale para os dois casos em que o bot precisa
  de uma pessoa e não tem um nome. Time do Chatwoot (`handoffTeamId`) continua
  valendo e soma com a pessoa.
- **Sem responsável configurado, a nota interna diz isso em letras claras.**
  Conversa sem dono some no meio da fila; melhor a equipe saber pela nota do que
  descobrir pelo cliente cobrando.
- **`aviso` virou obrigatório aqui também**, e sai **antes** da atribuição —
  com `assignee_id` preenchido a regra global cala o bot e a mensagem seria
  descartada. Era por isso que a tool mandava o modelo escrever depois; agora o
  sistema garante.

### Parar uma execução em andamento

Botão em Execuções, no cartão de quem está `RUNNING`. Exige `ADMIN` — parar
interrompe um atendimento com cliente do outro lado.

- **O canal é o Redis, não o banco.** O painel roda em outro processo que não o
  worker, então não há memória compartilhada para tocar. Coluna no Postgres
  funcionaria e custaria uma consulta por iteração de tool, no caminho mais
  quente do sistema. Mesmo padrão do batimento do worker.
- **Quem para é o próprio turno.** O botão deixa um recado
  (`seahub:run:cancelar:<runId>`, TTL 1h) e responde; o runner o encontra num
  ponto em que sabe o que está a meio caminho. Ninguém mata processo de fora.
- **A chamada ao modelo é abortada de verdade** (`comParadaVigiada`). Parar só
  entre iterações não alcançaria um turno pendurado — que é justamente o que
  alguém quer matar, e é onde o tempo é gasto.
- **`AbortError` só vira interrupção se fomos NÓS que abortamos.** Timeout do
  SDK e queda de rede chegam do mesmo jeito; confundi-los faria o worker
  desistir de tentar de novo uma falha real.
- ⚠ **O BullMQ reexecuta o job inteiro quando o handler lança.** Se a
  interrupção subisse como erro comum, o agente voltaria a rodar segundos
  depois e o cliente receberia justamente a resposta que alguém tentou impedir.
  Os dois workers tratam `ehInterrupcao` **antes** de relançar.
- **`CANCELED` é estado próprio, não `ERROR`.** A apuração conta erros para
  dizer "quanto se gastou sem resultado"; parada deliberada nessa conta mandaria
  o operador caçar um defeito que ele mesmo causou. O custo até o corte continua
  gravado — a OpenRouter cobra pelo que rodou.
- **A rede de segurança não dispara.** Mandar "tive uma instabilidade" seria o
  sistema contradizendo quem acabou de decidir calar o agente — e a pessoa pode
  estar parando porque ele falava errado. O cliente não fica órfão:
  `aguardandoDesde` segue correndo e o vigia escala como escala qualquer turno
  sem resposta. Fica uma **nota interna** nomeando quem parou, senão o agente
  emudecer no meio do atendimento seria indistinguível de travamento.
- **Execução órfã é encerrada na hora.** `RUNNING` com mais de 10 min, ou com o
  worker morto, não tem ninguém para receber o recado — ficaria "rodando" para
  sempre. Redis indeterminado **não** conta como worker morto: não se fecha o
  que pode estar vivo.

### Apuração de consumo (`/consumo`)

Quanto se gastou, com qual modelo, por qual agente, em que dia. O valor é o
custo **real** que a OpenRouter devolve em `usage.cost` — dá para conferir
contra a fatura deles, e é por isso que a tela vale a pena.

- **`AgentRun.model` congela o modelo no momento da execução.** Antes disso o
  único registro era `Agent.model`, que é o modelo de **agora**: apurar por ele
  faria trocar de modelo hoje reescrever a fatura de ontem inteira. A migration
  `modelo_na_execucao` preencheu o histórico a partir de `AgentVersion` — a
  versão vigente na data de cada execução. Onde não havia evidência (agente
  anterior ao versionamento) o campo fica **nulo** e a tela mostra "sem modelo
  registrado" em vez de chutar.
- **Todo corte é pelo dia civil de São Paulo.** O container roda em UTC; um
  "hoje" calculado por lá começaria às 21h de ontem, e o fechamento do dia sairia
  errado. Ver `inicioDoDiaEmSaoPaulo` — e o fim do intervalo é **exclusivo**
  (`< início do dia seguinte`), porque o Postgres guarda mais precisão que o
  `Date` do JS e comparar com `<=` no último milissegundo perde execução.
- **A agregação é pura e testada** (`agregacao.ts`), sobre uma varredura só do
  período. Cinco `GROUP BY` em SQL seriam mais escaláveis e menos verificáveis —
  e isto é dinheiro. O preço é o teto de `TETO_DE_LINHAS`: acima dele a tela
  **pede um período menor** em vez de mostrar um total pela metade.
- **Execução com erro continua no custo.** A OpenRouter cobra os tokens gastos
  até a falha; tirá-la da conta esconderia justamente o gasto que não deu em
  nada. A tela conta os erros à parte.
- **Playground custa igual** e aparece na quebra por origem — separar teste de
  produção é decisão de quem fecha o mês, não do código.
- **Custo por atendimento conta conversa distinta**, não execução: três turnos
  da mesma conversa são um atendimento só.
- **O CSV usa `;` e decimal com vírgula.** O destino é o Excel em português: com
  `,` de separador ele joga a linha toda numa célula, e com `.` de decimal lê
  como texto e a soma dá zero. Seis casas no custo, senão um turno de US$ 0,0007
  vira R$ 0,00.
- **Filtro mora na URL** (`Filtros`), numa barra só acima de tudo que ele
  recorta — dois gráficos da mesma tela com períodos diferentes seria pior que
  não ter filtro. As opções vêm de todo o histórico, não do período aberto, para
  o recorte não sumir da lista quando se troca a data.

### Execuções: a expansão é sob demanda

A lista traz só o resumo. Entrada e resposta inteiras, parâmetros e retorno de
cada tool e a transcrição enviada ao modelo descem quando o cartão é expandido
(`detalharExecucao`).

- **`AgentRun.messages` não pode entrar na consulta da lista.** É a conversa
  inteira mandada à OpenRouter; um turno longo passa de um megabyte, e o
  `findMany` sem `select` trazia cinquenta deles a cada abertura da tela — para
  não exibir nenhum. O `select` explícito ali é obrigatório, não estilo.
- **Bloco grande é cortado, e o corte aparece** (`TETO_DE_TEXTO`). Retorno de
  tool com dezenas de milhares de linhas trava a aba; cortar em silêncio seria
  pior que não mostrar.
- **A leitura da transcrição é pura e testada** (`execucoes/trace.ts`): no
  protocolo de chat completions, `content` às vezes é string e às vezes é lista
  de blocos, e a chamada de tool vive em `tool_calls` — mensagem de tool lida só
  por `content` aparecia vazia no meio do trace.

### Tema e tokens visuais

Três estados: `data-theme="light"`, `data-theme="dark"` e o padrão "sistema",
que **não carimba nada** e é resolvido por `prefers-color-scheme`.

- **Os valores escuros aparecem duas vezes no `globals.css`** — na media query
  (com guarda `:not([data-theme="light"])`) e no seletor de atributo. Mexeu num,
  mexa no outro; sem os dois, ou o botão não vence o sistema, ou o sistema não
  vence a ausência de escolha.
- **O tema é carimbado por script inline no `<head>`.** Qualquer coisa assíncrona
  chegaria depois do primeiro quadro e quem escolheu claro veria o painel escuro
  piscar. O `<html>` leva `suppressHydrationWarning` por causa disso.
- **Gráfico não inventa cor.** Série única, sempre no accent: a categoria é o
  dia (ou o modelo), que não tem identidade para uma cor carregar, e escurecer
  conforme o valor só repetiria em cor o que o comprimento já diz. Duas medidas
  nunca dividem o mesmo eixo — troca-se a medida e a escala inteira troca junto.

### Papéis: a descrição faz parte da permissão

`OWNER > ADMIN > VIEWER`, com os pesos em `auth-guard.ts`. O que cada papel
concede está descrito em **`src/lib/papeis.ts`**, e essa é a fonte única —
rótulo, resumo e as listas de "pode" e "não pode" que a tela de Usuários mostra.

- **Mudou a permissão de uma ação? A descrição é parte da mudança.** É por essa
  frase que alguém decide a quem entregar uma conta; uma descrição errada
  entrega poder que ninguém quis dar. Um teste trava o catálogo contra o enum,
  para papel novo não aparecer sem rótulo.
- **O playground exige `ADMIN`**, não só sessão. Cada mensagem ali roda o modelo
  e a OpenRouter cobra — "Leitura" gastando crédito contradizia o próprio nome
  do papel. A tela esconde e a rota recusa com `403`: esconder sozinho não é
  garantia.
- **A ordem dos seletores vai do menor para o maior privilégio**
  (`ORDEM_DOS_PAPEIS`), para quem libera acesso encontrar primeiro a opção mais
  contida.
- **Só `OWNER` toca em credencial, em token de gatilho e em conta.** `ADMIN` faz
  todo o resto: agentes, config de integração, tools por agente e liga/desliga
  do gatilho.

### Regras do projeto

- **Toda rota em `/api/` checa a própria sessão.** O `proxy.ts` não cobre `/api/*`
  de propósito: um redirect devolveria HTML onde o cliente espera JSON.
- **Num arquivo `"use server"`, TODA função exportada é um endpoint** — inclusive
  a que existe só para a página chamar na renderização. O `proxy.ts` não protege
  isso: quem chama monta a requisição direto. Então função de leitura exportada
  de `src/server/actions/*` precisa de `exigirSessao()` na primeira linha, mesmo
  que a tela que a usa já exija sessão. ⚠ `resumoDoBot` e `resumoDoGatilho` são
  anteriores a esta regra e continuam sem guarda — devolvem pouco (booleanos e
  máscara de token), mas não são exemplo a seguir.
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
