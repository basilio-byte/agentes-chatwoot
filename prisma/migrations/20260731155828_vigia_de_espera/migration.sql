-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "fallbackAtendente" TEXT,
ADD COLUMN     "fallbackMinutos" INTEGER;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "aguardandoDesde" TIMESTAMP(3),
ADD COLUMN     "portaAgentId" TEXT;
