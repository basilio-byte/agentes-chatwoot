-- A tela passa a ler do banco: a leitura ao vivo do Conexa estourava o prazo de
-- 20 s do cliente (dezenas de paginas) e a tela abria com zero contratos.
-- `valorCentavos` continua sendo o valor CONGELADO da vespera do lote.

-- AlterTable
ALTER TABLE "RetratoDeRenovacao" ADD COLUMN "reajusteDoRetrato" TEXT;
ALTER TABLE "RetratoDeRenovacao" ADD COLUMN "valorAtualCentavos" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RetratoDeRenovacao" ADD COLUMN "plano" TEXT;
ALTER TABLE "RetratoDeRenovacao" ADD COLUMN "reajustePct" DOUBLE PRECISION;
ALTER TABLE "RetratoDeRenovacao" ADD COLUMN "reajusteIndice" TEXT;
ALTER TABLE "RetratoDeRenovacao" ADD COLUMN "atualizadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- O que ja foi lido vira o estado atual, e o reajuste visto no retrato sai da
-- coluna antiga: ate aqui `reajusteEm` guardava justamente isso.
UPDATE "RetratoDeRenovacao" SET "valorAtualCentavos" = "valorCentavos", "reajusteDoRetrato" = "reajusteEm";
