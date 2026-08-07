-- Cria a linha de Integration da ZapSign, desligada.
--
-- Não dá para deixar isso a cargo do seed nem do bootstrap: o seed não roda em
-- produção, e o bootstrap só age enquanto não existe usuário nenhum — numa
-- instalação viva ele volta na primeira linha. Sem a linha, a integração fica
-- eternamente "não configurada" e o botão de ligar nasce desabilitado.
INSERT INTO "Integration" ("id", "provider", "label", "config", "enabled", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'ZAPSIGN', 'ZapSign', '{}'::jsonb, false, 'NOT_CONFIGURED', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Integration" WHERE "provider" = 'ZAPSIGN'
);
