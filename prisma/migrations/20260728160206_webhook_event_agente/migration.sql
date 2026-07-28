-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "agentId" TEXT;

-- CreateIndex
CREATE INDEX "WebhookEvent_agentId_idx" ON "WebhookEvent"("agentId");
