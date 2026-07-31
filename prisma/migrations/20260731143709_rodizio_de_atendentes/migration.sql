-- CreateTable
CREATE TABLE "Rodizio" (
    "nome" TEXT NOT NULL,
    "ultimo" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rodizio_pkey" PRIMARY KEY ("nome")
);
