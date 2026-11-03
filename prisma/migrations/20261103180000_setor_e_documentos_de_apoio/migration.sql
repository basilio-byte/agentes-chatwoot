-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "setor" TEXT;

-- CreateTable
CREATE TABLE "DocumentoDeConhecimento" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "setor" TEXT,
    "texto" TEXT NOT NULL,
    "origem" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentoDeConhecimento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentoDoAgente" (
    "documentoId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentoDoAgente_pkey" PRIMARY KEY ("documentoId","agentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentoDeConhecimento_nome_key" ON "DocumentoDeConhecimento"("nome");

-- CreateIndex
CREATE INDEX "DocumentoDeConhecimento_setor_idx" ON "DocumentoDeConhecimento"("setor");

-- CreateIndex
CREATE INDEX "DocumentoDoAgente_agentId_idx" ON "DocumentoDoAgente"("agentId");

-- AddForeignKey
ALTER TABLE "DocumentoDoAgente" ADD CONSTRAINT "DocumentoDoAgente_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "DocumentoDeConhecimento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentoDoAgente" ADD CONSTRAINT "DocumentoDoAgente_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
