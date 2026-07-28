#!/bin/sh
set -e

# Aplica as migrations pendentes antes de subir. `migrate deploy` é idempotente,
# nunca gera migration nova e toma lock no banco — seguro rodar em toda réplica
# a cada deploy do Easypanel.
#
# Defina SKIP_MIGRATIONS=true para pular (ex.: no serviço worker, que sobe junto).
if [ "${SKIP_MIGRATIONS}" != "true" ]; then
  echo "→ aplicando migrations"
  NODE_PATH=./migrator/node_modules \
    node ./migrator/node_modules/prisma/build/index.js migrate deploy
fi

exec "$@"
