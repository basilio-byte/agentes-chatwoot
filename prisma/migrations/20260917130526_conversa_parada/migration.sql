-- AlterEnum
ALTER TYPE "EventoDeConversa" ADD VALUE 'SEM_RESPOSTA';

-- AlterEnum
ALTER TYPE "RunSource" ADD VALUE 'CONVERSA_PARADA';

-- AlterTable
ALTER TABLE "GatilhoDeConversa" ADD COLUMN     "cron" TEXT,
ADD COLUMN     "horasParadas" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "tetoPorRodada" INTEGER NOT NULL DEFAULT 60;
