-- Acompanhamento de contratos: do contrato gerado ate pagamento e assinatura.
-- Funcao do sistema, sem modelo, fora do registry como o NPS e a cobranca.
--
-- So acrescenta um valor de provider. A linha da integracao vem na migration
-- seguinte: o Postgres proibe usar um valor de enum na mesma transacao em que
-- ele foi acrescentado.

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'ACOMPANHAMENTO';
