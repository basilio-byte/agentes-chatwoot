"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { cifrar, decifrar } from "@/lib/crypto";
import { exigirPapel } from "@/server/auth-guard";
import {
  IntegrationProvider,
  IntegrationStatus,
  UserRole,
} from "@/generated/prisma/enums";
import { conexaConfigSchema } from "@/server/integrations/conexa/config";
import { ConexaClient } from "@/server/integrations/conexa/client";

export type EstadoConexa = {
  ok?: string;
  erro?: string;
  camposComErro?: Record<string, string>;
};

const PROVIDER = IntegrationProvider.CONEXA;

async function registro() {
  return db.integration.findUnique({
    where: { provider: PROVIDER },
    include: { credential: true },
  });
}

/**
 * Lê um campo de "nome = id", uma linha por item.
 *
 * É o mesmo formato das listas nomeadas do ClickUp, e pelo mesmo motivo: a API
 * do Conexa **não lista** unidades por nome nem salas de jeito nenhum, então o
 * id precisa vir daqui — e id cru no prompt é frágil e ilegível na revisão.
 *
 * Linha malformada é descartada em silêncio: perder a configuração inteira por
 * causa de uma linha meio digitada seria pior do que ignorar essa linha.
 */
function lerNomeados(texto: string) {
  return texto
    .split(/[\r\n]+/)
    .map((linha) => {
      const [nome, ...resto] = linha.split("=");
      const id = Number(resto.join("=").trim());
      return { nome: (nome ?? "").trim(), id };
    })
    .filter((l) => l.nome && Number.isInteger(l.id) && l.id > 0);
}

/** Campo numérico opcional: vazio vira `undefined`, não `0`. */
function numeroOpcional(valor: FormDataEntryValue | null) {
  const texto = String(valor ?? "").trim();
  if (!texto) return undefined;
  const n = Number(texto);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}

export async function salvarConfigConexa(
  _estado: EstadoConexa,
  formData: FormData,
): Promise<EstadoConexa> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const parsed = conexaConfigSchema.safeParse({
    baseUrl: String(formData.get("baseUrl") ?? "").trim(),
    unidades: lerNomeados(String(formData.get("unidades") ?? "")).map((u) => ({
      nome: u.nome,
      companyId: u.id,
    })),
    salas: lerNomeados(String(formData.get("salas") ?? "")).map((s) => ({
      nome: s.nome,
      roomId: s.id,
    })),
    sellerId: numeroOpcional(formData.get("sellerId")),
    contractTemplateId: numeroOpcional(formData.get("contractTemplateId")),
    crmPartnerId: numeroOpcional(formData.get("crmPartnerId")),
    crmStatusId: numeroOpcional(formData.get("crmStatusId")),
  });

  if (!parsed.success) {
    return {
      erro: "Confira os campos.",
      camposComErro: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  const enabled = formData.get("enabled") === "on";

  await db.integration.upsert({
    where: { provider: PROVIDER },
    update: { config: parsed.data, enabled },
    create: {
      provider: PROVIDER,
      label: "Conexa (ERP)",
      config: parsed.data,
      enabled,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.conexa.updated",
      entity: "Integration",
      entityId: PROVIDER,
    },
  });

  revalidatePath("/integracoes");
  return { ok: "Configuração salva." };
}

/** Token guardado cifrado. Só OWNER mexe em credencial. */
export async function salvarTokenConexa(
  _estado: EstadoConexa,
  formData: FormData,
): Promise<EstadoConexa> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const token = String(formData.get("apiToken") ?? "").trim();
  if (token.length < 10) {
    return {
      erro: "Confira os campos.",
      camposComErro: { apiToken: "Token muito curto" },
    };
  }

  const integracao = await db.integration.upsert({
    where: { provider: PROVIDER },
    update: {},
    create: {
      provider: PROVIDER,
      label: "Conexa (ERP)",
      config: {},
      enabled: false,
    },
  });

  const cifrado = cifrar(token);
  await db.integrationCredential.upsert({
    where: { integrationId: integracao.id },
    update: { ...cifrado, rotatedAt: new Date() },
    create: { integrationId: integracao.id, ...cifrado },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.conexa.credential.rotated",
      entity: "Integration",
      entityId: PROVIDER,
    },
  });

  revalidatePath("/integracoes");
  return { ok: "Token salvo. Use o botão de testar para confirmar." };
}

/**
 * Testa a conexão e, de quebra, devolve as unidades.
 *
 * `GET /companies` é o único endpoint que serve para as duas coisas: confirma
 * URL e token, e entrega justamente os `companyId` que o operador precisa
 * cadastrar logo abaixo — o dado menos óbvio de achar na interface do Conexa.
 */
export async function testarConexaoConexa(): Promise<EstadoConexa> {
  await exigirPapel(UserRole.ADMIN);

  const atual = await registro();
  if (!atual?.credential) {
    return { erro: "Salve o token antes de testar." };
  }

  const config = conexaConfigSchema.safeParse(atual.config);
  if (!config.success) {
    return { erro: "Informe a URL da instância antes de testar." };
  }

  const cliente = new ConexaClient(config.data, decifrar(atual.credential));
  const resultado = await cliente.testar();

  await db.integration.update({
    where: { provider: PROVIDER },
    data: {
      status: resultado.ok ? IntegrationStatus.OK : IntegrationStatus.ERROR,
      lastCheckedAt: new Date(),
      lastError: resultado.ok ? null : resultado.mensagem,
    },
  });

  revalidatePath("/integracoes");
  return resultado.ok ? { ok: resultado.mensagem } : { erro: resultado.mensagem };
}
