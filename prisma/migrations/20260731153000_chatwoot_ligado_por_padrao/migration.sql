-- O Chatwoot não é uma integração opcional como o ClickUp: é o canal por onde o
-- agente atende. Desligá-lo não impede o agente de responder — só tira dele as
-- ferramentas de TRANSFERÊNCIA, deixando-o sem como escalar para humano nem
-- devolver a conversa a um colega.
--
-- Até agora, só quem tinha bot ganhava o vínculo (via salvarSegredosDoBot). Com
-- o modelo de porta, o especialista não tem bot — e nascia sem poder transferir.
INSERT INTO "AgentIntegration" ("id", "agentId", "integrationId", "enabled", "allowedTools", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  a."id",
  i."id",
  true,
  ARRAY[]::text[],
  NOW(),
  NOW()
FROM "Agent" a
CROSS JOIN "Integration" i
WHERE i."provider" = 'CHATWOOT'
  AND NOT EXISTS (
    SELECT 1 FROM "AgentIntegration" ai
    WHERE ai."agentId" = a."id" AND ai."integrationId" = i."id"
  );

-- Quem já tinha o vínculo desligado por omissão (nunca foi decisão consciente,
-- porque a tela do agente só passou a existir depois) volta a poder transferir.
UPDATE "AgentIntegration" ai
SET "enabled" = true
FROM "Integration" i
WHERE ai."integrationId" = i."id"
  AND i."provider" = 'CHATWOOT'
  AND ai."enabled" = false
  AND ai."allowedTools" = ARRAY[]::text[];
