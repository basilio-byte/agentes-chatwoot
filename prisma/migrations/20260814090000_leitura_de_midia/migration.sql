-- Leitura de mídia: OpenAI entra no enum de provedores + cache das análises.
--
-- O valor do enum vem SOZINHO com a tabela (que não o usa): o Postgres não
-- deixa USAR um valor de enum na mesma transação que o adicionou, e a migration
-- seguinte precisa inserir a linha de Integration com ele. Mesmo par de
-- migrations da ZapSign.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'OPENAI';

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'AUDIO', 'DOCUMENT', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('OK', 'ERROR', 'SKIPPED');

-- CreateTable
CREATE TABLE "MediaAnalysis" (
    "id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "status" "MediaStatus" NOT NULL,
    "nomeArquivo" TEXT,
    "mimeType" TEXT,
    "tamanhoBytes" INTEGER,
    "texto" TEXT,
    "erro" TEXT,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "segundosDeAudio" INTEGER,
    "duracaoMs" INTEGER,
    "agentId" TEXT,
    "conversationId" TEXT,
    "chatwootMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAnalysis_chave_key" ON "MediaAnalysis"("chave");

-- CreateIndex
CREATE INDEX "MediaAnalysis_createdAt_idx" ON "MediaAnalysis"("createdAt");

-- CreateIndex
CREATE INDEX "MediaAnalysis_status_idx" ON "MediaAnalysis"("status");

-- CreateIndex
CREATE INDEX "MediaAnalysis_agentId_createdAt_idx" ON "MediaAnalysis"("agentId", "createdAt" DESC);
