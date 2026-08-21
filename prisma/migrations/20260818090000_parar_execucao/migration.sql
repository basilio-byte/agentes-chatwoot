-- Execução interrompida no painel ganha estado próprio.
--
-- Sozinha e sem usar o valor: o Postgres não deixa USAR um valor de enum na
-- mesma transação que o adicionou. Nada aqui insere nem compara com 'CANCELED'
-- — quem grava é a aplicação, depois do commit.
ALTER TYPE "RunStatus" ADD VALUE IF NOT EXISTS 'CANCELED';
