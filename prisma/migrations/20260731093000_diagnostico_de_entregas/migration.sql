-- Rastro do que aconteceu com cada entrega de webhook.
-- Nulas de propósito: as linhas antigas não têm como saber o desfecho.
ALTER TABLE "WebhookEvent" ADD COLUMN "resultado" TEXT;
ALTER TABLE "WebhookEvent" ADD COLUMN "detalhe" TEXT;

CREATE INDEX "WebhookEvent_agentId_createdAt_idx"
  ON "WebhookEvent"("agentId", "createdAt" DESC);
