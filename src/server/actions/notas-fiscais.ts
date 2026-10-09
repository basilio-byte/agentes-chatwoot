"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { configDoFormulario, lerConfigNotasFiscais } from "@/server/notas-fiscais/config";
import { reclassificar } from "@/server/notas-fiscais/conferir";
import { hashDoToken } from "@/server/notas-fiscais/aviso";
import { liberarNotaParaNovaTentativa, repositorioReal } from "@/server/notas-fiscais/emissao/emitir";
import { gerarToken } from "@/server/gatilho/token";

export type EstadoNotasFiscais = { ok?: string; erro?: string };

/**
 * Config e liga/desliga das notas fiscais, gravados juntos. Não toca em
 * `lastCheckedAt`/`status`/`lastError`: aquilo é o estado que o vigia escreve.
 *
 * Salvar também refaz a decisão das cobranças já vistas em modo sombra, com a
 * tabela nova — quem acabou de dar código a uma categoria quer ver as
 * cobranças dela saírem de "aguardando" na hora, e não na próxima rodada.
 */
export async function salvarConfigNotasFiscais(
  _estado: EstadoNotasFiscais,
  formData: FormData,
): Promise<EstadoNotasFiscais> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const atual = await db.integration.findUnique({
    where: { provider: IntegrationProvider.NOTAS_FISCAIS },
    select: { config: true },
  });
  const campos: Record<string, string> = {};
  for (const [campo, valor] of formData.entries()) {
    if (typeof valor === "string") campos[campo] = valor;
  }
  const lido = configDoFormulario(campos, lerConfigNotasFiscais(atual?.config));
  if ("erro" in lido) return { erro: lido.erro };

  const ligada = formData.get("enabled") === "on";
  const config = lido.config as unknown as Prisma.InputJsonValue;

  await db.integration.upsert({
    where: { provider: IntegrationProvider.NOTAS_FISCAIS },
    update: { enabled: ligada, config },
    create: {
      provider: IntegrationProvider.NOTAS_FISCAIS,
      label: "Notas fiscais (Spedy)",
      config,
      enabled: ligada,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.notas_fiscais.updated",
      entity: "Integration",
      entityId: IntegrationProvider.NOTAS_FISCAIS,
      diff: {
        enabled: ligada,
        modo: lido.config.modo,
        inicio: lido.config.inicio,
        codigos: lido.config.codigos,
        codigoReservaDeSala: lido.config.codigoReservaDeSala,
        regrasPorCliente: lido.config.clientes.length,
        regrasPorProduto: lido.config.produtos,
        // Quem ligou, ou mudou, a emissão de nota fiscal REAL fica registrado.
        emissao: lido.config.emissao,
      },
    },
  });

  const refeitas = await reclassificar(lido.config);
  revalidatePath("/integracoes");

  const mudou = refeitas.mudadas + refeitas.apagadas;
  const efeito = mudou
    ? ` ${refeitas.mudadas} cobrança(s) já vista(s) refeita(s) com a tabela nova${refeitas.apagadas ? `, e ${refeitas.apagadas} volta(m) a ser lida(s) na próxima conferência` : ""}.`
    : "";
  const emissao = lido.config.emissao;
  const quemEmite = emissao.soCobrancas.length
    ? `só as cobranças ${emissao.soCobrancas.join(", ")}`
    : `o que for pago a partir de ${emissao.aPartirDe}`;
  const modo = !ligada
    ? "Desligado. Nada é lido do Conexa."
    : emissao.ligada
      ? `Emissão LIGADA: ${quemEmite} vira nota fiscal real na Spedy, a cada 5 minutos. O n8n não pode emitir essas mesmas.`
      : "Modo sombra ligado. A primeira conferência acontece em até 1 minuto e depois a cada 30 minutos. Nenhuma nota é emitida.";
  return { ok: modo + efeito };
}

/**
 * "Tentar de novo": devolve à fila uma nota REJEITADA pela prefeitura ou parada
 * pela Spedy, depois que a causa foi corrigida. A rodada seguinte (até 5 minutos)
 * reenvia a MESMA nota, que a Spedy corrige em vez de criar outra. ADMIN, como
 * ligar a emissão: é o que faz uma nota fiscal sair.
 */
export async function tentarEmitirDeNovo(chave: string): Promise<EstadoNotasFiscais> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  if (typeof chave !== "string" || !chave || chave.length > 100) return { erro: "Nota inválida." };

  const liberada = await liberarNotaParaNovaTentativa(repositorioReal(), chave);
  if (!liberada.ok) return { erro: liberada.erro };

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.notas_fiscais.nova_tentativa",
      entity: "NotaFiscalEmitida",
      entityId: chave,
      diff: { situacaoAnterior: liberada.situacaoAnterior },
    },
  });
  revalidatePath("/integracoes");

  // Liberar nota cujo código ainda está em espera não a emite: a espera vale primeiro.
  const [nota, integracao] = await Promise.all([
    db.notaFiscalEmitida.findUnique({ where: { chave }, select: { codigo: true } }),
    db.integration.findUnique({ where: { provider: IntegrationProvider.NOTAS_FISCAIS }, select: { config: true } }),
  ]);
  const emEspera = lerConfigNotasFiscais(integracao?.config).emissao.codigosEmEspera;
  if (nota && emEspera.includes(nota.codigo)) {
    return {
      ok: `Liberada, mas o código ${nota.codigo} ainda está em espera: ela sai quando você o tirar da lista "Códigos em espera".`,
    };
  }
  return { ok: "Liberada. A mesma nota é reenviada na próxima rodada (até 5 minutos), sem gastar outro número." };
}

/**
 * Gera (ou troca) o endereço do aviso do Conexa e o devolve inteiro UMA vez. É o
 * mesmo modelo do token do gatilho: o segredo nasce do nosso lado, só o hash
 * fica guardado. Só Proprietário — quem tem o endereço consegue fazer o sistema
 * reler cobranças, e trocá-lo derruba o aviso que já está cadastrado no Conexa.
 */
export async function gerarEnderecoDoAvisoDoConexa(): Promise<{ erro?: string; token?: string }> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const atual = await db.integration.findUnique({
    where: { provider: IntegrationProvider.NOTAS_FISCAIS },
    select: { config: true },
  });
  if (!atual) return { erro: "Salve a configuração das notas fiscais uma vez antes de gerar o endereço." };

  const token = gerarToken();
  const config = {
    ...((atual.config ?? {}) as Record<string, unknown>),
    aviso: { tokenHash: hashDoToken(token), geradoEm: new Date().toISOString() },
  } as unknown as Prisma.InputJsonValue;
  await db.integration.update({ where: { provider: IntegrationProvider.NOTAS_FISCAIS }, data: { config } });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.notas_fiscais.aviso_gerado",
      entity: "Integration",
      entityId: IntegrationProvider.NOTAS_FISCAIS,
    },
  });
  revalidatePath("/integracoes");
  return { token };
}
