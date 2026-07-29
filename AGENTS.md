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

### Regras do projeto

- **Toda rota em `/api/` checa a própria sessão.** O `proxy.ts` não cobre `/api/*`
  de propósito: um redirect devolveria HTML onde o cliente espera JSON.
- **Nada de timestamp, UUID ou data dentro do system prompt.** Invalida o prompt
  cache a cada request e multiplica o custo. Contexto dinâmico entra como mensagem.
- **Todo agente recebe data/hora de São Paulo** em toda execução, como mensagem
  `system` imediatamente antes da mensagem do cliente (`mensagemDeContextoTemporal`
  em `src/lib/tempo.ts`). É a posição que preserva o cache — no início do prompt,
  a data mudaria o prefixo a cada requisição.
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
