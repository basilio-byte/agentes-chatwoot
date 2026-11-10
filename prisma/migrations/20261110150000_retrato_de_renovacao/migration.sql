-- CreateTable
CREATE TABLE "RetratoDeRenovacao" (
    "id" TEXT NOT NULL,
    "leva" TEXT NOT NULL,
    "contratoId" INTEGER NOT NULL,
    "clienteId" INTEGER NOT NULL,
    "valorCentavos" INTEGER NOT NULL,
    "fidelidade" TEXT NOT NULL,
    "periodicidade" TEXT,
    "reajusteEm" TEXT,
    "lidoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetratoDeRenovacao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RetratoDeRenovacao_leva_idx" ON "RetratoDeRenovacao"("leva");

-- CreateIndex
CREATE UNIQUE INDEX "RetratoDeRenovacao_leva_contratoId_key" ON "RetratoDeRenovacao"("leva", "contratoId");
