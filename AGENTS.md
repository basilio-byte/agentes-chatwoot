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

### Regras globais de atendimento

Em `src/server/integrations/chatwoot/regras.ts`, puras e testadas. Aplicadas em
três pontos, e o terceiro é o que as torna absolutas:

1. Na chegada do webhook — filtro barato, evita encher a fila.
2. No início do processamento — estado do nosso banco.
3. **Antes de enviar, contra o estado ao vivo do Chatwoot** — e de novo depois da
   chamada ao modelo, porque um humano pode assumir enquanto o agente pensa.

As regras:

- **Conversa atribuída a humano: o agente cala.** Vale mesmo com a conversa aberta.
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
