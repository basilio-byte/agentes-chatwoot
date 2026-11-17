-- Duas pecas pedidas pelo Regis em 17/11/2026, na mesma migration por serem do
-- mesmo dia e so ACRESCENTAREM:
--
-- 1. PesquisaNps.agentId: a pesquisa que sai sozinha no fim de um atendimento do
--    robo (prazo do cliente com acao "pesquisa") guarda o agente que concluiu.
--    Nulo = alguem da equipe marcou o checkbox, como sempre foi.
-- 2. O provider FOLLOWUP_RESERVA. A linha da integracao vem na migration
--    seguinte: o Postgres proibe usar um valor de enum na mesma transacao em que
--    ele foi acrescentado.
--
-- Nenhuma view do contrato de metricas le colunas novas: nada muda para quem
-- consome metricas_v1.

-- AlterTable
ALTER TABLE "PesquisaNps" ADD COLUMN "agentId" TEXT;

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'FOLLOWUP_RESERVA';
