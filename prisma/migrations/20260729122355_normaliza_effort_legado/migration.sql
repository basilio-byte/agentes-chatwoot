-- Normaliza o `effort` de agentes criados antes da migração para a OpenRouter.
--
-- A lista mudou de `low/medium/high/xhigh/max` (Anthropic) para
-- `none/low/medium/high`. Só o default foi alterado na época; as linhas
-- existentes ficaram com valores que a interface não conhece mais.
--
-- O efeito era silencioso e ruim: um `<select>` com valor sem opção
-- correspondente exibe a primeira opção (`none`) e envia ela, então salvar o
-- agente gravava `none` sem ninguém ter escolhido isso.
--
-- Os dois níveis acima de `high` viram `high`; qualquer outro desconhecido vira
-- `medium`, que é o default atual.

UPDATE "Agent" SET "effort" = 'high'
WHERE lower("effort") IN ('xhigh', 'max');

UPDATE "Agent" SET "effort" = 'medium'
WHERE lower("effort") NOT IN ('none', 'low', 'medium', 'high');

-- `AgentVersion` fica como está de propósito: é registro histórico do que valia
-- naquele momento, e reescrever histórico é pior que exibir um valor antigo.
