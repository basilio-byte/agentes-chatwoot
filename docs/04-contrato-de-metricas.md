# Contrato de métricas (v1)

A porta de leitura do **banco central da Seahub**: o `seahub-sync` busca daqui
as métricas dos agentes. O sistema de agentes não envia nada a ninguém e continua
funcionando exatamente como antes; quem lê é o outro lado.

Publicado em 19/10/2026, migration `20261019134007_contrato_de_metricas`.

## Forma de acesso

Um schema só de views, `metricas_v1`, e um papel Postgres, `metricas_leitor`,
com `SELECT` apenas nesse schema.

| | |
| --- | --- |
| Host (rede interna do Easypanel) | `seahub_agentes-seahub-postgres` |
| Porta | `5432` |
| Banco | `seahub` |
| Usuário | `metricas_leitor` |
| Senha | entregue fora do repositório, num arquivo local |

A porta do Postgres não é publicada para fora do servidor: só alcança quem está
na rede interna do Easypanel (o `seahub-sync` está, no mesmo projeto `seahub`).

O que o papel **não** consegue:

- ler qualquer tabela do sistema (execução com entrada e saída, credencial,
  token do MCP, usuário, contato…) — `permission denied`;
- escrever, criar ou apagar qualquer coisa, inclusive tabela temporária — a
  sessão nasce somente leitura (`default_transaction_read_only`) e, mesmo que ele
  desligue isso, não tem permissão de escrita em lugar nenhum;
- chamar as funções internas do contrato (`metricas_interno`);
- ver o texto das consultas de outras sessões.

Limites do papel: 5 conexões ao mesmo tempo e 60 s por consulta.

O que ele **enxerga** além das views é só o catálogo do Postgres (nomes de
tabelas e colunas), como todo usuário do banco — o conteúdo, não.

### Criar, trocar e revogar a senha

Quem faz é quem tem acesso ao servidor (`postgres`). A senha nunca vai em texto
de conversa, commit ou documento.

```sql
-- criar ou trocar (as conexões já abertas continuam)
ALTER ROLE metricas_leitor LOGIN PASSWORD '<senha>';

-- revogar: ninguém entra mais, e quem está conectado cai
ALTER ROLE metricas_leitor NOLOGIN;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'metricas_leitor';
```

A migration cria o papel **sem login**: até alguém dar a senha, ninguém entra.
Dá para mandar o verificador SCRAM no lugar da senha
(`PASSWORD 'SCRAM-SHA-256$4096:…'`), e aí nem o servidor vê a senha em texto.

## Regras do contrato

- **Toda data em UTC** (`timestamptz`), ISO-8601 em qualquer driver.
- **Todo id é estável**: é o id da linha, que não muda.
- **Toda view tem `atualizado_em`** — a última alteração da linha, para a busca
  incremental.
- **Dados desde 31/07/2026** 00:00 de São Paulo (03:00 UTC), o início da
  produção. O que vier antes não aparece.
- **O playground aparece, marcado**: `execucoes.eh_teste` (teste da equipe, sem
  cliente).
- **Exclusões aparecem** em `metricas_v1.exclusoes`, desde 19/10/2026.
- **Mudança só ACRESCENTA**: coluna nova no fim, view nova. Mudar o sentido ou o
  tipo de uma coluna, ou tirar uma, é um `metricas_v2` ao lado, e o `v1`
  continua até quem lê migrar. A versão está em `metricas_v1.sobre`.
- **Fora do contrato, de propósito**: entrada, saída e mensagens das execuções;
  parâmetros e retorno das ferramentas; credenciais; tokens do MCP; usuários;
  configuração de robôs e gatilhos; telefones, e-mails, nomes de contato e
  qualquer texto livre (motivo de repasse, texto de erro, nome de arquivo).

Cada view e cada coluna também está descrita no próprio banco
(`COMMENT ON`): `\d+ metricas_v1.execucoes` no `psql` mostra.

## Busca incremental

Guarde a maior `atualizado_em` que leu (a "marca") e, na rodada seguinte, peça
o que mudou desde ela, **com uma folga de 15 minutos** — a data é escrita no
instante da alteração, e uma transação pode terminar segundos depois. Grave por
`id` (upsert): ler a mesma linha duas vezes não duplica nada.

```sql
SELECT *
FROM metricas_v1.execucoes
WHERE atualizado_em > :marca - interval '15 minutes'
ORDER BY atualizado_em, id;
```

Paginando (lotes de 5.000, sem `OFFSET`):

```sql
SELECT *
FROM metricas_v1.execucoes
WHERE (atualizado_em, id) > (:ultimo_atualizado_em, :ultimo_id)
ORDER BY atualizado_em, id
LIMIT 5000;
```

Exclusões, pelo mesmo caminho:

```sql
SELECT entidade, registro_id, excluido_em
FROM metricas_v1.exclusoes
WHERE atualizado_em > :marca - interval '15 minutes';
```

Volume de referência (19/10/2026): ~8.700 execuções desde o início, ~100 por dia.

## As views

### `sobre`

| coluna | |
| --- | --- |
| `versao` | Versão do contrato (`1.0.0`). |
| `publicada_em` | Quando esta versão foi publicada. |
| `dados_desde` | Início da produção; nada anterior aparece. |

### `agentes`

| coluna | |
| --- | --- |
| `id` | Id estável do agente. |
| `chave` | Chave do agente (não muda quando ele é renomeado). |
| `nome` | Nome atual no painel. |
| `ligado` | Se está ligado agora. |
| `arquivado_em` | Quando saiu de circulação; nulo se não foi arquivado. |
| `criado_em` | Criação. |
| `atualizado_em` | Última alteração. |

### `execucoes` — cada turno de um agente

| coluna | |
| --- | --- |
| `id` | Id estável. |
| `agente_id` | Quem pensou no turno (`agentes.id`). |
| `agente_nome` | Nome **atual** do agente; para juntar, use `agente_id`. |
| `conversa_chatwoot_id` | Conversa no Chatwoot; nulo fora de conversa. |
| `origem` | `atendimento` (cliente no Chatwoot: WhatsApp, Instagram), `playground`, `gatilho_http`, `agendamento`, `mesa`, `chamada_interna`, `conversa_encerrada`, `conversa_marcada`, `conversa_parada`. |
| `eh_teste` | Verdadeiro no playground. |
| `status` | `em_andamento`, `sucesso`, `erro`, `interrompida` (parada pelo painel). |
| `modelo` | Modelo que respondeu, congelado na execução. Nulo em parte do histórico antigo. |
| `motor` | `openrouter` ou `claude_max` (este só desde 21/09/2026). |
| `voltou_para_openrouter` | Começou no Claude Max, falhou e terminou na OpenRouter. |
| `tokens_entrada`, `tokens_saida` | Tokens somados no turno. |
| `tokens_cache_leitura`, `tokens_cache_escrita` | Tokens do cache do prompt. |
| `custo_usd` | Custo real cobrado pela OpenRouter, em dólar. **Nulo no `claude_max`** (a assinatura não cobra por turno). |
| `latencia_ms` | Duração do turno. |
| `iteracoes` | Idas ao modelo no turno. |
| `categoria_do_erro` | Nulo sem erro; senão `sem_credito`, `encerrada_por_inatividade`, `conexao`, `interrompida` ou `outro`. |
| `criada_em`, `finalizada_em` | Início e fim (fim nulo enquanto roda). |
| `atualizado_em` | O fim, ou o início enquanto roda: a execução não muda depois de terminar. |

### `chamadas_de_ferramenta`

| coluna | |
| --- | --- |
| `id` | Id estável. |
| `execucao_id` | O turno (`execucoes.id`). |
| `ferramenta` | Nome da ferramenta (ex.: `conexa_criar_reserva`). |
| `integracao` | `chatwoot`, `clickup`, `conexa`…; nulo nas internas. |
| `deu_erro` | A ferramenta falhou. |
| `duracao_ms` | Duração. |
| `criada_em` / `atualizado_em` | Quando foi gravada (não muda depois). |

### `conversas`

| coluna | |
| --- | --- |
| `id` | Id estável no sistema de agentes. |
| `conversa_chatwoot_id` | Id no Chatwoot — a chave para juntar com o Chatwoot. |
| `caixa_chatwoot_id` | Caixa de entrada. |
| `agente_entrada_id` | O agente da porta (o robô da caixa). |
| `agente_atual_id` | O dono agora (muda nas transferências entre agentes). |
| `status` | `agente`, `pessoa` ou `resolvida`. |
| `criada_em` | Primeira vez que chegou ao sistema. |
| `resolvida_em` | Última resolução vista. |
| `aguardando_desde` | Desde quando o cliente espera o robô; nulo se ninguém espera. |
| `ultimo_repasse_em` | Último repasse a uma pessoa. |
| `ultima_mensagem_em` | Última mensagem enviada pelo agente. |
| `atualizado_em` | Última alteração. |

### `repasses_para_pessoas` — histórico novo

Cada passagem da conversa para uma pessoa da equipe, como evento.

| coluna | |
| --- | --- |
| `id` | Id estável. |
| `conversa_chatwoot_id` | Conversa no Chatwoot. |
| `agente_id` | Agente dono da conversa no momento. |
| `caminho` | `rodizio`, `atribuicao_direta`, `transferencia` (ferramentas do agente); `vigia_de_espera` (o cliente esperou demais); `prazo_vencido` (venceu um prazo registrado pelo agente); `equipe_de_agentes` (as travas da equipe de agentes); `pessoa_assumiu` (alguém assumiu no Chatwoot); `presente_de_aniversario`; `nao_identificado` (só em reconstruído). |
| `reconstruido` | Deduzido do passado, não registrado na hora (ver abaixo). |
| `ocorrido_em` / `atualizado_em` | Quando aconteceu. |

⚠ **O histórico completo começa em 19/10/2026.** Antes disso o sistema guardava
só o ÚLTIMO repasse de cada conversa; esse último entrou como `reconstruido =
true`, com o caminho deduzido do motivo gravado (836 eventos; 85 sem caminho
identificável, quase todos `transferencia`). Uma conversa que passou três vezes
para pessoas antes de 19/10 aparece com um evento só.

Conversa que já estava com uma pessoa não gera evento de novo (o Chatwoot
reafirma o dono a cada atualização); o prazo vencido gera, porque passa a
conversa de uma pessoa para OUTRA.

### `repasses_entre_agentes`

| coluna | |
| --- | --- |
| `id` | Id estável. |
| `conversa_chatwoot_id` | Conversa no Chatwoot. |
| `agente_origem_id` | Quem passou; nulo quando foi o sistema. |
| `agente_destino_id` | Quem recebeu. |
| `ocorrido_em` / `atualizado_em` | Quando aconteceu. |

### `pesquisas_de_satisfacao` (NPS)

| coluna | |
| --- | --- |
| `id` | Id estável. |
| `conversa_chatwoot_id`, `caixa_chatwoot_id` | Conversa e caixa no Chatwoot. |
| `agente_id` | O agente da porta que mandou a pesquisa. |
| `situacao` | `agendada`, `aguardando`, `lembrada`, `respondida`, `agradecida`, `concluida`, `expirada`, `cancelada`, `falhou`. |
| `nota` | 1 a 5; nulo sem resposta válida. |
| `marcada_em`, `enviada_em`, `respondida_em`, `finalizada_em` | As etapas. |
| `atualizado_em` | Última alteração (coluna nova; o passado foi preenchido com a última etapa de cada pesquisa). |

### `notas_fiscais`

Notas de serviço emitidas (ou tentadas) pelo sistema na Spedy, uma por código de
serviço.

| coluna | |
| --- | --- |
| `id` | Id estável. |
| `cobranca_id_conexa` | Cobrança no Conexa. |
| `cliente_id_conexa` | Cliente no Conexa (o único dado do tomador). |
| `empresa_emissora` | `SEAHUB` ou `SEATECH`. |
| `codigo_servico` | Ex.: `03.03.02`. |
| `competencia` | `AAAA-MM`. |
| `situacao` | `reservada`, `enviada`, `autorizada`, `rejeitada`, `falhou`, `incerta`, `cancelada`. |
| `numero` | Número da NFS-e; nulo até ser autorizada. |
| `valor_centavos` / `valor` | Valor em centavos (exato) e em reais. |
| `emitida_pelo_n8n` | Nota do fluxo antigo, registrada só para não sair em dobro no corte. |
| `enviada_em`, `criada_em` | Último envio à Spedy; reserva no sistema. |
| `atualizado_em` | Última alteração. |

### `leituras_de_midia`

Áudio, imagem e documento lidos pela OpenAI (fatura separada da OpenRouter; a
OpenAI não devolve custo por requisição, então aqui vão tokens e segundos).

| coluna | |
| --- | --- |
| `id` | Id estável. |
| `tipo` | `image`, `audio`, `document`, `unsupported`. |
| `situacao` | `ok`, `skipped` (não lido de propósito, sem custo), `error`. |
| `origem` | `conversa`, `mesa`, `drive`, `clickup`. |
| `modelo` | Modelo da OpenAI. |
| `tokens_entrada`, `tokens_saida`, `segundos_de_audio`, `duracao_ms` | Uso. |
| `agente_id`, `conversa_chatwoot_id` | Onde foi lida. |
| `criada_em`, `atualizado_em` | Primeira leitura; última alteração (nova tentativa conta). |

### `exclusoes`

| coluna | |
| --- | --- |
| `id` | Sequencial. |
| `entidade` | A view de onde a linha saiu (`agentes`, `execucoes`, `chamadas_de_ferramenta`, `conversas`, `repasses_para_pessoas`, `repasses_entre_agentes`, `pesquisas_de_satisfacao`, `notas_fiscais`, `leituras_de_midia`). |
| `registro_id` | O `id` que a linha tinha. |
| `excluido_em` / `atualizado_em` | Quando foi apagada. |

Excluir um agente leva junto as execuções e as chamadas de ferramenta dele: cada
uma vira uma linha aqui. Fora isso (no painel, só Proprietário exclui agente),
o sistema não apaga nenhuma linha destas views.

## Como está montado

- **Views no schema `metricas_v1`**, donas `postgres` (quem roda as
  migrations): a view lê as tabelas com a permissão da dona, e o papel só tem
  `SELECT` na view.
- **Gatilhos `AFTER DELETE`** nas nove tabelas de origem gravam
  `ExclusaoDeRegistro`. A função mora em `metricas_interno`, fora do alcance do
  papel.
- **`RepasseParaPessoa`** é gravado por `entregarAoHumano`
  (`src/server/integrations/chatwoot/resolucao.ts`), a única porta para o estado
  "com uma pessoa". Falha ao gravar o evento nunca impede a entrega.
- **Tabela temporária** foi retirada do `PUBLIC` no banco: era a única escrita
  que todo papel tem por padrão.
- **Mudou uma tabela de origem?** A view absorve: renomear uma coluna interna é
  ajustar a view na mesma migration, sem mudar o nome da coluna do contrato.
