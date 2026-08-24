-- Gatilho por horário: o agente roda sozinho, sem ninguém do outro lado.
--
-- O valor de enum e a tabela cabem na mesma migration porque a tabela NÃO usa
-- `SCHEDULE` — o Postgres só proíbe usar o valor na mesma transação que o
-- adicionou. Quem grava com ele é a aplicação, depois do commit.
-- AlterEnum
ALTER TYPE "RunSource" ADD VALUE 'SCHEDULE';

-- CreateTable
CREATE TABLE "AgentSchedule" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "instrucao" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "toleranciaMinutos" INTEGER NOT NULL DEFAULT 60,
    "ultimaExecucaoEm" TIMESTAMP(3),
    "ultimoResultado" TEXT,
    "ultimoDetalhe" TEXT,
    "falhasConsecutivas" INTEGER NOT NULL DEFAULT 0,
    "pausadoAutomaticamenteEm" TIMESTAMP(3),
    "pausadoAutomaticamenteMotivo" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentSchedule_agentId_idx" ON "AgentSchedule"("agentId");

-- CreateIndex
CREATE INDEX "AgentSchedule_enabled_idx" ON "AgentSchedule"("enabled");

-- AddForeignKey
ALTER TABLE "AgentSchedule" ADD CONSTRAINT "AgentSchedule_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
