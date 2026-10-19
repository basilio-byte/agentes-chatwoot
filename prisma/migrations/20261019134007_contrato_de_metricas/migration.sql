-- CreateEnum
CREATE TYPE "CaminhoDoRepasse" AS ENUM ('RODIZIO', 'ATRIBUICAO_DIRETA', 'TRANSFERENCIA', 'VIGIA_DE_ESPERA', 'PRAZO_VENCIDO', 'EQUIPE_DE_AGENTES', 'PESSOA_ASSUMIU', 'PRESENTE_DE_ANIVERSARIO', 'NAO_IDENTIFICADO');

-- AlterTable
ALTER TABLE "PesquisaNps" ADD COLUMN     "atualizadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "RepasseParaPessoa" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "chatwootConversationId" INTEGER NOT NULL,
    "agentId" TEXT,
    "caminho" "CaminhoDoRepasse" NOT NULL,
    "reconstruido" BOOLEAN NOT NULL DEFAULT false,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepasseParaPessoa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExclusaoDeRegistro" (
    "id" BIGSERIAL NOT NULL,
    "entidade" TEXT NOT NULL,
    "registroId" TEXT NOT NULL,
    "excluidoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExclusaoDeRegistro_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepasseParaPessoa_criadoEm_idx" ON "RepasseParaPessoa"("criadoEm");

-- CreateIndex
CREATE INDEX "RepasseParaPessoa_conversationId_criadoEm_idx" ON "RepasseParaPessoa"("conversationId", "criadoEm");

-- CreateIndex
CREATE INDEX "ExclusaoDeRegistro_excluidoEm_idx" ON "ExclusaoDeRegistro"("excluidoEm");

-- AddForeignKey
ALTER TABLE "RepasseParaPessoa" ADD CONSTRAINT "RepasseParaPessoa_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepasseParaPessoa" ADD CONSTRAINT "RepasseParaPessoa_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Contrato de métricas v1 (19/10/2026) — docs/04-contrato-de-metricas.md
--
-- A porta de leitura do banco central da Seahub (o `seahub-sync` busca daqui).
-- Só views, num schema próprio, e um papel que só lê esse schema. O que muda
-- nas tabelas internas é absorvido AQUI, nas views: a porta não quebra.
-- Mudança no contrato só ACRESCENTA (coluna no fim, view nova). Quebrar exige
-- um `metricas_v2` ao lado, e o v1 continua até quem lê migrar.
-- ===========================================================================

-- A data de atualização da pesquisa nasce igual à última coisa que já aconteceu
-- com ela, e não "agora": senão a primeira sincronização veria tudo alterado hoje.
UPDATE "PesquisaNps"
SET "atualizadaEm" = GREATEST("criadaEm", "enviadaEm", "lembreteEm", "respondidaEm", "ultimaMensagemEm", "finalizadaEm");

-- O histórico de repasses começa hoje. Do passado só se sabe o ÚLTIMO repasse de
-- cada conversa (`Conversation.handoffAt`): ele entra como reconstruído, com o
-- caminho deduzido do começo do motivo. A transferência grava o motivo escrito
-- pelo modelo, sem prefixo, e cai em NAO_IDENTIFICADO. Conversa marcada como
-- humana por estar resolvida ou adiada não é repasse a ninguém, e fica de fora.
INSERT INTO "RepasseParaPessoa" ("id", "conversationId", "chatwootConversationId", "agentId", "caminho", "reconstruido", "criadoEm")
SELECT
  'reconstruido_' || c."id",
  c."id",
  c."chatwootConversationId",
  c."agentId",
  (CASE
    WHEN c."handoffReason" LIKE 'atribuído a %' THEN 'ATRIBUICAO_DIRETA'
    WHEN c."handoffReason" LIKE 'rodízio %' THEN 'RODIZIO'
    WHEN c."handoffReason" LIKE 'vigia: cliente esperou%' THEN 'VIGIA_DE_ESPERA'
    WHEN c."handoffReason" LIKE 'vigia:%' THEN 'PESSOA_ASSUMIU'
    WHEN c."handoffReason" LIKE 'equipe de agentes%' THEN 'EQUIPE_DE_AGENTES'
    WHEN c."handoffReason" LIKE 'prazo vencido, mas%' THEN 'PESSOA_ASSUMIU'
    WHEN c."handoffReason" LIKE 'prazo vencido%' THEN 'PRAZO_VENCIDO'
    WHEN c."handoffReason" LIKE 'presente de aniversário%' THEN 'PRESENTE_DE_ANIVERSARIO'
    WHEN c."handoffReason" IN ('conversa atribuída a um humano', 'assumida no Chatwoot', 'assumida por uma pessoa') THEN 'PESSOA_ASSUMIU'
    ELSE 'NAO_IDENTIFICADO'
  END)::"CaminhoDoRepasse",
  true,
  c."handoffAt"
FROM "Conversation" c
WHERE c."handoffAt" IS NOT NULL
  AND c."handoffReason" IS DISTINCT FROM 'conversa resolvida'
  AND COALESCE(c."handoffReason", '') NOT LIKE 'conversa em status %';

-- ---------------------------------------------------------------------------
-- Exclusões visíveis: toda linha apagada de uma tabela do contrato vira um
-- registro em "ExclusaoDeRegistro" (excluir um agente leva junto as execuções).
-- A função mora fora do schema do contrato: o papel de leitura não a enxerga.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS metricas_interno;
COMMENT ON SCHEMA metricas_interno IS 'Peças internas do contrato de métricas (gatilhos de exclusão). Fora do alcance do papel de leitura.';

CREATE OR REPLACE FUNCTION metricas_interno.registrar_exclusao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public."ExclusaoDeRegistro" ("entidade", "registroId", "excluidoEm")
  VALUES (TG_ARGV[0], OLD."id"::text, now() AT TIME ZONE 'UTC');
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION metricas_interno.registrar_exclusao() FROM PUBLIC;

CREATE TRIGGER metricas_exclusao AFTER DELETE ON "Agent" FOR EACH ROW EXECUTE FUNCTION metricas_interno.registrar_exclusao('agentes');
CREATE TRIGGER metricas_exclusao AFTER DELETE ON "AgentRun" FOR EACH ROW EXECUTE FUNCTION metricas_interno.registrar_exclusao('execucoes');
CREATE TRIGGER metricas_exclusao AFTER DELETE ON "ToolCall" FOR EACH ROW EXECUTE FUNCTION metricas_interno.registrar_exclusao('chamadas_de_ferramenta');
CREATE TRIGGER metricas_exclusao AFTER DELETE ON "Conversation" FOR EACH ROW EXECUTE FUNCTION metricas_interno.registrar_exclusao('conversas');
CREATE TRIGGER metricas_exclusao AFTER DELETE ON "RepasseParaPessoa" FOR EACH ROW EXECUTE FUNCTION metricas_interno.registrar_exclusao('repasses_para_pessoas');
CREATE TRIGGER metricas_exclusao AFTER DELETE ON "AgentHandoff" FOR EACH ROW EXECUTE FUNCTION metricas_interno.registrar_exclusao('repasses_entre_agentes');
CREATE TRIGGER metricas_exclusao AFTER DELETE ON "PesquisaNps" FOR EACH ROW EXECUTE FUNCTION metricas_interno.registrar_exclusao('pesquisas_de_satisfacao');
CREATE TRIGGER metricas_exclusao AFTER DELETE ON "NotaFiscalEmitida" FOR EACH ROW EXECUTE FUNCTION metricas_interno.registrar_exclusao('notas_fiscais');
CREATE TRIGGER metricas_exclusao AFTER DELETE ON "MediaAnalysis" FOR EACH ROW EXECUTE FUNCTION metricas_interno.registrar_exclusao('leituras_de_midia');

-- ---------------------------------------------------------------------------
-- As views. Toda data sai em UTC (timestamptz); todo id é o id estável da linha;
-- toda view tem `atualizado_em` para a busca incremental. Dados desde
-- 31/07/2026 00:00 em São Paulo (03:00 UTC), o início da produção.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS metricas_v1;
COMMENT ON SCHEMA metricas_v1 IS 'Contrato de métricas dos agentes, versão 1. Só leitura, só métricas: nenhum texto de conversa, credencial, telefone ou e-mail. Mudanças só aditivas; quebra vira metricas_v2. Documentação: docs/04-contrato-de-metricas.md no repositório agentes-chatwoot.';

CREATE VIEW metricas_v1.sobre AS
SELECT '1.0.0'::text AS versao,
       TIMESTAMPTZ '2026-10-19 00:00:00+00' AS publicada_em,
       TIMESTAMPTZ '2026-07-31 03:00:00+00' AS dados_desde;
COMMENT ON VIEW metricas_v1.sobre IS 'Versão do contrato. A versão menor sobe a cada acréscimo; a maior só num schema novo.';
COMMENT ON COLUMN metricas_v1.sobre.versao IS 'Versão semântica do contrato.';
COMMENT ON COLUMN metricas_v1.sobre.publicada_em IS 'Quando esta versão do contrato foi publicada (UTC).';
COMMENT ON COLUMN metricas_v1.sobre.dados_desde IS 'Início da produção: nada anterior a isto aparece nas views (UTC).';

CREATE VIEW metricas_v1.agentes AS
SELECT a."id" AS id,
       a."key" AS chave,
       a."name" AS nome,
       a."active" AS ligado,
       a."archivedAt" AT TIME ZONE 'UTC' AS arquivado_em,
       a."createdAt" AT TIME ZONE 'UTC' AS criado_em,
       a."updatedAt" AT TIME ZONE 'UTC' AS atualizado_em
FROM public."Agent" a;
COMMENT ON VIEW metricas_v1.agentes IS 'Os agentes de I.A., para dar nome aos ids das outras views.';
COMMENT ON COLUMN metricas_v1.agentes.id IS 'Id estável do agente.';
COMMENT ON COLUMN metricas_v1.agentes.chave IS 'Chave do agente (não muda quando ele é renomeado).';
COMMENT ON COLUMN metricas_v1.agentes.nome IS 'Nome atual do agente no painel.';
COMMENT ON COLUMN metricas_v1.agentes.ligado IS 'Se o agente está ligado agora.';
COMMENT ON COLUMN metricas_v1.agentes.arquivado_em IS 'Quando saiu de circulação; nulo se não foi arquivado (UTC).';
COMMENT ON COLUMN metricas_v1.agentes.criado_em IS 'Criação do agente (UTC).';
COMMENT ON COLUMN metricas_v1.agentes.atualizado_em IS 'Última alteração do agente (UTC).';

CREATE VIEW metricas_v1.execucoes AS
SELECT r."id" AS id,
       r."agentId" AS agente_id,
       a."name" AS agente_nome,
       c."chatwootConversationId" AS conversa_chatwoot_id,
       CASE r."source"
         WHEN 'CHATWOOT' THEN 'atendimento'
         WHEN 'PLAYGROUND' THEN 'playground'
         WHEN 'TRIGGER' THEN 'gatilho_http'
         WHEN 'SCHEDULE' THEN 'agendamento'
         WHEN 'MESA' THEN 'mesa'
         WHEN 'INTERNO' THEN 'chamada_interna'
         WHEN 'CONVERSA_ENCERRADA' THEN 'conversa_encerrada'
         WHEN 'CONVERSA_MARCADA' THEN 'conversa_marcada'
         WHEN 'CONVERSA_PARADA' THEN 'conversa_parada'
         ELSE lower(r."source"::text)
       END AS origem,
       (r."source" = 'PLAYGROUND') AS eh_teste,
       CASE r."status"
         WHEN 'RUNNING' THEN 'em_andamento'
         WHEN 'SUCCESS' THEN 'sucesso'
         WHEN 'ERROR' THEN 'erro'
         WHEN 'CANCELED' THEN 'interrompida'
         ELSE lower(r."status"::text)
       END AS status,
       r."model" AS modelo,
       CASE COALESCE(r."motor"::text, 'OPENROUTER')
         WHEN 'OPENROUTER' THEN 'openrouter'
         WHEN 'CLAUDE_MAX' THEN 'claude_max'
         ELSE lower(r."motor"::text)
       END AS motor,
       (r."voltaDoProxy" IS NOT NULL) AS voltou_para_openrouter,
       r."inputTokens" AS tokens_entrada,
       r."outputTokens" AS tokens_saida,
       r."cacheReadTokens" AS tokens_cache_leitura,
       r."cacheCreationTokens" AS tokens_cache_escrita,
       CASE WHEN r."motor" = 'CLAUDE_MAX' THEN NULL ELSE r."costUsd" END AS custo_usd,
       r."latencyMs" AS latencia_ms,
       r."iterations" AS iteracoes,
       CASE
         WHEN r."status" = 'CANCELED' THEN 'interrompida'
         WHEN r."error" IS NULL AND r."status" = 'ERROR' THEN 'outro'
         WHEN r."error" IS NULL THEN NULL
         WHEN r."error" LIKE '[sem crédito na OpenRouter]%' OR (r."error" LIKE '%402%' AND r."error" ILIKE '%credit%') THEN 'sem_credito'
         WHEN r."error" LIKE 'Encerrada automaticamente%' THEN 'encerrada_por_inatividade'
         WHEN r."error" ~* '(terminated|timeout|timed out|econn|socket|fetch failed|network|aborted)' THEN 'conexao'
         ELSE 'outro'
       END AS categoria_do_erro,
       r."createdAt" AT TIME ZONE 'UTC' AS criada_em,
       r."finishedAt" AT TIME ZONE 'UTC' AS finalizada_em,
       GREATEST(r."createdAt", r."finishedAt") AT TIME ZONE 'UTC' AS atualizado_em
FROM public."AgentRun" r
JOIN public."Agent" a ON a."id" = r."agentId"
LEFT JOIN public."Conversation" c ON c."id" = r."conversationId"
WHERE r."createdAt" >= TIMESTAMP '2026-07-31 03:00:00';
COMMENT ON VIEW metricas_v1.execucoes IS 'Cada turno de um agente: uso, custo, tempo e desfecho. Sem entrada, saída nem mensagens.';
COMMENT ON COLUMN metricas_v1.execucoes.id IS 'Id estável da execução.';
COMMENT ON COLUMN metricas_v1.execucoes.agente_id IS 'Agente que pensou neste turno (metricas_v1.agentes.id).';
COMMENT ON COLUMN metricas_v1.execucoes.agente_nome IS 'Nome ATUAL do agente (muda se ele for renomeado; para juntar, use agente_id).';
COMMENT ON COLUMN metricas_v1.execucoes.conversa_chatwoot_id IS 'Id da conversa no Chatwoot; nulo fora de conversa (gatilho, agendamento, mesa, playground).';
COMMENT ON COLUMN metricas_v1.execucoes.origem IS 'De onde veio o turno: atendimento (mensagem de cliente no Chatwoot: WhatsApp, Instagram), playground, gatilho_http, agendamento, mesa, chamada_interna, conversa_encerrada, conversa_marcada ou conversa_parada.';
COMMENT ON COLUMN metricas_v1.execucoes.eh_teste IS 'Verdadeiro no playground: teste da equipe, sem cliente.';
COMMENT ON COLUMN metricas_v1.execucoes.status IS 'em_andamento, sucesso, erro ou interrompida (parada pelo painel).';
COMMENT ON COLUMN metricas_v1.execucoes.modelo IS 'Modelo que respondeu, congelado na execução (slug da OpenRouter; claude-max/... no proxy). Nulo em parte do histórico antigo.';
COMMENT ON COLUMN metricas_v1.execucoes.motor IS 'openrouter ou claude_max. Antes de 21/09/2026 só existia a OpenRouter.';
COMMENT ON COLUMN metricas_v1.execucoes.voltou_para_openrouter IS 'O turno começou no Claude Max, falhou lá e terminou na OpenRouter.';
COMMENT ON COLUMN metricas_v1.execucoes.tokens_entrada IS 'Tokens de entrada somados no turno.';
COMMENT ON COLUMN metricas_v1.execucoes.tokens_saida IS 'Tokens de saída somados no turno.';
COMMENT ON COLUMN metricas_v1.execucoes.tokens_cache_leitura IS 'Tokens lidos do cache do prompt.';
COMMENT ON COLUMN metricas_v1.execucoes.tokens_cache_escrita IS 'Tokens gravados no cache do prompt.';
COMMENT ON COLUMN metricas_v1.execucoes.custo_usd IS 'Custo real cobrado pela OpenRouter, em dólar. Nulo no motor claude_max (a assinatura não cobra por turno).';
COMMENT ON COLUMN metricas_v1.execucoes.latencia_ms IS 'Duração do turno inteiro, em milissegundos.';
COMMENT ON COLUMN metricas_v1.execucoes.iteracoes IS 'Idas ao modelo no turno.';
COMMENT ON COLUMN metricas_v1.execucoes.categoria_do_erro IS 'Nulo sem erro; senão sem_credito, encerrada_por_inatividade, conexao, interrompida ou outro. O texto do erro fica fora do contrato.';
COMMENT ON COLUMN metricas_v1.execucoes.criada_em IS 'Início do turno (UTC).';
COMMENT ON COLUMN metricas_v1.execucoes.finalizada_em IS 'Fim do turno; nulo enquanto roda (UTC).';
COMMENT ON COLUMN metricas_v1.execucoes.atualizado_em IS 'Última alteração (UTC). A execução só muda até terminar: é o fim, ou o início enquanto roda.';

CREATE VIEW metricas_v1.chamadas_de_ferramenta AS
SELECT t."id" AS id,
       t."runId" AS execucao_id,
       t."toolName" AS ferramenta,
       lower(t."provider"::text) AS integracao,
       t."isError" AS deu_erro,
       t."durationMs" AS duracao_ms,
       t."createdAt" AT TIME ZONE 'UTC' AS criada_em,
       t."createdAt" AT TIME ZONE 'UTC' AS atualizado_em
FROM public."ToolCall" t
WHERE t."createdAt" >= TIMESTAMP '2026-07-31 03:00:00';
COMMENT ON VIEW metricas_v1.chamadas_de_ferramenta IS 'Cada ferramenta que um agente usou num turno. Sem parâmetros nem retorno.';
COMMENT ON COLUMN metricas_v1.chamadas_de_ferramenta.id IS 'Id estável da chamada.';
COMMENT ON COLUMN metricas_v1.chamadas_de_ferramenta.execucao_id IS 'A execução do turno (metricas_v1.execucoes.id).';
COMMENT ON COLUMN metricas_v1.chamadas_de_ferramenta.ferramenta IS 'Nome da ferramenta (ex.: conexa_criar_reserva).';
COMMENT ON COLUMN metricas_v1.chamadas_de_ferramenta.integracao IS 'Integração da ferramenta (chatwoot, clickup, conexa...); nulo nas internas.';
COMMENT ON COLUMN metricas_v1.chamadas_de_ferramenta.deu_erro IS 'A ferramenta falhou.';
COMMENT ON COLUMN metricas_v1.chamadas_de_ferramenta.duracao_ms IS 'Duração da chamada, em milissegundos.';
COMMENT ON COLUMN metricas_v1.chamadas_de_ferramenta.criada_em IS 'Quando a chamada terminou e foi gravada (UTC).';
COMMENT ON COLUMN metricas_v1.chamadas_de_ferramenta.atualizado_em IS 'Igual a criada_em: a chamada não muda depois de gravada (UTC).';

CREATE VIEW metricas_v1.conversas AS
SELECT c."id" AS id,
       c."chatwootConversationId" AS conversa_chatwoot_id,
       c."chatwootInboxId" AS caixa_chatwoot_id,
       c."portaAgentId" AS agente_entrada_id,
       c."agentId" AS agente_atual_id,
       CASE c."status"
         WHEN 'BOT' THEN 'agente'
         WHEN 'HUMAN' THEN 'pessoa'
         WHEN 'CLOSED' THEN 'resolvida'
         ELSE lower(c."status"::text)
       END AS status,
       c."createdAt" AT TIME ZONE 'UTC' AS criada_em,
       c."resolvidaEm" AT TIME ZONE 'UTC' AS resolvida_em,
       c."aguardandoDesde" AT TIME ZONE 'UTC' AS aguardando_desde,
       c."handoffAt" AT TIME ZONE 'UTC' AS ultimo_repasse_em,
       c."lastMessageAt" AT TIME ZONE 'UTC' AS ultima_mensagem_em,
       c."updatedAt" AT TIME ZONE 'UTC' AS atualizado_em
FROM public."Conversation" c
WHERE c."createdAt" >= TIMESTAMP '2026-07-31 03:00:00';
COMMENT ON VIEW metricas_v1.conversas IS 'As conversas do Chatwoot que passaram pelos agentes, no estado em que o sistema as vê. Sem dados do contato.';
COMMENT ON COLUMN metricas_v1.conversas.id IS 'Id estável da conversa no sistema de agentes.';
COMMENT ON COLUMN metricas_v1.conversas.conversa_chatwoot_id IS 'Id da conversa no Chatwoot (a chave para juntar com os dados do Chatwoot).';
COMMENT ON COLUMN metricas_v1.conversas.caixa_chatwoot_id IS 'Caixa de entrada no Chatwoot.';
COMMENT ON COLUMN metricas_v1.conversas.agente_entrada_id IS 'O agente da porta: o robô da caixa pelo qual a conversa entrou.';
COMMENT ON COLUMN metricas_v1.conversas.agente_atual_id IS 'O agente dono da conversa agora (muda nas transferências entre agentes).';
COMMENT ON COLUMN metricas_v1.conversas.status IS 'agente (o robô atende), pessoa (com alguém da equipe) ou resolvida.';
COMMENT ON COLUMN metricas_v1.conversas.criada_em IS 'Primeira vez que a conversa chegou ao sistema (UTC).';
COMMENT ON COLUMN metricas_v1.conversas.resolvida_em IS 'Última resolução vista; nulo se nunca foi resolvida (UTC).';
COMMENT ON COLUMN metricas_v1.conversas.aguardando_desde IS 'Desde quando o cliente espera resposta do robô; nulo se ninguém espera (UTC).';
COMMENT ON COLUMN metricas_v1.conversas.ultimo_repasse_em IS 'Último repasse a uma pessoa; o histórico está em repasses_para_pessoas (UTC).';
COMMENT ON COLUMN metricas_v1.conversas.ultima_mensagem_em IS 'Última mensagem enviada pelo agente nesta conversa (UTC).';
COMMENT ON COLUMN metricas_v1.conversas.atualizado_em IS 'Última alteração da linha (UTC).';

CREATE VIEW metricas_v1.repasses_para_pessoas AS
SELECT p."id" AS id,
       p."chatwootConversationId" AS conversa_chatwoot_id,
       p."agentId" AS agente_id,
       lower(p."caminho"::text) AS caminho,
       p."reconstruido" AS reconstruido,
       p."criadoEm" AT TIME ZONE 'UTC' AS ocorrido_em,
       p."criadoEm" AT TIME ZONE 'UTC' AS atualizado_em
FROM public."RepasseParaPessoa" p
WHERE p."criadoEm" >= TIMESTAMP '2026-07-31 03:00:00';
COMMENT ON VIEW metricas_v1.repasses_para_pessoas IS 'Cada passagem da conversa para uma pessoa da equipe, como evento. Histórico completo desde 19/10/2026; antes disso, só o último repasse de cada conversa (reconstruido = true).';
COMMENT ON COLUMN metricas_v1.repasses_para_pessoas.id IS 'Id estável do repasse.';
COMMENT ON COLUMN metricas_v1.repasses_para_pessoas.conversa_chatwoot_id IS 'Id da conversa no Chatwoot.';
COMMENT ON COLUMN metricas_v1.repasses_para_pessoas.agente_id IS 'Agente dono da conversa no momento do repasse.';
COMMENT ON COLUMN metricas_v1.repasses_para_pessoas.caminho IS 'rodizio, atribuicao_direta ou transferencia (ferramentas do agente); vigia_de_espera (cliente esperou demais); prazo_vencido (venceu um prazo registrado pelo agente: a pessoa não respondeu e a conversa passou a outra, ou o cliente sumiu e a conversa foi atribuída); equipe_de_agentes (as travas da equipe de agentes); pessoa_assumiu (alguém assumiu no Chatwoot); presente_de_aniversario; nao_identificado (só em reconstruído).';
COMMENT ON COLUMN metricas_v1.repasses_para_pessoas.reconstruido IS 'Deduzido do último repasse gravado antes de existir o histórico (19/10/2026).';
COMMENT ON COLUMN metricas_v1.repasses_para_pessoas.ocorrido_em IS 'Quando a conversa passou para a pessoa (UTC).';
COMMENT ON COLUMN metricas_v1.repasses_para_pessoas.atualizado_em IS 'Igual a ocorrido_em: o evento não muda (UTC).';

CREATE VIEW metricas_v1.repasses_entre_agentes AS
SELECT h."id" AS id,
       c."chatwootConversationId" AS conversa_chatwoot_id,
       h."fromAgentId" AS agente_origem_id,
       h."toAgentId" AS agente_destino_id,
       h."createdAt" AT TIME ZONE 'UTC' AS ocorrido_em,
       h."createdAt" AT TIME ZONE 'UTC' AS atualizado_em
FROM public."AgentHandoff" h
JOIN public."Conversation" c ON c."id" = h."conversationId"
WHERE h."createdAt" >= TIMESTAMP '2026-07-31 03:00:00';
COMMENT ON VIEW metricas_v1.repasses_entre_agentes IS 'Cada transferência da conversa de um agente para outro. Sem motivo, resumo nem aviso.';
COMMENT ON COLUMN metricas_v1.repasses_entre_agentes.id IS 'Id estável da transferência.';
COMMENT ON COLUMN metricas_v1.repasses_entre_agentes.conversa_chatwoot_id IS 'Id da conversa no Chatwoot.';
COMMENT ON COLUMN metricas_v1.repasses_entre_agentes.agente_origem_id IS 'Agente que passou; nulo quando quem passou foi o sistema.';
COMMENT ON COLUMN metricas_v1.repasses_entre_agentes.agente_destino_id IS 'Agente que recebeu.';
COMMENT ON COLUMN metricas_v1.repasses_entre_agentes.ocorrido_em IS 'Quando a transferência aconteceu (UTC).';
COMMENT ON COLUMN metricas_v1.repasses_entre_agentes.atualizado_em IS 'Igual a ocorrido_em: o evento não muda (UTC).';

CREATE VIEW metricas_v1.pesquisas_de_satisfacao AS
SELECT p."id" AS id,
       p."chatwootConversationId" AS conversa_chatwoot_id,
       p."inboxId" AS caixa_chatwoot_id,
       p."portaAgentId" AS agente_id,
       lower(p."status"::text) AS situacao,
       p."nota" AS nota,
       p."marcadaEm" AT TIME ZONE 'UTC' AS marcada_em,
       p."enviadaEm" AT TIME ZONE 'UTC' AS enviada_em,
       p."respondidaEm" AT TIME ZONE 'UTC' AS respondida_em,
       p."finalizadaEm" AT TIME ZONE 'UTC' AS finalizada_em,
       p."atualizadaEm" AT TIME ZONE 'UTC' AS atualizado_em
FROM public."PesquisaNps" p
WHERE p."criadaEm" >= TIMESTAMP '2026-07-31 03:00:00';
COMMENT ON VIEW metricas_v1.pesquisas_de_satisfacao IS 'A pesquisa de satisfação (NPS) mandada pelo sistema. Sem telefone e sem texto.';
COMMENT ON COLUMN metricas_v1.pesquisas_de_satisfacao.id IS 'Id estável da pesquisa.';
COMMENT ON COLUMN metricas_v1.pesquisas_de_satisfacao.conversa_chatwoot_id IS 'Id da conversa no Chatwoot.';
COMMENT ON COLUMN metricas_v1.pesquisas_de_satisfacao.caixa_chatwoot_id IS 'Caixa de entrada no Chatwoot.';
COMMENT ON COLUMN metricas_v1.pesquisas_de_satisfacao.agente_id IS 'O agente da porta (o robô da caixa) que mandou a pesquisa.';
COMMENT ON COLUMN metricas_v1.pesquisas_de_satisfacao.situacao IS 'agendada, aguardando, lembrada, respondida, agradecida, concluida, expirada, cancelada ou falhou.';
COMMENT ON COLUMN metricas_v1.pesquisas_de_satisfacao.nota IS 'Nota de 1 a 5; nulo sem resposta válida.';
COMMENT ON COLUMN metricas_v1.pesquisas_de_satisfacao.marcada_em IS 'Quando a equipe pediu a pesquisa (UTC).';
COMMENT ON COLUMN metricas_v1.pesquisas_de_satisfacao.enviada_em IS 'Quando a pesquisa saiu para o cliente (UTC).';
COMMENT ON COLUMN metricas_v1.pesquisas_de_satisfacao.respondida_em IS 'Quando a nota chegou (UTC).';
COMMENT ON COLUMN metricas_v1.pesquisas_de_satisfacao.finalizada_em IS 'Quando a pesquisa terminou, de qualquer jeito (UTC).';
COMMENT ON COLUMN metricas_v1.pesquisas_de_satisfacao.atualizado_em IS 'Última alteração (UTC).';

CREATE VIEW metricas_v1.notas_fiscais AS
SELECT n."id" AS id,
       n."cobrancaId" AS cobranca_id_conexa,
       cf."clienteId" AS cliente_id_conexa,
       n."empresa" AS empresa_emissora,
       n."codigo" AS codigo_servico,
       n."competencia" AS competencia,
       lower(n."situacao"::text) AS situacao,
       n."numero" AS numero,
       n."valorCentavos" AS valor_centavos,
       (n."valorCentavos"::numeric / 100) AS valor,
       COALESCE(n."motivo" LIKE 'emitida pelo n8n%', false) AS emitida_pelo_n8n,
       n."enviadaEm" AT TIME ZONE 'UTC' AS enviada_em,
       n."criadaEm" AT TIME ZONE 'UTC' AS criada_em,
       n."atualizadaEm" AT TIME ZONE 'UTC' AS atualizado_em
FROM public."NotaFiscalEmitida" n
LEFT JOIN public."CobrancaFiscal" cf ON cf."cobrancaId" = n."cobrancaId"
WHERE n."criadaEm" >= TIMESTAMP '2026-07-31 03:00:00';
COMMENT ON VIEW metricas_v1.notas_fiscais IS 'Notas fiscais de serviço emitidas (ou tentadas) pelo sistema na Spedy, uma por código de serviço. Do tomador, só o id do cliente no Conexa.';
COMMENT ON COLUMN metricas_v1.notas_fiscais.id IS 'Id estável da nota no sistema.';
COMMENT ON COLUMN metricas_v1.notas_fiscais.cobranca_id_conexa IS 'Id da cobrança no Conexa.';
COMMENT ON COLUMN metricas_v1.notas_fiscais.cliente_id_conexa IS 'Id do cliente no Conexa; nulo se a cobrança não passou pela leitura de notas.';
COMMENT ON COLUMN metricas_v1.notas_fiscais.empresa_emissora IS 'Empresa que emite: SEAHUB ou SEATECH.';
COMMENT ON COLUMN metricas_v1.notas_fiscais.codigo_servico IS 'Código de serviço da nota (ex.: 03.03.02).';
COMMENT ON COLUMN metricas_v1.notas_fiscais.competencia IS 'Mês de competência, AAAA-MM.';
COMMENT ON COLUMN metricas_v1.notas_fiscais.situacao IS 'reservada, enviada, autorizada, rejeitada, falhou, incerta ou cancelada.';
COMMENT ON COLUMN metricas_v1.notas_fiscais.numero IS 'Número da NFS-e na prefeitura; nulo até ser autorizada.';
COMMENT ON COLUMN metricas_v1.notas_fiscais.valor_centavos IS 'Valor da nota, em centavos (exato).';
COMMENT ON COLUMN metricas_v1.notas_fiscais.valor IS 'Valor da nota, em reais.';
COMMENT ON COLUMN metricas_v1.notas_fiscais.emitida_pelo_n8n IS 'Nota que o fluxo antigo do n8n emitiu no dia do corte, registrada aqui só para não sair em dobro.';
COMMENT ON COLUMN metricas_v1.notas_fiscais.enviada_em IS 'Último envio à Spedy (UTC).';
COMMENT ON COLUMN metricas_v1.notas_fiscais.criada_em IS 'Quando a nota foi reservada no sistema (UTC).';
COMMENT ON COLUMN metricas_v1.notas_fiscais.atualizado_em IS 'Última alteração (UTC).';

CREATE VIEW metricas_v1.leituras_de_midia AS
SELECT m."id" AS id,
       lower(m."kind"::text) AS tipo,
       lower(m."status"::text) AS situacao,
       CASE
         WHEN m."chave" LIKE 'mesa:%' THEN 'mesa'
         WHEN m."chave" LIKE 'drive:%' THEN 'drive'
         WHEN m."chave" LIKE 'clickup:%' THEN 'clickup'
         ELSE 'conversa'
       END AS origem,
       m."model" AS modelo,
       m."inputTokens" AS tokens_entrada,
       m."outputTokens" AS tokens_saida,
       m."segundosDeAudio" AS segundos_de_audio,
       m."duracaoMs" AS duracao_ms,
       m."agentId" AS agente_id,
       c."chatwootConversationId" AS conversa_chatwoot_id,
       m."createdAt" AT TIME ZONE 'UTC' AS criada_em,
       m."updatedAt" AT TIME ZONE 'UTC' AS atualizado_em
FROM public."MediaAnalysis" m
LEFT JOIN public."Conversation" c ON c."id" = m."conversationId"
WHERE m."createdAt" >= TIMESTAMP '2026-07-31 03:00:00';
COMMENT ON VIEW metricas_v1.leituras_de_midia IS 'Cada áudio, imagem ou documento lido pela OpenAI (fatura separada da OpenRouter). Sem nome de arquivo nem texto extraído.';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.id IS 'Id estável da leitura.';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.tipo IS 'image, audio, document ou unsupported (vídeo, localização e o que não se lê).';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.situacao IS 'ok, skipped (não lido de propósito, sem custo) ou error.';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.origem IS 'conversa (anexo do cliente), mesa, drive ou clickup.';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.modelo IS 'Modelo da OpenAI que leu.';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.tokens_entrada IS 'Tokens de entrada da leitura.';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.tokens_saida IS 'Tokens de saída da leitura.';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.segundos_de_audio IS 'Duração do áudio transcrito, em segundos.';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.duracao_ms IS 'Quanto a leitura levou, em milissegundos.';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.agente_id IS 'Agente em cujo atendimento a mídia foi lida.';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.conversa_chatwoot_id IS 'Id da conversa no Chatwoot; nulo fora de conversa.';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.criada_em IS 'Primeira leitura (UTC).';
COMMENT ON COLUMN metricas_v1.leituras_de_midia.atualizado_em IS 'Última alteração, inclusive nova tentativa (UTC).';

CREATE VIEW metricas_v1.exclusoes AS
SELECT e."id" AS id,
       e."entidade" AS entidade,
       e."registroId" AS registro_id,
       e."excluidoEm" AT TIME ZONE 'UTC' AS excluido_em,
       e."excluidoEm" AT TIME ZONE 'UTC' AS atualizado_em
FROM public."ExclusaoDeRegistro" e;
COMMENT ON VIEW metricas_v1.exclusoes IS 'Linhas que saíram das outras views porque foram apagadas (ex.: um agente excluído leva as execuções dele). Registro desde 19/10/2026.';
COMMENT ON COLUMN metricas_v1.exclusoes.id IS 'Id sequencial da exclusão.';
COMMENT ON COLUMN metricas_v1.exclusoes.entidade IS 'Nome da view de onde a linha saiu (agentes, execucoes, chamadas_de_ferramenta, conversas...).';
COMMENT ON COLUMN metricas_v1.exclusoes.registro_id IS 'O id que a linha tinha naquela view.';
COMMENT ON COLUMN metricas_v1.exclusoes.excluido_em IS 'Quando foi apagada (UTC).';
COMMENT ON COLUMN metricas_v1.exclusoes.atualizado_em IS 'Igual a excluido_em (UTC).';

-- ---------------------------------------------------------------------------
-- O papel de leitura. Nasce SEM login: a senha é dada fora do repositório
-- (ALTER ROLE metricas_leitor LOGIN PASSWORD ...), e revogar é NOLOGIN.
-- Só lê o schema do contrato, sempre em transação somente leitura.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metricas_leitor') THEN
    CREATE ROLE metricas_leitor NOLOGIN;
  END IF;
END
$$;
COMMENT ON ROLE metricas_leitor IS 'Leitor do contrato de métricas (banco central da Seahub). Só SELECT no schema metricas_v1.';
ALTER ROLE metricas_leitor SET default_transaction_read_only = on;
ALTER ROLE metricas_leitor SET statement_timeout = '60s';
ALTER ROLE metricas_leitor CONNECTION LIMIT 5;
GRANT USAGE ON SCHEMA metricas_v1 TO metricas_leitor;
GRANT SELECT ON ALL TABLES IN SCHEMA metricas_v1 TO metricas_leitor;
ALTER DEFAULT PRIVILEGES IN SCHEMA metricas_v1 GRANT SELECT ON TABLES TO metricas_leitor;

-- Nem tabela temporária: o papel liga de volta a escrita na própria sessão se
-- quiser (default_transaction_read_only é só o padrão), e aí o que segura é a
-- falta de permissão. Tabela temporária é a única escrita que o PUBLIC tem por
-- padrão. Quem roda a migration (o dono das tabelas) continua com ela.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO CURRENT_USER', current_database());
END
$$;
