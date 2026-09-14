-- Chamada interna: um agente aciona outro em segundo plano, no meio do próprio
-- turno, e recebe o resultado de volta — sem passar a conversa e sem o cliente
-- ver nada. A execução do agente acionado ganha origem própria.
--
-- Só acrescenta o valor. Nenhuma linha existente muda de origem, e nada neste
-- arquivo USA o valor novo — o Postgres proíbe usar um valor de enum na mesma
-- transação que o adicionou. Mesma forma de TRIGGER, SCHEDULE e MESA.
ALTER TYPE "RunSource" ADD VALUE 'INTERNO';
