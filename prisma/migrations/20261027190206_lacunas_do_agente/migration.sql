-- CreateEnum
CREATE TYPE "TipoDeLacuna" AS ENUM ('FALTA_INSTRUCAO', 'FALTA_FERRAMENTA', 'NAO_ENTENDI');

-- CreateTable
CREATE TABLE "LacunaDoAgente" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "runId" TEXT,
    "chatwootConversationId" INTEGER NOT NULL,
    "tipo" "TipoDeLacuna" NOT NULL,
    "oQueFaltou" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LacunaDoAgente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LacunaDoAgente_createdAt_idx" ON "LacunaDoAgente"("createdAt");

-- CreateIndex
CREATE INDEX "LacunaDoAgente_agentId_createdAt_idx" ON "LacunaDoAgente"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "LacunaDoAgente_tipo_createdAt_idx" ON "LacunaDoAgente"("tipo", "createdAt");

-- CreateIndex
CREATE INDEX "LacunaDoAgente_runId_idx" ON "LacunaDoAgente"("runId");

-- AddForeignKey
ALTER TABLE "LacunaDoAgente" ADD CONSTRAINT "LacunaDoAgente_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
