-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'NPS';

-- CreateEnum
CREATE TYPE "PesquisaNpsStatus" AS ENUM ('AGENDADA', 'AGUARDANDO', 'LEMBRADA', 'RESPONDIDA', 'AGRADECIDA', 'CONCLUIDA', 'EXPIRADA', 'CANCELADA', 'FALHOU');

-- CreateTable
CREATE TABLE "PesquisaNps" (
    "id" TEXT NOT NULL,
    "chatwootConversationId" INTEGER NOT NULL,
    "inboxId" INTEGER,
    "portaAgentId" TEXT,
    "telefone" TEXT,
    "status" "PesquisaNpsStatus" NOT NULL DEFAULT 'AGENDADA',
    "marcadaEm" TIMESTAMP(3) NOT NULL,
    "venceEm" TIMESTAMP(3) NOT NULL,
    "enviadaEm" TIMESTAMP(3),
    "referenciaMensagemId" INTEGER,
    "lembreteEm" TIMESTAMP(3),
    "nota" INTEGER,
    "notaMensagemId" INTEGER,
    "respondidaEm" TIMESTAMP(3),
    "ultimaMensagemEm" TIMESTAMP(3),
    "registro" JSONB,
    "resultado" TEXT,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "criadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizadaEm" TIMESTAMP(3),

    CONSTRAINT "PesquisaNps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PesquisaNps_status_venceEm_idx" ON "PesquisaNps"("status", "venceEm");

-- CreateIndex
CREATE INDEX "PesquisaNps_chatwootConversationId_status_idx" ON "PesquisaNps"("chatwootConversationId", "status");

-- CreateIndex
CREATE INDEX "PesquisaNps_telefone_enviadaEm_idx" ON "PesquisaNps"("telefone", "enviadaEm");

-- CreateIndex
CREATE UNIQUE INDEX "PesquisaNps_chatwootConversationId_marcadaEm_key" ON "PesquisaNps"("chatwootConversationId", "marcadaEm");

-- Uma pesquisa em andamento por conversa, depois de enviada. O Prisma não
-- descreve índice parcial; é este índice que faz duas marcações seguidas do
-- mesmo checkbox virarem uma pesquisa só (`nps/executar.ts`, etapa de envio).
-- AGENDADA fica de fora: a segunda marcação precisa existir para ser
-- desmarcada e cancelada com o motivo escrito.
CREATE UNIQUE INDEX "PesquisaNps_uma_em_andamento" ON "PesquisaNps"("chatwootConversationId") WHERE "status" IN ('AGUARDANDO', 'LEMBRADA', 'RESPONDIDA', 'AGRADECIDA');
