-- CreateEnum
CREATE TYPE "SituacaoDaLacuna" AS ENUM ('ABERTA', 'RESOLVIDA');

-- AlterTable
ALTER TABLE "LacunaDoAgente" ADD COLUMN     "resolucao" TEXT,
ADD COLUMN     "resolvidaEm" TIMESTAMP(3),
ADD COLUMN     "resolvidaPorId" TEXT,
ADD COLUMN     "resolvidaPorNome" TEXT,
ADD COLUMN     "situacao" "SituacaoDaLacuna" NOT NULL DEFAULT 'ABERTA';

-- AlterTable
ALTER TABLE "RetratoDeRenovacao" ALTER COLUMN "atualizadoEm" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "LacunaDoAgente_situacao_createdAt_idx" ON "LacunaDoAgente"("situacao", "createdAt");

-- CreateIndex
CREATE INDEX "LacunaDoAgente_situacao_resolvidaEm_idx" ON "LacunaDoAgente"("situacao", "resolvidaEm");
