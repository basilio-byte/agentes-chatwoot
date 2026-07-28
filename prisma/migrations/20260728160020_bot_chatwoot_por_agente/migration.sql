-- CreateTable
CREATE TABLE "AgentChatwootBot" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "botId" INTEGER,
    "botName" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentChatwootBot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentChatwootBot_agentId_key" ON "AgentChatwootBot"("agentId");

-- AddForeignKey
ALTER TABLE "AgentChatwootBot" ADD CONSTRAINT "AgentChatwootBot_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
