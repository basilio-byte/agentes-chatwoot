import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  IntegrationProvider,
  UserRole,
} from "../src/generated/prisma/enums";

/**
 * Seed idempotente: cria o usuário inicial e as linhas de integração.
 * Rodar com: npm run db:seed
 *
 * Em produção, defina SEED_EMAIL e SEED_PASSWORD antes de rodar — o padrão
 * abaixo só serve para desenvolvimento local.
 */

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});
const db = new PrismaClient({ adapter });

const CATALOGO: Record<IntegrationProvider, string> = {
  [IntegrationProvider.CHATWOOT]: "Chatwoot",
  [IntegrationProvider.CLICKUP]: "ClickUp",
  [IntegrationProvider.CONEXA]: "ERP Conexa",
  [IntegrationProvider.ZAPSIGN]: "ZapSign",
  [IntegrationProvider.OPENAI]: "OpenAI — leitura de mídia",
  [IntegrationProvider.DOCUMENTOS]: "Documentos (CPF, CNH, CNPJ)",
  [IntegrationProvider.GOOGLE]: "Google Workspace",
};

async function main() {
  const email = (process.env.SEED_EMAIL ?? "admin@seahub.local").toLowerCase();
  const senha = process.env.SEED_PASSWORD ?? "seahub123";

  const usuario = await db.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: process.env.SEED_NAME ?? "Administrador",
      passwordHash: await bcrypt.hash(senha, 12),
      role: UserRole.OWNER,
    },
  });
  console.log(`usuário: ${usuario.email} (${usuario.role})`);

  for (const [provider, label] of Object.entries(CATALOGO)) {
    await db.integration.upsert({
      where: { provider: provider as IntegrationProvider },
      update: {},
      create: {
        provider: provider as IntegrationProvider,
        label,
        enabled: false, // toda integração nasce desligada
      },
    });
  }
  console.log(`integrações: ${Object.keys(CATALOGO).length} linhas garantidas`);

  if (!process.env.SEED_PASSWORD) {
    console.log(
      `\n⚠  senha padrão de desenvolvimento: ${senha} — troque antes de expor o painel.`,
    );
  }
}

main()
  .catch((erro) => {
    console.error(erro);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
