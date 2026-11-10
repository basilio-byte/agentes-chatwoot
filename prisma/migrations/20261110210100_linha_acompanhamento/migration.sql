-- Cria a linha de Integration do acompanhamento de contratos, DESLIGADA.
--
-- Em migration separada da que cria o valor 'ACOMPANHAMENTO', pelo mesmo motivo
-- das linhas de NPS, janela, cobranca, notas fiscais e boas-vindas: o Postgres
-- nao deixa usar um valor de enum na mesma transacao em que ele foi criado, o
-- seed nao roda em producao e o bootstrap so age enquanto nao ha usuario nenhum.
--
-- Nasce desligada: ela MANDA MENSAGEM A CLIENTE dentro de uma conversa que esta
-- com um vendedor, que e a excecao consciente desta capacidade. Ligar e decisao.
INSERT INTO "Integration" ("id", "provider", "label", "config", "enabled", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'ACOMPANHAMENTO', 'Acompanhamento de contratos', '{}'::jsonb, false, 'NOT_CONFIGURED', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Integration" WHERE "provider" = 'ACOMPANHAMENTO'
);
