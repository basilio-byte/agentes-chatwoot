-- CreateTable
CREATE TABLE "OpenClawUso" (
    "id" TEXT NOT NULL,
    "hora" TIMESTAMP(3) NOT NULL,
    "conteiner" TEXT NOT NULL,
    "agente" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "chamadas" INTEGER NOT NULL,
    "entrada" BIGINT NOT NULL,
    "saida" BIGINT NOT NULL,
    "cacheLeitura" BIGINT NOT NULL,
    "cacheEscrita" BIGINT NOT NULL,

    CONSTRAINT "OpenClawUso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpenClawLimite" (
    "id" TEXT NOT NULL,
    "hora" TIMESTAMP(3) NOT NULL,
    "conteiner" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "quantidade" INTEGER NOT NULL,

    CONSTRAINT "OpenClawLimite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpenClawConfig" (
    "id" TEXT NOT NULL DEFAULT 'unico',
    "tokenHash" TEXT,
    "tokenDica" TEXT,
    "conteineres" JSONB NOT NULL DEFAULT '[]',
    "cotaSemanalUsd" DOUBLE PRECISION,
    "resetDiaSemana" INTEGER NOT NULL DEFAULT 0,
    "resetHoraUtc" INTEGER NOT NULL DEFAULT 19,
    "ultimaColetaEm" TIMESTAMP(3),
    "ultimaColeta" TEXT,
    "atualizadoPorId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpenClawConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpenClawUso_hora_idx" ON "OpenClawUso"("hora");

-- CreateIndex
CREATE UNIQUE INDEX "OpenClawUso_hora_conteiner_agente_tipo_modelo_key" ON "OpenClawUso"("hora", "conteiner", "agente", "tipo", "modelo");

-- CreateIndex
CREATE INDEX "OpenClawLimite_hora_idx" ON "OpenClawLimite"("hora");

-- CreateIndex
CREATE UNIQUE INDEX "OpenClawLimite_hora_conteiner_categoria_key" ON "OpenClawLimite"("hora", "conteiner", "categoria");
