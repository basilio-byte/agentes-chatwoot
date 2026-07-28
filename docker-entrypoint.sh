#!/bin/sh
set -e

# Aplica as migrations pendentes antes de subir. `migrate deploy` é idempotente,
# nunca gera migration nova e toma lock no banco — seguro rodar em toda réplica
# a cada deploy do Easypanel.
#
# Defina SKIP_MIGRATIONS=true no serviço worker, que sobe junto com o app.
if [ "${SKIP_MIGRATIONS}" != "true" ]; then
  echo "→ aplicando migrations"
  # Chamada direta ao build do CLI: o shim em node_modules/.bin é um symlink e,
  # copiado para a imagem, perde a resolução relativa do próprio pacote.
  NODE_PATH=./migrator/node_modules \
    node ./migrator/node_modules/prisma/build/index.js migrate deploy
fi

# Worker dentro do container do app — alternativa a criar um segundo serviço no
# Easypanel. Bom para volume baixo; para escalar os dois separadamente, use um
# serviço próprio com `node worker.mjs` e SKIP_MIGRATIONS=true.
if [ "${RUN_WORKER_IN_APP}" = "true" ]; then
  echo "→ subindo worker no mesmo container"
  node worker.mjs &
  WORKER_PID=$!
  # Encerra o worker junto com o container, para ele fechar os jobs em andamento.
  trap 'kill -TERM "$WORKER_PID" 2>/dev/null' TERM INT
fi

exec "$@"
