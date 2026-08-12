-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "model" TEXT;

-- CreateIndex
CREATE INDEX "AgentRun_createdAt_idx" ON "AgentRun"("createdAt");

-- Backfill do histórico.
--
-- Coluna nova só vale para linha nova: sem isto, toda a apuração de consumo
-- por modelo começaria vazia e a tela nasceria dizendo "modelo não registrado"
-- para tudo que já rodou.
--
-- A atribuição NÃO usa `Agent.model` (o modelo de agora) como primeira opção:
-- quem trocou de modelo teria a fatura antiga reescrita com o modelo novo. A
-- fonte certa é `AgentVersion`, que guarda o modelo vigente em cada momento —
-- todo agente nasce com a versão 1, então a versão mais recente CRIADA ANTES
-- da execução é exatamente o modelo com que ela rodou.
-- Subconsulta correlacionada, e não `FROM LATERAL`: num UPDATE o Postgres não
-- deixa o LATERAL enxergar a tabela-alvo ("invalid reference to FROM-clause
-- entry").
UPDATE "AgentRun" r
SET "model" = (
  SELECT av."model"
  FROM "AgentVersion" av
  WHERE av."agentId" = r."agentId"
    AND av."createdAt" <= r."createdAt"
  ORDER BY av."createdAt" DESC
  LIMIT 1
)
WHERE r."model" IS NULL;

-- Sobra: execução anterior à versão 1 do próprio agente (possível se o relógio
-- do container escorregou). Aí a versão mais antiga é a melhor aproximação.
UPDATE "AgentRun" r
SET "model" = (
  SELECT av."model"
  FROM "AgentVersion" av
  WHERE av."agentId" = r."agentId"
  ORDER BY av."createdAt" ASC
  LIMIT 1
)
WHERE r."model" IS NULL;
