-- Gatilho de checkbox: quando alguém da equipe marca um atributo personalizado
-- da conversa no Chatwoot (`passar_para_crm`, `atendimento`), um agente roda
-- sobre o atendimento atual, em segundo plano. Substitui a passagem manual para
-- os CRMs que os fluxos do n8n faziam (15/09/2026).
--
-- Só acrescenta: dois valores de enum e uma coluna com padrão. Nada neste
-- arquivo USA os valores novos — o Postgres proíbe usar um valor de enum na
-- mesma transação que o adicionou.

-- AlterEnum
ALTER TYPE "EventoDeConversa" ADD VALUE 'ATRIBUTO_MARCADO';

-- AlterEnum
ALTER TYPE "RunSource" ADD VALUE 'CONVERSA_MARCADA';

-- AlterTable
ALTER TABLE "GatilhoDeConversa" ADD COLUMN     "atributos" TEXT[] DEFAULT ARRAY[]::TEXT[];
