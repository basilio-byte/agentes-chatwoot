"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { UserRole } from "@/generated/prisma/enums";
import { enviarTeste, salvarAlerta } from "@/server/alerta-de-saldo/alerta";
import { lerDestinatarios, lerLimite } from "@/server/alerta-de-saldo/regras";

export type EstadoDoAlerta = { ok?: string; erro?: string };

export type EstadoDoTeste = {
  erro?: string;
  entregas?: { nome: string; ok: boolean; detalhe: string }[];
};

const texto = (formData: FormData, campo: string) => {
  const valor = formData.get(campo);
  return typeof valor === "string" ? valor : "";
};

const lista = (formData: FormData, campo: string) =>
  formData.getAll(campo).map((v) => (typeof v === "string" ? v : ""));

/**
 * Configuração do alerta de saldo. Administrador para cima (decisão do usuário,
 * 18/09/2026): a tela de Consumo é aberta à equipe inteira, e os telefones são
 * de pessoas.
 */
export async function salvarAlertaDeSaldo(
  _estado: EstadoDoAlerta,
  formData: FormData,
): Promise<EstadoDoAlerta> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const limiteUsd = lerLimite(texto(formData, "limiteUsd"));
  if (limiteUsd == null) return { erro: "O limite precisa ser um valor em dólar maior que zero." };

  const caixaId = Number(texto(formData, "caixaId").trim());
  if (!Number.isInteger(caixaId) || caixaId <= 0) {
    return { erro: "A caixa é o número dela no Chatwoot, como 31." };
  }

  const lidos = lerDestinatarios(lista(formData, "nome"), lista(formData, "telefone"));
  if ("erro" in lidos) return { erro: lidos.erro };

  const ligado = formData.get("ligado") === "on";
  // Ligado sem ninguém para avisar é um alerta que parece funcionar e nunca fala.
  if (ligado && lidos.destinatarios.length === 0) {
    return { erro: "Cadastre pelo menos um telefone antes de ligar o alerta." };
  }

  await salvarAlerta({ ligado, limiteUsd, caixaId, destinatarios: lidos.destinatarios }, sessao.user.id);

  // Sem telefone no rastro: a auditoria é lida por quem não vê os números.
  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "alerta-de-saldo.updated",
      entity: "AlertaDeSaldo",
      entityId: "unico",
      diff: {
        ligado,
        limiteUsd,
        caixaId,
        destinatarios: lidos.destinatarios.map((d) => d.nome),
      },
    },
  });

  revalidatePath("/consumo");
  return {
    ok: ligado
      ? "Salvo e ligado. O saldo é conferido a cada 10 minutos. Mande um teste para ter certeza de que a mensagem chega."
      : "Salvo. O alerta está desligado: ninguém é avisado.",
  };
}

/**
 * Manda a mensagem de teste aos números salvos. Não lê nada do formulário de
 * propósito: o teste prova o que está SALVO, que é o que o alerta usa.
 */
export async function testarAlertaDeSaldo(): Promise<EstadoDoTeste> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const resultado = await enviarTeste({
    id: sessao.user.id,
    nome: sessao.user.name || sessao.user.email || null,
  });

  revalidatePath("/consumo");
  if ("erro" in resultado) return { erro: resultado.erro };
  return {
    entregas: resultado.entregas.map(({ nome, ok, detalhe }) => ({ nome, ok, detalhe })),
  };
}
