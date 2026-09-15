-- Gatilho de conversa: quando uma conversa do Chatwoot é resolvida, um agente
-- roda sobre a transcrição do atendimento, em segundo plano. Nasceu para
-- substituir o "Olho de tudo" do n8n (15/09/2026).
--
-- Só acrescenta: um tipo, um valor de origem, uma tabela e índices. Nenhuma
-- tabela existente muda, e nada neste arquivo USA o valor novo de RunSource —
-- o Postgres proíbe usar um valor de enum na mesma transação que o adicionou.

-- CreateEnum
CREATE TYPE "EventoDeConversa" AS ENUM ('RESOLVIDA');

-- AlterEnum
ALTER TYPE "RunSource" ADD VALUE 'CONVERSA_ENCERRADA';

-- CreateTable
CREATE TABLE "GatilhoDeConversa" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "evento" "EventoDeConversa" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "exigeAtendimentoHumano" BOOLEAN NOT NULL DEFAULT true,
    "contasDeAutomacao" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ultimaExecucaoEm" TIMESTAMP(3),
    "ultimoResultado" TEXT,
    "ultimoDetalhe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatilhoDeConversa_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GatilhoDeConversa_evento_enabled_idx" ON "GatilhoDeConversa"("evento", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "GatilhoDeConversa_agentId_evento_key" ON "GatilhoDeConversa"("agentId", "evento");

-- AddForeignKey
ALTER TABLE "GatilhoDeConversa" ADD CONSTRAINT "GatilhoDeConversa_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
