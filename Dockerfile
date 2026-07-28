# Imagem única para o Easypanel. O serviço `app` e o futuro `worker` usam esta
# mesma imagem, mudando só o comando de start.

# --- 1. Dependências -------------------------------------------------------
FROM node:24-alpine AS deps
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts pula o postinstall (prisma generate); a geração acontece no
# estágio de build, onde o schema já está presente.
RUN npm ci --ignore-scripts

# --- 2. Build --------------------------------------------------------------
FROM node:24-alpine AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# O build não precisa de banco: a validação de env é preguiçosa (src/lib/env.ts).
RUN npx prisma generate && npm run build

# --- 3. CLI do Prisma, isolado ---------------------------------------------
# O `migrate deploy` do entrypoint precisa do CLI com toda a árvore de
# dependências dele. Instalar num diretório separado mantém isso numa camada
# própria — muda só quando a versão do Prisma muda, então o cache aguenta.
FROM node:24-alpine AS migrator
WORKDIR /migrator
# O package.json do app vai para /tmp só para ler a versão. Copiá-lo para o
# WORKDIR faria o `npm init -y` preservar as dependências do app e o install
# arrastaria o projeto inteiro para dentro desta camada.
COPY package.json /tmp/app-package.json
RUN PRISMA_VERSION="$(node -p "require('/tmp/app-package.json').devDependencies.prisma.replace(/^[^0-9]*/, '')")" \
    && npm init -y > /dev/null \
    && npm i --no-audit --no-fund "prisma@${PRISMA_VERSION}" dotenv

# --- 4. Runtime ------------------------------------------------------------
FROM node:24-alpine AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Saída standalone: só o necessário para rodar o Next.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Schema + migrations + CLI isolado, para o `migrate deploy` do entrypoint.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=migrator --chown=nextjs:nodejs /migrator/node_modules ./migrator/node_modules

COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
