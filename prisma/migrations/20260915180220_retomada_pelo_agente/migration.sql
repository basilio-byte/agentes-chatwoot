-- O atendimento volta para o agente quando o vendedor não responde a tempo
-- (prazo da equipe com `voltar_para_o_agente`). `retomadaPendente` faz o worker
-- rodar o agente sem mensagem nova do cliente; `retomadaEm` troca o bastão de
-- passagem pela instrução de retomada. Colunas novas com padrão: nenhuma linha
-- existente muda de comportamento.

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "retomadaEm" TIMESTAMP(3),
ADD COLUMN     "retomadaPendente" BOOLEAN NOT NULL DEFAULT false;
