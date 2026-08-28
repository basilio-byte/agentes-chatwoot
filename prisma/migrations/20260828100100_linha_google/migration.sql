-- Cria a linha de Integration do Google Workspace, desligada.
--
-- Mesmo motivo das linhas de ZapSign, OpenAI e Documentos: o seed não roda em
-- produção e o bootstrap só age enquanto não existe usuário nenhum — numa
-- instalação viva ele volta na primeira linha. Sem esta linha, a integração
-- fica eternamente "não configurada" e o botão de ligar nasce desabilitado.
--
-- Desligada, como manda a doutrina de `Integration.enabled`: cadastrar a chave
-- é uma decisão, ligar para os agentes é outra.
INSERT INTO "Integration" ("id", "provider", "label", "config", "enabled", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'GOOGLE', 'Google Workspace', '{}'::jsonb, false, 'NOT_CONFIGURED', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Integration" WHERE "provider" = 'GOOGLE'
);
