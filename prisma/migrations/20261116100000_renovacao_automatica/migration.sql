-- Renovacao de contratos automatica: as chaves que ligam o que o sistema faz
-- sozinho depois do reajuste (mover a tarefa para "notificacao renovacao",
-- fechar o ciclo no pagamento e avancar as datas no lugar do n8n).
-- Funcao do sistema, sem modelo, fora do registry como o NPS e a cobranca.
--
-- So acrescenta um valor de provider. A linha da integracao vem na migration
-- seguinte: o Postgres proibe usar um valor de enum na mesma transacao em que
-- ele foi acrescentado.

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'RENOVACAO';
