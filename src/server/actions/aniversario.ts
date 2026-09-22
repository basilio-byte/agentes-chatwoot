"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { lerDestinatarios } from "@/server/alerta-de-saldo/regras";
import { configAniversarioSchema, lerConfigAniversario } from "@/server/aniversario/regras";

export type EstadoAniversario = { ok?: string; erro?: string };

const PROVIDER = IntegrationProvider.ANIVERSARIO;
const ROTULO = "Presente de aniversário";

const texto = (formData: FormData, campo: string) => {
  const valor = formData.get(campo);
  return typeof valor === "string" ? valor : "";
};

const lista = (formData: FormData, campo: string) =>
  formData.getAll(campo).map((v) => (typeof v === "string" ? v : ""));

const inteiro = (bruto: string) => {
  const n = Number(bruto.trim());
  return Number.isInteger(n) ? n : NaN;
};

/**
 * Configuração do presente de aniversário. Administrador para cima: os
 * telefones são de pessoas da equipe, como no alerta de saldo.
 */
export async function salvarConfigAniversario(
  _estado: EstadoAniversario,
  formData: FormData,
): Promise<EstadoAniversario> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const lidos = lerDestinatarios(lista(formData, "nome"), lista(formData, "telefone"));
  if ("erro" in lidos) return { erro: lidos.erro };

  const ligada = formData.get("enabled") === "on";
  // Ligada sem ninguém para avisar: o pedido nasceria e ninguém lançaria o pacote.
  if (ligada && lidos.destinatarios.length === 0) {
    return { erro: "Cadastre pelo menos um telefone para receber o aviso antes de ligar." };
  }

  const atual = await db.integration.findUnique({
    where: { provider: PROVIDER },
    select: { config: true },
  });
  // O que a tela não edita (produtos, duração) continua como estava.
  const anterior = lerConfigAniversario(atual?.config);

  const lido = configAniversarioSchema.safeParse({
    ...anterior,
    avisar: lidos.destinatarios,
    caixaDoAviso: inteiro(texto(formData, "caixaDoAviso")),
    atendente: texto(formData, "atendente"),
    prazoHoras: inteiro(texto(formData, "prazoHoras")),
    diasDepois: inteiro(texto(formData, "diasDepois")),
    confirmacao: texto(formData, "confirmacao"),
    entrega: texto(formData, "entrega"),
  });
  if (!lido.success) {
    const campo = String(lido.error.issues[0]?.path[0] ?? "");
    const mensagens: Record<string, string> = {
      caixaDoAviso: "A caixa é o número dela no Chatwoot, como 31.",
      atendente: "O nome de quem assume tem no máximo 80 caracteres.",
      prazoHoras: "O prazo é um número de horas, de 1 a 72.",
      diasDepois: "A janela é um número de dias, de 0 a 30.",
      confirmacao: "A confirmação ao cliente precisa ter de 10 a 1000 caracteres.",
      entrega: "O aviso de passagem precisa ter de 10 a 1000 caracteres.",
    };
    return { erro: mensagens[campo] ?? "Confira os campos do formulário." };
  }
  if (!lido.data.atendente) return { erro: "Diga quem assume a conversa quando o prazo vence." };

  const config = JSON.parse(JSON.stringify(lido.data));
  await db.integration.upsert({
    where: { provider: PROVIDER },
    update: { enabled: ligada, config },
    create: { provider: PROVIDER, label: ROTULO, config, enabled: ligada },
  });

  // Sem telefone no rastro: a auditoria é lida por quem não vê os números.
  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.aniversario.updated",
      entity: "Integration",
      entityId: PROVIDER,
      diff: {
        ligada,
        avisar: lido.data.avisar.map((d) => d.nome),
        caixaDoAviso: lido.data.caixaDoAviso,
        atendente: lido.data.atendente,
        prazoHoras: lido.data.prazoHoras,
        diasDepois: lido.data.diasDepois,
      },
    },
  });

  revalidatePath("/integracoes");
  return {
    ok: ligada
      ? "Ligada. Falta ligar a integração na tela de cada agente que atende o pedido do presente."
      : "Desligada. Nenhum pedido novo é registrado, e os que estavam esperando são cancelados na próxima conferência.",
  };
}
