-- Cria a linha de Integration do aviso de cobrança, DESLIGADA.
--
-- Em migration separada da que cria o valor 'COBRANCA': o Postgres não deixa
-- usar um valor de enum na mesma transação em que ele foi acrescentado. O seed
-- não roda em produção e o bootstrap só age enquanto não existe usuário nenhum.
INSERT INTO "Integration" ("id", "provider", "label", "config", "enabled", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'COBRANCA', 'Aviso de cobrança (ClickUp)', '{}'::jsonb, false, 'NOT_CONFIGURED', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Integration" WHERE "provider" = 'COBRANCA'
);
