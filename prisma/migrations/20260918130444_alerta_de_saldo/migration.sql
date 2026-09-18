-- CreateEnum
CREATE TYPE "TipoDeAvisoDeSaldo" AS ENUM ('BAIXO', 'ZERADO', 'TESTE');

-- CreateTable
CREATE TABLE "AlertaDeSaldo" (
    "id" TEXT NOT NULL DEFAULT 'unico',
    "ligado" BOOLEAN NOT NULL DEFAULT false,
    "limiteUsd" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "caixaId" INTEGER NOT NULL DEFAULT 31,
    "destinatarios" JSONB NOT NULL DEFAULT '[]',
    "abaixoDesde" TIMESTAMP(3),
    "avisadoEm" TIMESTAMP(3),
    "avisadoTipo" "TipoDeAvisoDeSaldo",
    "conferidoEm" TIMESTAMP(3),
    "ultimaFalha" TEXT,
    "atualizadoPorId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertaDeSaldo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvisoDeSaldo" (
    "id" TEXT NOT NULL,
    "tipo" "TipoDeAvisoDeSaldo" NOT NULL,
    "saldoUsd" DOUBLE PRECISION,
    "limiteUsd" DOUBLE PRECISION NOT NULL,
    "entregas" JSONB NOT NULL,
    "entregues" INTEGER NOT NULL,
    "falhas" INTEGER NOT NULL,
    "autorId" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvisoDeSaldo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AvisoDeSaldo_criadoEm_idx" ON "AvisoDeSaldo"("criadoEm");
