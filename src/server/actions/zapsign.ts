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
import { zapsignConfigSchema } from "@/server/integrations/zapsign/config";
import { ZapSignClient } from "@/server/integrations/zapsign/client";

export type EstadoZapSign = {
  ok?: string;
  erro?: string;
  camposComErro?: Record<string, string>;
};

const PROVIDER = IntegrationProvider.ZAPSIGN;
const ROTULO = "ZapSign";

async function registro() {
  return db.integration.findUnique({
    where: { provider: PROVIDER },
    include: { credential: true },
  });
}

/** Modelos por nome, uma linha por item: `nome = token`. */
function lerModelos(texto: string) {
  return texto
    .split(/[\r\n]+/)
    .map((linha) => {
      const [nome, ...resto] = linha.split("=");
      return { nome: (nome ?? "").trim(), templateId: resto.join("=").trim() };
    })
    .filter((m) => m.nome && m.templateId);
}

export async function salvarConfigZapSign(
  _estado: EstadoZapSign,
  formData: FormData,
): Promise<EstadoZapSign> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const parsed = zapsignConfigSchema.safeParse({
    baseUrl:
      String(formData.get("baseUrl") ?? "").trim() ||
      "https://api.zapsign.com.br/api/v1",
    modelos: lerModelos(String(formData.get("modelos") ?? "")),
    authModePadrao: String(formData.get("authModePadrao") ?? "assinaturaTela-tokenEmail"),
    whatsappAutomatico: formData.get("whatsappAutomatico") === "on",
    lang: String(formData.get("lang") ?? "pt-br"),
  });

  if (!parsed.success) {
    return {
      erro: "Confira os campos.",
      camposComErro: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  await db.integration.upsert({
    where: { provider: PROVIDER },
    update: { config: parsed.data, enabled: formData.get("enabled") === "on" },
    create: {
      provider: PROVIDER,
      label: ROTULO,
      config: parsed.data,
      enabled: formData.get("enabled") === "on",
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.zapsign.updated",
      entity: "Integration",
      entityId: PROVIDER,
    },
  });

  revalidatePath("/integracoes");
  return { ok: "Configuração salva." };
}

export async function salvarTokenZapSign(
  _estado: EstadoZapSign,
  formData: FormData,
): Promise<EstadoZapSign> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const token = String(formData.get("apiToken") ?? "").trim();
  if (token.length < 10) {
    return { erro: "Confira os campos.", camposComErro: { apiToken: "Token muito curto" } };
  }

  const integracao = await db.integration.upsert({
    where: { provider: PROVIDER },
    update: {},
    create: { provider: PROVIDER, label: ROTULO, config: {}, enabled: false },
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
      action: "integration.zapsign.credential.rotated",
      entity: "Integration",
      entityId: PROVIDER,
    },
  });

  revalidatePath("/integracoes");
  return { ok: "Token salvo. Use o botão de testar para confirmar." };
}

export async function testarConexaoZapSign(): Promise<EstadoZapSign> {
  await exigirPapel(UserRole.ADMIN);

  const atual = await registro();
  if (!atual?.credential) return { erro: "Salve o token antes de testar." };

  const config = zapsignConfigSchema.safeParse(atual.config);
  if (!config.success) return { erro: "Confira a configuração antes de testar." };

  const cliente = new ZapSignClient(config.data, decifrar(atual.credential));
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

/**
 * Lista os modelos da conta para o operador cadastrar apelido sem sair daqui.
 *
 * O token do modelo é um uuid que só aparece na URL da ZapSign — é o dado mais
 * chato de achar, e é justamente o que o agente precisa para gerar contrato.
 */
export async function descobrirModelosZapSign(): Promise<
  EstadoZapSign & { modelos?: { id: string; nome: string }[] }
> {
  await exigirPapel(UserRole.ADMIN);

  const atual = await registro();
  if (!atual?.credential) return { erro: "Salve o token antes de buscar." };

  const config = zapsignConfigSchema.safeParse(atual.config);
  if (!config.success) return { erro: "Confira a configuração antes de buscar." };

  try {
    const cliente = new ZapSignClient(config.data, decifrar(atual.credential));
    const { results } = await cliente.listarModelos();
    const modelos = results
      .filter((m) => m.active)
      .map((m) => ({ id: m.token, nome: m.name }));

    return modelos.length
      ? { ok: `${modelos.length} modelo(s) encontrado(s).`, modelos }
      : { erro: "Nenhum modelo ativo nesta conta da ZapSign." };
  } catch (erro) {
    return {
      erro: erro instanceof Error ? erro.message : "Falha ao buscar modelos.",
    };
  }
}
