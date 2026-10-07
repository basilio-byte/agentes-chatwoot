-- Notas fiscais emitidas pela Spedy (incremento 2). Só acrescenta: um tipo e
-- uma tabela. Nada existente é alterado, e a emissão nasce desligada.

-- CreateEnum
CREATE TYPE "SituacaoDaNota" AS ENUM ('RESERVADA', 'ENVIADA', 'AUTORIZADA', 'REJEITADA', 'FALHOU', 'INCERTA', 'CANCELADA');

-- CreateTable
CREATE TABLE "NotaFiscalEmitida" (
    "id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "cobrancaId" INTEGER NOT NULL,
    "empresa" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "valorCentavos" INTEGER NOT NULL,
    "competencia" TEXT,
    "situacao" "SituacaoDaNota" NOT NULL,
    "spedyId" TEXT,
    "numero" INTEGER,
    "motivo" TEXT,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "enviadaEm" TIMESTAMP(3),
    "verificadaEm" TIMESTAMP(3),
    "avisadaEm" TIMESTAMP(3),
    "criadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadaEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotaFiscalEmitida_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotaFiscalEmitida_chave_key" ON "NotaFiscalEmitida"("chave");

-- CreateIndex
CREATE INDEX "NotaFiscalEmitida_situacao_atualizadaEm_idx" ON "NotaFiscalEmitida"("situacao", "atualizadaEm");

-- CreateIndex
CREATE INDEX "NotaFiscalEmitida_cobrancaId_idx" ON "NotaFiscalEmitida"("cobrancaId");
