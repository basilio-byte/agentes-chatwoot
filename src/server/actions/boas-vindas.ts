"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { cifrar, decifrar } from "@/lib/crypto";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import {
  configDoFormulario,
  hashDoToken,
  lerConfigBoasVindas,
  NOME_DA_MACRO,
} from "@/server/boas-vindas/regras";
import { gerarToken } from "@/server/gatilho/token";
import { NotificaMeClient } from "@/server/integrations/notificame/client";

export type EstadoBoasVindas = { ok?: string; erro?: string };

const ROTULO = "Template de boas-vindas (WhatsApp oficial)";

/**
 * Config e liga/desliga, gravados juntos. Não toca em `lastCheckedAt`/`status`/
 * `lastError` (estado que o envio escreve) nem no token do endereço (que só o
 * Proprietário gera, em `gerarEnderecoDaMacro`).
 */
export async function salvarConfigBoasVindas(
  _estado: EstadoBoasVindas,
  formData: FormData,
): Promise<EstadoBoasVindas> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const atual = await db.integration.findUnique({
    where: { provider: IntegrationProvider.BOAS_VINDAS },
    select: { config: true, credential: { select: { id: true } } },
  });
  const lido = configDoFormulario((campo) => {
    const valor = formData.get(campo);
    return typeof valor === "string" ? valor : null;
  }, lerConfigBoasVindas(atual?.config));
  if ("erro" in lido) return { erro: lido.erro };

  const ligada = formData.get("enabled") === "on";
  if (ligada && !atual?.credential) {
    return { erro: "Cadastre o token da NotificaMe antes de ligar (só o Proprietário cadastra)." };
  }
  if (ligada && !lido.config.canalId) {
    return { erro: "Canal da NotificaMe: informe o canal de onde o template sai antes de ligar." };
  }

  const config = lido.config as unknown as Prisma.InputJsonValue;
  await db.integration.upsert({
    where: { provider: IntegrationProvider.BOAS_VINDAS },
    update: { enabled: ligada, config },
    create: { provider: IntegrationProvider.BOAS_VINDAS, label: ROTULO, config, enabled: ligada },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.boas_vindas.updated",
      entity: "Integration",
      entityId: IntegrationProvider.BOAS_VINDAS,
      diff: {
        enabled: ligada,
        template: lido.config.template,
        caixaDoCliente: lido.config.caixaDoCliente,
        minutosSemReenvio: lido.config.minutosSemReenvio,
        tetoPorHora: lido.config.tetoPorHora,
      },
    },
  });

  revalidatePath("/integracoes");
  if (!ligada) return { ok: "Desligada. A macro continua atribuindo e etiquetando, mas nenhum template sai e a nota avisa quem clicou." };
  return {
    ok: lido.config.tokenHash
      ? `Ligada. O próximo clique na macro "${NOME_DA_MACRO}" manda o template.`
      : `Ligada, mas ainda não há endereço para a macro: peça ao Proprietário para gerá-lo e colar na macro "${NOME_DA_MACRO}".`,
  };
}

/**
 * O token da NotificaMe, cifrado como as outras credenciais. Só Proprietário:
 * quem o tem manda mensagem de WhatsApp em nome da Seahub.
 */
export async function salvarTokenDaNotificaMe(
  _estado: EstadoBoasVindas,
  formData: FormData,
): Promise<EstadoBoasVindas> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const token = String(formData.get("token") ?? "").trim();
  if (token.length < 10) return { erro: "Confira o token: ele parece curto demais." };

  const integracao = await db.integration.upsert({
    where: { provider: IntegrationProvider.BOAS_VINDAS },
    update: {},
    create: { provider: IntegrationProvider.BOAS_VINDAS, label: ROTULO, config: {}, enabled: false },
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
      action: "integration.boas_vindas.credential.rotated",
      entity: "Integration",
      entityId: IntegrationProvider.BOAS_VINDAS,
    },
  });

  revalidatePath("/integracoes");
  return { ok: "Token salvo. Use \"Testar\" para conferir token, canal e template." };
}

/**
 * Gera (ou troca) o endereço da macro e o devolve inteiro UMA vez, no mesmo modelo
 * do token do gatilho e do aviso do Conexa: o segredo nasce do nosso lado e só o
 * hash fica guardado. Só Proprietário — quem tem o endereço faz o sistema mandar
 * template, e trocá-lo derruba o que já está cadastrado na macro.
 */
export async function gerarEnderecoDaMacro(): Promise<{ erro?: string; token?: string }> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const integracao = await db.integration.upsert({
    where: { provider: IntegrationProvider.BOAS_VINDAS },
    update: {},
    create: { provider: IntegrationProvider.BOAS_VINDAS, label: ROTULO, config: {}, enabled: false },
    select: { config: true },
  });

  const token = gerarToken();
  const config = {
    ...lerConfigBoasVindas(integracao.config),
    tokenHash: hashDoToken(token),
    tokenGeradoEm: new Date().toISOString(),
  } as unknown as Prisma.InputJsonValue;
  await db.integration.update({ where: { provider: IntegrationProvider.BOAS_VINDAS }, data: { config } });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.boas_vindas.endereco_gerado",
      entity: "Integration",
      entityId: IntegrationProvider.BOAS_VINDAS,
    },
  });
  revalidatePath("/integracoes");
  return { token };
}

/**
 * Confere, sem mandar nada ao cliente, que o token abre, que o canal responde e
 * que o template existe e está aprovado — e mostra o texto que o cliente leria.
 */
export async function testarBoasVindas(): Promise<EstadoBoasVindas> {
  await exigirPapel(UserRole.ADMIN);

  const linha = await db.integration.findUnique({
    where: { provider: IntegrationProvider.BOAS_VINDAS },
    select: { config: true, credential: true },
  });
  if (!linha?.credential) return { erro: "Cadastre o token da NotificaMe antes de testar." };
  const config = lerConfigBoasVindas(linha.config);
  if (!config.canalId) return { erro: "Informe o canal da NotificaMe e salve antes de testar." };

  let templates;
  try {
    templates = await new NotificaMeClient(decifrar(linha.credential)).listarTemplates(config.canalId);
  } catch (erro) {
    return { erro: `A NotificaMe não respondeu como esperado: ${erro instanceof Error ? erro.message : String(erro)}` };
  }

  const modelo = templates.find((t) => t.nome === config.template);
  if (!modelo) {
    return {
      erro: `O token e o canal funcionam, mas o template "${config.template}" não está na lista (${templates.length} templates no canal).`,
    };
  }
  if (modelo.status !== "APPROVED") {
    return { erro: `O template "${config.template}" existe, mas está "${modelo.status ?? "sem status"}" — só aprovado pode ser enviado.` };
  }
  const parametro = `{{${config.parametro}}}`;
  if (modelo.corpo && !modelo.corpo.includes(parametro)) {
    return {
      erro: `O template "${config.template}" está aprovado, mas o corpo não tem o parâmetro ${parametro}: confira o campo "Parâmetro do nome".`,
    };
  }
  return {
    ok: `Tudo certo: token, canal e template aprovado. O cliente lê: «${(modelo.corpo ?? "").replace(/\s+/g, " ").trim()}»`,
  };
}
