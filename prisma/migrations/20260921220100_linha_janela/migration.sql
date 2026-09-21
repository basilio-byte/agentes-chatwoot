-- Cria a linha de Integration da janela de 24 h do WhatsApp, DESLIGADA.
--
-- Em migration separada da que cria o valor 'JANELA': o Postgres não deixa usar
-- um valor de enum na mesma transação em que ele foi acrescentado. Mesmo motivo
-- da linha do NPS: o seed não roda em produção e o bootstrap só age enquanto não
-- existe usuário nenhum.
INSERT INTO "Integration" ("id", "provider", "label", "config", "enabled", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'JANELA', 'Janela de 24 h do WhatsApp', '{}'::jsonb, false, 'NOT_CONFIGURED', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Integration" WHERE "provider" = 'JANELA'
);
