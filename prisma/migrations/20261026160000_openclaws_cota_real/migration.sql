-- CreateTable
CREATE TABLE "OpenClawCota" (
    "id" TEXT NOT NULL,
    "lidaEm" TIMESTAMP(3) NOT NULL,
    "janela" TEXT NOT NULL,
    "utilizacao" DOUBLE PRECISION NOT NULL,
    "resetaEm" TIMESTAMP(3),
    "plano" TEXT,

    CONSTRAINT "OpenClawCota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpenClawCota_lidaEm_idx" ON "OpenClawCota"("lidaEm");

-- CreateIndex
CREATE UNIQUE INDEX "OpenClawCota_lidaEm_janela_key" ON "OpenClawCota"("lidaEm", "janela");
