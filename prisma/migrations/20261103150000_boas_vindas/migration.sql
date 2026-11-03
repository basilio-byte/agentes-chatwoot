-- Template de boas-vindas pelo WhatsApp oficial (NotificaMe), no lugar do fluxo
-- "Template Boas Vindas" do n8n. Função do sistema, sem modelo, fora do registry.
--
-- Só acrescenta um valor de provider. A linha da integração vem na migration
-- seguinte: o Postgres proíbe usar um valor de enum na mesma transação em que
-- ele foi acrescentado.

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'BOAS_VINDAS';
