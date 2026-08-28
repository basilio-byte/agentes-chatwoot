-- Google Workspace entra no enum de provedores de integração.
--
-- Sozinha nesta migration de propósito: o Postgres não deixa USAR um valor de
-- enum na mesma transação que o adicionou, e a migration seguinte precisa
-- inserir a linha de Integration com ele.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'GOOGLE';
