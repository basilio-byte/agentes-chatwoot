-- AlterTable
ALTER TABLE "Agent" ALTER COLUMN "maxTokens" SET DEFAULT 16384,
ALTER COLUMN "maxToolIterations" SET DEFAULT 12;

-- Mudar o default só vale para linha nova: os agentes que já existem
-- continuariam presos em 4096/8 e a mudança pareceria não ter funcionado.
-- Sobe só quem está exatamente no default antigo — quem escolheu outro valor
-- de propósito não pode ser sobrescrito.
UPDATE "Agent" SET "maxTokens" = 16384 WHERE "maxTokens" = 4096;
UPDATE "Agent" SET "maxToolIterations" = 12 WHERE "maxToolIterations" = 8;
