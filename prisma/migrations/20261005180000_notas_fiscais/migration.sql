-- Notas fiscais (Spedy) a partir das cobranças do Conexa — no lugar dos dois
-- fluxos de emissão do n8n. Função do sistema, sem modelo, fora do registry.
--
-- Só acrescenta: um tipo novo, um valor novo de provider, uma tabela e
-- índices. A linha da integração vem na migration seguinte — o Postgres
-- proíbe usar um valor de enum na mesma transação em que foi adicionado.

-- CreateEnum
CREATE TYPE "SituacaoCobrancaFiscal" AS ENUM ('PRONTA', 'AGUARDANDO_CLASSIFICACAO', 'CONFERIR', 'FORA_DA_REGRA');

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'NOTAS_FISCAIS';

-- CreateTable
CREATE TABLE "CobrancaFiscal" (
    "id" TEXT NOT NULL,
    "cobrancaId" INTEGER NOT NULL,
    "empresaId" INTEGER NOT NULL,
    "clienteId" INTEGER NOT NULL,
    "evento" TEXT NOT NULL,
    "modo" TEXT NOT NULL,
    "quitadaEm" TEXT,
    "valorCentavos" INTEGER NOT NULL,
    "situacao" "SituacaoCobrancaFiscal" NOT NULL,
    "motivo" TEXT,
    "cobranca" JSONB NOT NULL,
    "itens" JSONB NOT NULL,
    "notas" JSONB NOT NULL,
    "observacoes" JSONB NOT NULL DEFAULT '[]',
    "criadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadaEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CobrancaFiscal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CobrancaFiscal_cobrancaId_key" ON "CobrancaFiscal"("cobrancaId");

-- CreateIndex
CREATE INDEX "CobrancaFiscal_situacao_criadaEm_idx" ON "CobrancaFiscal"("situacao", "criadaEm");

-- CreateIndex
CREATE INDEX "CobrancaFiscal_criadaEm_idx" ON "CobrancaFiscal"("criadaEm");

-- CreateIndex
CREATE INDEX "CobrancaFiscal_clienteId_idx" ON "CobrancaFiscal"("clienteId");
