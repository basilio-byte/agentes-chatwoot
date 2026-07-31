-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "ultimaFalha" TEXT,
ADD COLUMN     "ultimaFalhaEm" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AgentIntegration_agentId_createdAt_idx" ON "AgentIntegration"("agentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AgentVersion_agentId_createdAt_idx" ON "AgentVersion"("agentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_agentId_createdAt_idx" ON "Conversation"("agentId", "createdAt" DESC);
