-- Conferência de documento entra no enum de provedores.
--
-- Sozinha nesta migration: o Postgres não deixa USAR um valor de enum na mesma
-- transação que o adicionou, e a migration seguinte insere a linha com ele.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'DOCUMENTOS';
