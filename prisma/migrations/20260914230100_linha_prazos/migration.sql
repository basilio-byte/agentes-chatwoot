-- Cria a linha de Integration dos prazos da conversa, DESLIGADA.
--
-- Mesmo motivo das linhas de ZapSign, OpenAI, Documentos e Google: o seed não
-- roda em produção e o bootstrap só age enquanto não existe usuário nenhum. Sem
-- a linha, a integração não tem onde guardar o liga/desliga.
INSERT INTO "Integration" ("id", "provider", "label", "config", "enabled", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'PRAZOS', 'Prazos da conversa', '{}'::jsonb, false, 'NOT_CONFIGURED', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Integration" WHERE "provider" = 'PRAZOS'
);
