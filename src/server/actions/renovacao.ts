"use server";

import { revalidatePath } from "next/cache";

import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { hashDoToken } from "@/server/boas-vindas/regras";
import { gerarToken } from "@/server/gatilho/token";
import { lerConfigRenovacao, type ModoDasDatas, type ModoDeParte } from "@/server/renovacao/config";
import { dadosDoFormulario } from "@/server/renovacao/whatsapp";

export type EstadoRenovacao = { ok?: string; erro?: string };

/**
 * Gera (ou troca) o endereço das datas e o devolve inteiro UMA vez, no mesmo
 * modelo do token do gatilho, do aviso do Conexa e da macro de boas-vindas: o
 * segredo nasce do nosso lado e só o hash fica guardado. Só Proprietário — quem
 * tem o endereço faz o sistema avançar a fidelidade de um contrato no Conexa, e
 * trocá-lo derruba o que já está cadastrado na automação do ClickUp.
 */
export async function gerarEnderecoDasDatas(): Promise<{ erro?: string; token?: string }> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const atual = await db.integration.findUnique({
    where: { provider: IntegrationProvider.RENOVACAO },
    select: { config: true },
  });
  const gravada = (atual?.config && typeof atual.config === "object" ? atual.config : {}) as Record<
    string,
    unknown
  >;

  const token = gerarToken();
  const config = {
    ...gravada,
    tokenHash: hashDoToken(token),
    tokenGeradoEm: new Date().toISOString(),
  };
  await db.integration.upsert({
    where: { provider: IntegrationProvider.RENOVACAO },
    update: { config },
    create: { provider: IntegrationProvider.RENOVACAO, label: "Renovação de contratos", config, enabled: false },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.renovacao.endereco_gerado",
      entity: "Integration",
      entityId: IntegrationProvider.RENOVACAO,
    },
  });
  revalidatePath("/integracoes");
  return { token };
}

const MODOS: readonly ModoDasDatas[] = ["desligado", "sombra", "ligado"];

/**
 * Liga e desliga o que a renovação faz sozinha.
 *
 * ⚠ **Ligar faz o ClickUp mandar e-mail AO CLIENTE** (mover para `notificação
 * renovação` e para `ongoing`) e, nas datas, escreve no Conexa. Por isso exige
 * ADMIN e a auditoria guarda quem ligou cada parte: é o único registro de quem
 * autorizou o sistema a notificar cliente sem uma pessoa apertar o botão.
 */
export async function salvarConfigRenovacao(
  _estado: EstadoRenovacao,
  formData: FormData,
): Promise<EstadoRenovacao> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const geral = formData.get("enabled") === "on";
  const moverParaNotificacao = formData.get("moverParaNotificacao") === "on";
  const fecharNoPagamento = formData.get("fecharNoPagamento") === "on";

  const atual = await db.integration.findUnique({
    where: { provider: IntegrationProvider.RENOVACAO },
    select: { config: true },
  });
  const gravada = (atual?.config && typeof atual.config === "object" ? atual.config : {}) as Record<
    string,
    unknown
  >;

  // O modo das datas pode nem vir no formulário (a parte só aparece depois que o
  // endereço existe): ausente, fica como estava.
  const lida = lerConfigRenovacao(gravada, true);
  const enviado = formData.get("avancarDatas");
  const avancarDatas =
    typeof enviado === "string" && MODOS.includes(enviado as ModoDasDatas)
      ? (enviado as ModoDasDatas)
      : lida.avancarDatas;

  // O WhatsApp ao cliente ONE tem modo (desligado | sombra | ligado), quem recebe
  // a conversa e o texto. Ausente do formulário, fica como estava.
  const modoEnviado = formData.get("avisarPorWhatsapp");
  const avisarPorWhatsapp =
    typeof modoEnviado === "string" && MODOS.includes(modoEnviado as ModoDeParte)
      ? (modoEnviado as ModoDeParte)
      : lida.avisarPorWhatsapp;
  const textos = dadosDoFormulario(
    (campo) => {
      const v = formData.get(campo);
      return typeof v === "string" ? v : null;
    },
    { whatsappAtribuirA: lida.whatsappAtribuirA, whatsappTexto: lida.whatsappTexto },
  );
  if ("erro" in textos) return { erro: textos.erro };

  // `tokenHash` e qualquer outra chave gravada ficam: o formulário não as conhece.
  const config = {
    ...gravada,
    moverParaNotificacao,
    fecharNoPagamento,
    avancarDatas,
    avisarPorWhatsapp,
    whatsappAtribuirA: textos.atribuirA,
    whatsappTexto: textos.texto,
  };

  await db.integration.upsert({
    where: { provider: IntegrationProvider.RENOVACAO },
    update: { enabled: geral, config },
    create: {
      provider: IntegrationProvider.RENOVACAO,
      label: "Renovação de contratos",
      config,
      enabled: geral,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.renovacao.updated",
      entity: "Integration",
      entityId: IntegrationProvider.RENOVACAO,
      // O texto da mensagem fica de fora: quem o editou é visível pelo `updatedAt`,
      // e o conteúdo é do cliente, não da auditoria.
      diff: {
        enabled: geral,
        moverParaNotificacao,
        fecharNoPagamento,
        avancarDatas,
        avisarPorWhatsapp,
        whatsappAtribuirA: textos.atribuirA,
        whatsappTextoPersonalizado: textos.texto !== null,
      },
    },
  });

  revalidatePath("/integracoes");

  const ligadas = [
    moverParaNotificacao && "mover para notificação",
    fecharNoPagamento && "fechar o ciclo no pagamento",
    avancarDatas !== "desligado" && `datas (${avancarDatas})`,
    avisarPorWhatsapp !== "desligado" && `WhatsApp ao cliente ONE (${avisarPorWhatsapp})`,
  ].filter(Boolean);

  if (!geral) {
    return { ok: "Desligado. Nada do que está nesta aba roda — a propagação do reajuste segue como sempre." };
  }
  return {
    ok: ligadas.length
      ? `Salvo. Ligado: ${ligadas.join(", ")}. A próxima conferência acontece em até 30 minutos, em horário comercial.`
      : "Salvo, mas nenhuma parte está ligada — o interruptor geral sozinho não faz nada.",
  };
}
