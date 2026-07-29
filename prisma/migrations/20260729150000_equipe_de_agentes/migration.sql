-- Equipe de agentes: identidade estável, roteamento e passagem de bastão.

ALTER TABLE "Agent" ADD COLUMN "key" TEXT;
ALTER TABLE "Agent" ADD COLUMN "routingDescription" TEXT;
ALTER TABLE "Agent" ADD COLUMN "isEntry" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: slug a partir do nome. Sem acento (translate), sem caractere
-- especial, sem hífen sobrando. Colisão ganha sufixo numérico pela ordem de
-- criação, para a coluna poder virar NOT NULL UNIQUE logo abaixo.
WITH base AS (
  SELECT
    "id",
    NULLIF(
      trim(BOTH '-' FROM regexp_replace(
        lower(translate(
          "name",
          'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
          'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'
        )),
        '[^a-z0-9]+', '-', 'g'
      )),
      ''
    ) AS slug,
    "createdAt"
  FROM "Agent"
),
numerado AS (
  SELECT
    "id",
    COALESCE(slug, 'agente') AS slug,
    row_number() OVER (PARTITION BY COALESCE(slug, 'agente') ORDER BY "createdAt", "id") AS n
  FROM base
)
UPDATE "Agent" a
SET "key" = CASE WHEN nu.n = 1 THEN nu.slug ELSE nu.slug || '-' || nu.n END
FROM numerado nu
WHERE a."id" = nu."id";

ALTER TABLE "Agent" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX "Agent_key_key" ON "Agent"("key");
CREATE INDEX "Agent_isEntry_idx" ON "Agent"("isEntry");

-- Só pode haver um agente de entrada. O índice parcial é a garantia real:
-- a checagem na aplicação pode perder uma corrida entre dois salvamentos.
CREATE UNIQUE INDEX "Agent_unico_de_entrada" ON "Agent"(("isEntry")) WHERE "isEntry";

-- Sem entrada definida, ninguém responde primeiro de forma determinística.
-- Elege o agente ativo mais antigo; se nenhum estiver ativo, o mais antigo.
UPDATE "Agent" SET "isEntry" = true
WHERE "id" = (
  SELECT "id" FROM "Agent"
  ORDER BY "active" DESC, "createdAt" ASC
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM "Agent" WHERE "isEntry");

-- Bastão da última passagem, na conversa.
ALTER TABLE "Conversation" ADD COLUMN "handoffParaAgentId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "handoffResumo" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "handoffMotivo" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "handoffDeNome" TEXT;

CREATE TABLE "AgentHandoff" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "fromAgentId" TEXT,
  "toAgentId" TEXT NOT NULL,
  "motivo" TEXT,
  "resumo" TEXT,
  "aviso" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentHandoff_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentHandoff_conversationId_createdAt_idx"
  ON "AgentHandoff"("conversationId", "createdAt");

ALTER TABLE "AgentHandoff" ADD CONSTRAINT "AgentHandoff_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentHandoff" ADD CONSTRAINT "AgentHandoff_fromAgentId_fkey"
  FOREIGN KEY ("fromAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentHandoff" ADD CONSTRAINT "AgentHandoff_toAgentId_fkey"
  FOREIGN KEY ("toAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_handoffParaAgentId_fkey"
  FOREIGN KEY ("handoffParaAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
