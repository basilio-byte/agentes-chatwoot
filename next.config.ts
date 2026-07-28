import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Imagem enxuta para o Easypanel: o build gera .next/standalone com só o
  // necessário para rodar, sem o node_modules inteiro.
  output: "standalone",

  // Pacotes que não podem ser empacotados no bundle do servidor:
  //  - Prisma e pg são nativos;
  //  - pino usa worker threads para os transports;
  //  - bullmq carrega scripts Lua do próprio diretório em runtime, e ioredis
  //    vem junto.
  //
  // Além disso, manter externo faz o Next copiar o pacote inteiro para o
  // `node_modules` do standalone — é de lá que o bundle do worker resolve os
  // imports dele.
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-pg",
    "pino",
    "bullmq",
    "ioredis",
    "openai",
  ],
};

export default nextConfig;
