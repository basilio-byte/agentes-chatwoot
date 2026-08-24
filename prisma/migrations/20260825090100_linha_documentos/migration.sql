-- Cria a linha de Integration da conferência de documentos, DESLIGADA.
--
-- Mesmo motivo das linhas de ZapSign e OpenAI: o seed não roda em produção e o
-- bootstrap só age enquanto não existe usuário nenhum. Sem a linha, a
-- integração fica eternamente "não configurada" e o botão de ligar nasce
-- desabilitado.
INSERT INTO "Integration" ("id", "provider", "label", "config", "enabled", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'DOCUMENTOS', 'Documentos (CPF, CNH, CNPJ)', '{}'::jsonb, false, 'NOT_CONFIGURED', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Integration" WHERE "provider" = 'DOCUMENTOS'
);
