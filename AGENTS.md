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
- **Resolver corta o histórico** (`Conversation.historicoDesde`). Reabriu, começa
  do zero: o mesmo cliente costuma voltar por outro assunto, e arrastar contexto
  antigo faz o agente responder a pergunta errada.

⚠ O webhook de **Agent Bot pode não entregar `conversation_status_changed`**. Por
isso existe o webhook **de conta** (`/api/webhooks/chatwoot/conta`), com secret
próprio: ele dá precisão ao corte quando a conversa é resolvida sem ninguém
escrever. As regras 1 e 2 não dependem dele — o worker checa ao vivo.

### Regras do projeto

- **Toda rota em `/api/` checa a própria sessão.** O `proxy.ts` não cobre `/api/*`
  de propósito: um redirect devolveria HTML onde o cliente espera JSON.
- **O `proxy.ts` também não pode cobrir arquivos estáticos.** O otimizador de
  imagem do Next busca a origem **server-side, sem o cookie do usuário**: se o
  proxy interceptar `/algo.png`, ele recebe o HTML do login e a imagem quebra.
  O matcher exclui qualquer caminho com extensão.
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
