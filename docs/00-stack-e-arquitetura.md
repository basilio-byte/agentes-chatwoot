# Seahub Agentes — Stack e Arquitetura

> Documento de decisão inicial. Data: 2026-07-28.
> Projeto: plataforma para criar e gerenciar agentes de I.A. (chatbots) que atendem
> dentro do Chatwoot da Seahub Coworking, usando dados de integrações conectadas
> (ClickUp, ERP Conexa e outras futuras).

---

## 1. O que o sistema precisa fazer

| Requisito | Implicação técnica |
| --- | --- |
| Rodar dentro do Easypanel | Deploy via Dockerfile, serviços separados (app / worker / Postgres / Redis) |
| Criar agentes com prompt personalizado | CRUD de agentes + versionamento de prompt + playground de teste |
| Agentes atendem no Chatwoot como chatbots | Chatwoot **Agent Bot** (webhook + API), 1 bot → N inboxes |
| Agentes usam dados das integrações | Tool use (function calling) — cada integração expõe um conjunto de tools |
| Integrações ligadas/desligadas | Toggle em 2 níveis: conexão global e permissão por agente |
| ClickUp e ERP Conexa (docs depois) | Camada de integração plugável, contrato único, adicionar sem refatorar |

---

## 2. Stack definida

| Camada | Escolha | Por quê |
| --- | --- | --- |
| Linguagem | **TypeScript** (Node 24 no container) | Um só idioma no backend, UI e schemas das tools. SDK da Anthropic é first-class. |
| Framework | **Next.js 16 (App Router)** | Painel admin + API de webhooks no mesmo container. `output: "standalone"` gera imagem enxuta — encaixa direto no Easypanel. |
| Banco | **PostgreSQL 16 + Prisma 7** | Relacional (agente ↔ integração ↔ conversa ↔ execução). Template pronto no Easypanel. Prisma 7 usa driver adapter (`@prisma/adapter-pg`) — o pool é do `pg`, não mais de um engine em Rust. |
| Fila / jobs | **BullMQ + Redis 7** | **Não é opcional.** Webhook do Chatwoot precisa responder em ms; a chamada ao LLM leva segundos. A fila também dá retry, rate limit por integração e o *debounce* de mensagens (cliente manda 3 linhas seguidas = 1 resposta). |
| LLM | **OpenRouter** via SDK `openai` | Um provedor, ~340 modelos, uma fatura só. Fala o protocolo de chat completions da OpenAI, então usamos o SDK oficial da OpenAI apontado para o endpoint deles. Trocar de modelo não exige mudar código. |
| Escolha de modelo | Catálogo ao vivo da OpenRouter | O painel lista os modelos direto da API pública `/models` — nome, preço, contexto e se aceita `tools`/`reasoning`. Tabela fixa no código ficaria desatualizada em semanas. |
| Modelo padrão | `openai/gpt-5.6-luna` | Ponto de partida, trocável por agente na tela. |
| UI | **React 19 + Tailwind 4** | Conjunto pequeno de primitivas próprias (`src/components/ui.tsx`); cresce sob demanda em vez de arrastar uma biblioteca inteira. |
| Validação | **Zod 4** | Um schema serve para: form do painel, payload do webhook e `input_schema` da tool. O `z.toJSONSchema()` do Zod 4 faz a última conversão nativamente. |
| Auth | **Auth.js v5** (credenciais, sessão JWT) | Ferramenta interna: e-mail/senha + papéis (`OWNER`, `ADMIN`, `VIEWER`). Sem adapter de banco — credenciais exigem estratégia JWT. |
| Segredos | AES-256-GCM no banco, chave mestra em env | Tokens de ClickUp/Conexa/Chatwoot nunca em texto plano nem retornados pela API. |
| Logs | **pino** + trace de execução no Postgres | Cada resposta do agente guarda: mensagens, tools chamadas, tokens, custo, latência. |
| Testes | **Vitest** | Foco em: registry de integrações, loop de tools e parsing do webhook. |

### Alternativas descartadas

- **API da Anthropic direto** — era o desenho inicial. A OpenRouter foi escolhida para não amarrar o projeto a um fornecedor e permitir trocar de modelo pela tela.
- **shadcn/ui** — a intenção era usar, mas o painel precisa de ~6 primitivas. Um arquivo próprio de 150 linhas evita a dependência e o passo de CLI.
- **NestJS + SPA separada** — dois deploys, dois builds, sem ganho real nesta escala.
- **n8n / Flowise** — resolveria o MVP, mas prompt versionado, permissão de tool por agente e auditoria de custo ficariam fora do controle.
- **LangChain** — abstração a mais. O loop de tool use da Anthropic tem ~80 linhas e nós precisamos ver cada passo para auditar.

---

## 3. Arquitetura no Easypanel

Quatro serviços no mesmo projeto:

```text
┌─────────────────────────────────────────────────┐
│ Easypanel (Traefik + HTTPS automático)          │
│                                                 │
│  [app]      Next.js — painel + /api/webhooks    │
│               │                                 │
│               ├── enfileira ──▶ [worker]        │
│               │                   │ loop LLM    │
│               │                   │ chama tools │
│               │                   ▼             │
│               │              responde no        │
│               │              Chatwoot (API)     │
│               ▼                   ▼             │
│           [postgres]          [redis]           │
└─────────────────────────────────────────────────┘
```

- `app` e `worker` usam **a mesma imagem**, mudando só o comando de start. Escala independente.
- O `docker-entrypoint.sh` roda `prisma migrate deploy` antes de subir — idempotente, seguro a cada deploy.
- Local: `npm run db:up` sobe Postgres na **5434** e Redis na **6380** (5432 e 5433 já estão ocupadas nesta máquina).
- Webhook do Chatwoot → valida assinatura → grava evento → enfileira → responde `200` imediatamente.
- Variáveis de ambiente ficam no Easypanel; nada de `.env` versionado.

### Estrutura de pastas

```text
src/
  app/
    (admin)/                 painel: agentes, integrações, conversas, logs
    api/webhooks/chatwoot/   entrada dos eventos
  server/
    agents/                  runner: monta contexto, executa loop de tools
    integrations/
      registry.ts            registro central
      chatwoot/              client + tools
      clickup/               client + tools
      conexa/                client + tools
    queue/                   filas e workers BullMQ
    crypto/                  encrypt/decrypt de credenciais
  lib/                       zod schemas compartilhados
prisma/schema.prisma
docker/Dockerfile
```

---

## 4. Modelo de dados (núcleo)

| Tabela | Papel |
| --- | --- |
| `User` | acesso ao painel + papel |
| `Agent` | nome, `systemPrompt`, modelo, temperatura, `active`, regras de handoff |
| `AgentVersion` | histórico imutável do prompt — permite rollback quando um ajuste piora o atendimento |
| `AgentInbox` | quais inboxes do Chatwoot este agente atende |
| `Integration` | uma conexão configurada (`chatwoot` / `clickup` / `conexa`) + `enabled` |
| `IntegrationCredential` | segredos cifrados, separados da config visível |
| `AgentIntegration` | join agente↔integração com `enabled` + **allowlist de tools** |
| `Conversation` | mapeia conversa do Chatwoot → agente, status, se foi para humano |
| `AgentRun` | uma execução: input, output, **modelo usado**, tokens, custo, latência, erro |
| `ToolCall` | cada chamada de tool dentro de um run: nome, input, output, duração |

`AgentRun` + `ToolCall` são o que permite responder "por que o bot respondeu isso?" — sem eles, depurar atendimento vira adivinhação.

`AgentRun.model` guarda o slug da OpenRouter **daquela** execução, e não o modelo
atual do agente: é o que permite apurar consumo por modelo sem que uma troca de
modelo hoje reescreva o gasto do mês passado. Ver `/consumo`.

---

## 5. Integrações: contrato único e toggle

Toda integração implementa a mesma interface:

```ts
interface IntegrationDefinition {
  id: "chatwoot" | "clickup" | "conexa";
  label: string;
  configSchema: ZodSchema;              // campos do formulário no painel
  credentialSchema: ZodSchema;          // campos cifrados
  testConnection(cfg): Promise<Result>; // botão "Testar conexão"
  tools: ToolDefinition[];              // o que o agente pode fazer
}

interface ToolDefinition {
  name: string;                 // ex.: "clickup_criar_tarefa"
  description: string;          // o texto que o modelo lê para decidir usar
  inputSchema: ZodSchema;       // vira input_schema da API
  requiresConfirmation: boolean; // ações destrutivas passam por gate
  execute(input, ctx): Promise<unknown>;
}
```

**Ligar/desligar em dois níveis** — foi isso que você pediu, e a separação importa:

1. **Global** (`Integration.enabled`): desligou o ClickUp → nenhum agente enxerga as tools dele. Serve para manutenção ou token expirado.
2. **Por agente** (`AgentIntegration.enabled` + allowlist): o agente "Comercial" consulta o ERP mas não abre tarefa no ClickUp; o "Suporte Interno" faz o contrário.

Na montagem do request, o array de `tools` é construído a partir da interseção dos dois níveis. Uma integração desligada simplesmente não existe para o modelo — nada de tool que retorna "desabilitado".

> ⚠️ Trocar o conjunto de tools no meio de uma conversa invalida o prompt cache. Por isso o toggle vale a partir da **próxima** conversa, não da mensagem seguinte.

---

## 6. Fluxo Chatwoot

**Configuração (uma vez):**

1. Criar um Agent Bot no Chatwoot apontando `outgoing_url` para `https://<app>/api/webhooks/chatwoot`.
2. Guardar o `access_token` do bot (cifrado) — é ele que autentica as respostas.
3. Vincular o bot às inboxes que os agentes vão atender.

**Em runtime:**

```text
cliente manda mensagem
   → Chatwoot dispara message_created no webhook
   → app valida, ignora eco (message_type outgoing / sender agent_bot)
   → enfileira com debounce de ~4s por conversa
   → worker resolve qual agente atende (inbox → AgentInbox)
   → monta contexto: system prompt + histórico + tools habilitadas
   → loop de tool use até o modelo parar de pedir tools
   → POST da resposta na conversa via API do Chatwoot
   → grava AgentRun + ToolCall
```

**Handoff para humano** — o agente recebe uma tool `transferir_para_humano(motivo, time)`: muda o status da conversa para `open`, atribui ao time, adiciona label e para de responder naquela conversa. Também dispara automaticamente após N falhas de tool ou se o cliente pedir explicitamente.

Cuidados que já estão previstos no desenho:

- **Loop de bot**: ignorar toda mensagem cujo remetente seja o próprio bot.
- **Idempotência**: o Chatwoot reenvia webhook em falha — deduplicar por `message.id`.
- **Conversa já com humano**: se `assignee_id` está preenchido por uma pessoa, o bot cala.

> Os endpoints e nomes de eventos devem ser conferidos contra a versão exata do Chatwoot da Seahub antes de implementar — a API de Agent Bots mudou entre versões.

### 6.1 Leitura de mídia (acrescentado em 14/08/2026)

Cliente que manda **áudio, foto ou documento** em vez de digitar. Antes disso a
mensagem chegava com `content` vazio, era recusada no webhook e o atendimento
morria calado — sem erro, sem registro, sem ninguém saber.

O anexo vira texto **entre** a leitura do histórico e a montagem do contexto:

```text
worker lê o histórico no Chatwoot
   → mensagensCandidatas()            (tira nota interna, atividade, corte de histórico)
   → enriquecerComMidia()             ← áudio/imagem/documento viram texto aqui
   → montarContexto()                 (agrupa mensagens picotadas; descarta vazias)
   → executarAgente()
```

| Decisão | Por quê |
| --- | --- |
| **OpenAI direta, não OpenRouter** | `/audio/transcriptions` não existe na OpenRouter. Mesmo SDK `openai`, outra `baseURL`, outra chave, **outra fatura**. A conversa continua toda na OpenRouter. |
| **Passo de preparo, não tool** | O agente não escolhe se vai ouvir o cliente. Uma tool que ele esquecesse de chamar deixaria a pessoa sem resposta sobre o que acabou de mandar. |
| **`IntegrationProvider.OPENAI` com zero tools** | Reusa credencial cifrada, toggle global, toggle por agente e o lugar conhecido no painel. Tabela paralela seria capacidade duplicada. |
| **Cache em `MediaAnalysis`** | O worker relê o histórico inteiro a cada turno. Sem cache, o mesmo áudio seria transcrito de novo a cada mensagem — o gasto cresceria com o tamanho da conversa. |
| **Quem decide é a porta** | O webhook precisa decidir se agenda uma mensagem só-com-anexo antes de saber quem vai pensar; e a transcrição é da conversa, não do pensador. |
| **Desligada = comportamento anterior** | Estava em produção. Sem a leitura ligada, mensagem só com anexo continua não virando atendimento — só que agora fica escrito por quê em Entregas recebidas. |
| **Sem custo em `/consumo`** | A OpenAI não devolve custo por requisição. Estimar quebraria a única promessa daquela tela: conferir contra a fatura. Ficam tokens e segundos de áudio. |

Configuração em **Integrações → Leitura de mídia**: chave, modelos (com
autocomplete vindo de `GET /models` da conta), idioma do áudio, o que pedir ao
modelo em imagem e documento, teto de tamanho e de anexos por turno — e um
**teste com arquivo** que mostra exatamente o texto que o agente receberia, para
ninguém precisar mandar áudio no WhatsApp de produção para saber se funciona.

---

## 7. Loop de agente (tool use)

Loop manual, ~100 linhas, sem framework — protocolo de chat completions:

1. `chat.completions.create` com `system` (prompt do agente), histórico, mensagem nova e `tools`.
2. Se vier `tool_calls` → executa **todas** as tools do turno em paralelo → devolve **uma mensagem `role: "tool"` por chamada** (diferente do formato da Anthropic, que agrupava tudo numa mensagem só).
3. Repete até o modelo parar de pedir tools, com teto de iterações (default 8) para não gastar sem limite.
4. Erro de tool volta como resultado normal, com o texto do erro — o modelo se ajusta em vez de travar.

Detalhes que valem dinheiro e qualidade:

- **`usage: { include: true }`** faz a OpenRouter devolver o **custo real** da chamada em `usage.cost`. É esse valor que grava em `AgentRun.costUsd`; a tabela de preços só serve de estimativa quando ele não vem.
- **Cache de prefixo** é automático nos provedores que suportam (OpenAI, Gemini, DeepSeek). Os tokens cacheados chegam em `prompt_tokens_details.cached_tokens` — e já vêm **dentro** de `prompt_tokens`, então a estimativa desconta para não cobrar duas vezes.
- **Ordem determinística das tools** (ordenar por nome) — reordenar quebra o cache de prefixo.
- **Nada de timestamp/UUID dentro do system prompt** — invalida o cache a cada request. Contexto dinâmico entra como mensagem.
- **`reasoning: { effort }` só vai para modelo que declara suporte** — mandar para os outros é erro de parâmetro em alguns provedores.
- **Argumentos de tool chegam como string JSON** e modelos erram esse JSON: o `JSON.parse` é protegido e devolve o erro ao modelo para ele reenviar.
- Toda tool que escreve (criar tarefa, alterar cadastro no ERP) começa com `requiresConfirmation: true`.

---

## 8. Segurança

- Credenciais de integração cifradas em repouso (AES-256-GCM, chave em env do Easypanel); a API nunca devolve o segredo, só `••••1234`.
- Webhook do Chatwoot validado por token secreto na URL + verificação de origem.
- Painel com login obrigatório e papéis; só `owner` gerencia credenciais.
- Rate limit por integração no worker, para não derrubar o ERP em pico.
- Log de auditoria em toda alteração de prompt e de credencial.

---

## 9. Fases

| Fase | Entrega |
| --- | --- |
| **1 — Fundação** | Scaffold Next.js + Prisma + Docker, deploy no Easypanel, auth, CRUD de agentes com playground de teste (conversa direto com o agente, sem Chatwoot) |
| **2 — Chatwoot** | Agent Bot, webhook, fila, loop de resposta, handoff para humano, tela de conversas com trace |
| **3 — Integrações** | Registry + toggles, ClickUp e Conexa (após as docs de API), tela de conexões com "Testar conexão" |
| **4 — Operação** | Base de conhecimento (pgvector), ~~dashboard de custo/token por agente~~ (entregue em 11/08/2026 na tela `/consumo`, com quebra por modelo, agente, origem e dia, e exportação CSV), métricas de resolução e taxa de handoff |

O playground na Fase 1 é proposital: dá para validar prompt e comportamento antes de qualquer coisa tocar o Chatwoot de produção.

---

## 10. Decisões confirmadas e pontos em aberto

**Confirmado em 2026-07-28:**

- **Chatwoot self-hosted** — instância própria da Seahub. Isso dá acesso à Platform API
  (criação de Agent Bot via API, não só pela UI) e permite fixar a versão.
- **Single-tenant** — o sistema atende apenas a Seahub. Sem `tenantId` no schema,
  sem escopo por organização. Simplifica queries, auth e o modelo de permissão.

**Em aberto:**

1. **Docs de API do ClickUp e Conexa** — pendentes. O registry já está desenhado para recebê-las sem refatoração.
2. **Versão exata do Chatwoot** — a API de Agent Bots mudou entre versões. Só bloqueia a Fase 2;
   a Fase 1 (playground) não toca o Chatwoot.
