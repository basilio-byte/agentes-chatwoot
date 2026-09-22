-- Cria a linha de Integration do presente de aniversário, DESLIGADA.
--
-- Em migration separada da que cria o valor 'ANIVERSARIO': o Postgres não
-- deixa usar um valor de enum na mesma transação em que ele foi acrescentado.
-- Mesmo motivo das linhas de Prazos e Materiais: o seed não roda em produção e
-- o bootstrap só age enquanto não existe usuário nenhum.
INSERT INTO "Integration" ("id", "provider", "label", "config", "enabled", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'ANIVERSARIO', 'Presente de aniversário', '{}'::jsonb, false, 'NOT_CONFIGURED', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Integration" WHERE "provider" = 'ANIVERSARIO'
);
