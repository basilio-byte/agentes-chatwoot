import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

/**
 * Cliente Prisma singleton, criado no **primeiro uso** — não no import.
 *
 * A diferença importa no `next build`: a etapa de "collect page data" avalia os
 * módulos de cada rota, e o build roda no Docker sem DATABASE_URL. Construir o
 * cliente no topo do arquivo quebraria o build.
 *
 * O guard em `globalThis` evita que o hot reload abra uma conexão nova a cada
 * recompilação e estoure o pool do Postgres.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let instancia: PrismaClient | null = null;

function obterCliente(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;

  instancia ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: env().DATABASE_URL }),
    log: ["warn", "error"],
  });

  if (env().NODE_ENV !== "production") globalForPrisma.prisma = instancia;
  return instancia;
}

export const db = new Proxy({} as PrismaClient, {
  get(_alvo, propriedade) {
    const cliente = obterCliente();
    const valor = Reflect.get(cliente, propriedade, cliente);
    // Métodos como `$transaction` precisam do `this` correto.
    return typeof valor === "function" ? valor.bind(cliente) : valor;
  },
});
