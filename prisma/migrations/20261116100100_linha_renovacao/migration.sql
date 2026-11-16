-- Cria a linha de Integration da renovacao automatica, DESLIGADA.
--
-- Em migration separada da que cria o valor 'RENOVACAO', pelo mesmo motivo das
-- linhas de NPS, janela, cobranca, notas fiscais, boas-vindas e acompanhamento:
-- o Postgres nao deixa usar um valor de enum na mesma transacao em que ele foi
-- criado, o seed nao roda em producao e o bootstrap so age enquanto nao ha
-- usuario nenhum.
--
-- Nasce desligada: mover a tarefa de renovacao para notificacao e para ongoing
-- dispara e-mails da automacao do ClickUp AO CLIENTE, e avancar a fidelidade
-- escreve no Conexa. Ligar cada parte e decisao.
INSERT INTO "Integration" ("id", "provider", "label", "config", "enabled", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'RENOVACAO', 'Renovação de contratos', '{}'::jsonb, false, 'NOT_CONFIGURED', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Integration" WHERE "provider" = 'RENOVACAO'
);
