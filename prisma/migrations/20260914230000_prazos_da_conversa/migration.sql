-- Prazos da conversa: o agente registra "se ninguém responder em N minutos,
-- faça X", e o vigia do worker executa conferindo o Chatwoot ao vivo.
--
-- Só acrescenta: dois tipos novos, um valor novo de provider, uma tabela e
-- índices. Nenhuma tabela existente muda. A linha da integração vem na
-- migration seguinte — o Postgres proíbe usar um valor de enum na mesma
-- transação em que foi adicionado.

-- CreateEnum
CREATE TYPE "PrazoTipo" AS ENUM ('EQUIPE', 'CLIENTE');

-- CreateEnum
CREATE TYPE "PrazoStatus" AS ENUM ('PENDENTE', 'EXECUTANDO', 'EXECUTADO', 'CANCELADO', 'DESCARTADO', 'FALHOU');

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'PRAZOS';

-- CreateTable
CREATE TABLE "PrazoDeConversa" (
    "id" TEXT NOT NULL,
    "chatwootConversationId" INTEGER NOT NULL,
    "agentId" TEXT NOT NULL,
    "portaAgentId" TEXT NOT NULL,
    "tipo" "PrazoTipo" NOT NULL,
    "status" "PrazoStatus" NOT NULL DEFAULT 'PENDENTE',
    "minutos" INTEGER NOT NULL,
    "venceEm" TIMESTAMP(3) NOT NULL,
    "referenciaMensagemId" INTEGER NOT NULL,
    "donoId" INTEGER,
    "donoNome" TEXT,
    "acao" JSONB NOT NULL,
    "motivo" TEXT NOT NULL,
    "resultado" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizadoEm" TIMESTAMP(3),

    CONSTRAINT "PrazoDeConversa_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrazoDeConversa_status_venceEm_idx" ON "PrazoDeConversa"("status", "venceEm");

-- CreateIndex
CREATE INDEX "PrazoDeConversa_chatwootConversationId_tipo_status_idx" ON "PrazoDeConversa"("chatwootConversationId", "tipo", "status");

-- Um só prazo PENDENTE por conversa e tipo. O Prisma não descreve índice
-- parcial; quem registra (`prazos/registrar.ts`) cancela o anterior na mesma
-- transação, e este índice é o que impede dois pendentes numa corrida.
CREATE UNIQUE INDEX "PrazoDeConversa_um_pendente" ON "PrazoDeConversa"("chatwootConversationId", "tipo") WHERE "status" = 'PENDENTE';

-- AddForeignKey
ALTER TABLE "PrazoDeConversa" ADD CONSTRAINT "PrazoDeConversa_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
