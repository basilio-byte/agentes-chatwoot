-- Presente de aniversário (2 h de sala): o agente registra o pedido, a equipe
-- lança e fatura o pacote no Conexa, e o vigia reserva quando a venda aparece
-- paga. Provider no registry, opt-in por agente, como os Prazos.
--
-- Só acrescenta: um tipo novo, um valor novo de provider, uma tabela e
-- índices. A linha da integração vem na migration seguinte — o Postgres
-- proíbe usar um valor de enum na mesma transação em que foi adicionado.

-- CreateEnum
CREATE TYPE "PresenteStatus" AS ENUM ('AGUARDANDO', 'PROCESSANDO', 'RESERVADO', 'ENTREGUE', 'CANCELADO', 'FALHOU');

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'ANIVERSARIO';

-- CreateTable
CREATE TABLE "PresenteDeAniversario" (
    "id" TEXT NOT NULL,
    "chatwootConversationId" INTEGER NOT NULL,
    "agentId" TEXT NOT NULL,
    "portaAgentId" TEXT NOT NULL,
    "clienteId" INTEGER NOT NULL,
    "pessoaId" INTEGER,
    "salaId" INTEGER NOT NULL,
    "salaNome" TEXT,
    "data" TEXT NOT NULL,
    "inicio" TEXT NOT NULL,
    "fim" TEXT NOT NULL,
    "aniversario" TEXT NOT NULL,
    "status" "PresenteStatus" NOT NULL DEFAULT 'AGUARDANDO',
    "venceEm" TIMESTAMP(3) NOT NULL,
    "vendaId" INTEGER,
    "reservaId" INTEGER,
    "resultado" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,
    "finalizadoEm" TIMESTAMP(3),

    CONSTRAINT "PresenteDeAniversario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PresenteDeAniversario_status_venceEm_idx" ON "PresenteDeAniversario"("status", "venceEm");

-- CreateIndex
CREATE INDEX "PresenteDeAniversario_clienteId_status_idx" ON "PresenteDeAniversario"("clienteId", "status");

-- CreateIndex
CREATE INDEX "PresenteDeAniversario_chatwootConversationId_status_idx" ON "PresenteDeAniversario"("chatwootConversationId", "status");

-- Um só pedido em andamento por conversa. O Prisma não descreve índice
-- parcial; quem registra (`aniversario/pedido.ts`) cancela o anterior na mesma
-- transação, e este índice é o que impede dois numa corrida.
CREATE UNIQUE INDEX "PresenteDeAniversario_um_em_andamento" ON "PresenteDeAniversario"("chatwootConversationId") WHERE "status" IN ('AGUARDANDO', 'PROCESSANDO');
