import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Imagem enxuta para o Easypanel: o build gera .next/standalone com só o
  // necessário para rodar, sem o node_modules inteiro.
  output: "standalone",

  // O cliente do Prisma 7 e o pg são nativos — não devem ser empacotados.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pino"],
};

export default nextConfig;
