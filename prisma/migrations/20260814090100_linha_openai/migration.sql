-- Cria a linha de Integration da leitura de mídia, DESLIGADA.
--
-- Mesmo motivo da linha da ZapSign: o seed não roda em produção e o bootstrap
-- só age enquanto não existe usuário nenhum. Sem a linha, a integração fica
-- eternamente "não configurada" e o botão de ligar nasce desabilitado.
--
-- Nasce desligada de propósito — mesma doutrina de `Agent.active` e
-- `AgentTrigger.enabled`. Ler mídia custa dinheiro na OpenAI: só entra em
-- produção de propósito, e ainda precisa ser ligada agente a agente.
INSERT INTO "Integration" ("id", "provider", "label", "config", "enabled", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'OPENAI', 'OpenAI — leitura de mídia', '{}'::jsonb, false, 'NOT_CONFIGURED', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Integration" WHERE "provider" = 'OPENAI'
);
