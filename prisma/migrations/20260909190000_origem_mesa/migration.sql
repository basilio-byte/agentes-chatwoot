-- A mesa do agente: página própria por agente, onde alguém da equipe envia um
-- arquivo e o agente executa uma vez sobre ele.
--
-- Só acrescenta o valor. Nenhuma linha existente muda de origem, e nada neste
-- arquivo USA o valor novo — que é o que permitiria uma migration só: o
-- Postgres proíbe usar um valor de enum na mesma transação que o adicionou.
-- Mesma forma das migrations que acrescentaram TRIGGER e SCHEDULE.
ALTER TYPE "RunSource" ADD VALUE 'MESA';
