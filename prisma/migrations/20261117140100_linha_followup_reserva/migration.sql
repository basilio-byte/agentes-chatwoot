-- Cria a linha de Integration do follow-up de reserva, DESLIGADA.
--
-- Em migration separada da que cria o valor 'FOLLOWUP_RESERVA', pelo mesmo
-- motivo das linhas de NPS, janela, cobranca e renovacao: o Postgres nao deixa
-- usar um valor de enum na mesma transacao em que ele foi criado, o seed nao
-- roda em producao e o bootstrap so age enquanto nao ha usuario nenhum.
--
-- Nasce desligada e, ligada, comeca em modo sombra: ligar de verdade fala com
-- CLIENTE.
INSERT INTO "Integration" ("id", "provider", "label", "config", "enabled", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'FOLLOWUP_RESERVA', 'Follow-up de reserva', '{}'::jsonb, false, 'NOT_CONFIGURED', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Integration" WHERE "provider" = 'FOLLOWUP_RESERVA'
);
