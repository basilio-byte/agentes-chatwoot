-- CreateEnum
CREATE TYPE "MotorDoAgente" AS ENUM ('PADRAO', 'OPENROUTER', 'CLAUDE_MAX');

-- CreateEnum
CREATE TYPE "MotorDaExecucao" AS ENUM ('OPENROUTER', 'CLAUDE_MAX');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "modeloClaudeMax" TEXT,
ADD COLUMN     "motor" "MotorDoAgente" NOT NULL DEFAULT 'PADRAO';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "motor" "MotorDaExecucao",
ADD COLUMN     "voltaDoProxy" TEXT;

-- CreateTable
CREATE TABLE "MotorDosAgentes" (
    "id" TEXT NOT NULL DEFAULT 'unico',
    "claudeMaxLigado" BOOLEAN NOT NULL DEFAULT false,
    "modeloPadrao" TEXT NOT NULL DEFAULT 'claude-sonnet-5',
    "atualizadoPorId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MotorDosAgentes_pkey" PRIMARY KEY ("id")
);
