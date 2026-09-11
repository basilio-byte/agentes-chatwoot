"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { UserRole } from "@/generated/prisma/enums";
import { comFalhaVisivel } from "@/server/actions/falha-visivel";
import { auditar, autorDaSessao } from "@/server/gestao/autor";
import {
  arquivar,
  atualizarAgente as gravarAgente,
  criarAgente as cadastrarAgente,
  definirAtivo,
  definirEntrada,
  restaurar,
  type DadosDoAgente,
} from "@/server/gestao/agentes";

// A regra de cada ação mora em `server/gestao/agentes.ts`, que o MCP também
// chama. Aqui fica só a porta do painel: papel, formulário e redirecionamento.

export type EstadoFormulario = {
  erro?: string;
  /** Confirmação de sucesso. Sem ela, salvar e falhar são iguais na tela. */
  ok?: string;
  camposComErro?: Record<string, string>;
};

/** O formulário, cru — quem converte e recusa é o schema do serviço. */
function lerFormulario(formData: FormData): DadosDoAgente {
  return {
    name: formData.get("name"),
    description: formData.get("description"),
    systemPrompt: formData.get("systemPrompt"),
    model: formData.get("model"),
    effort: formData.get("effort"),
    maxTokens: formData.get("maxTokens"),
    maxToolIterations: formData.get("maxToolIterations"),
    routingDescription: formData.get("routingDescription"),
  };
}

/**
 * ⚠ O envoltório existe porque uma server action que LANÇA some duas vezes: o
 * React descarta a rejeição no cliente e o Next mascara a mensagem em produção,
 * deixando só o digest. Em 04/09/2026 isso fez "salvei o prompt e não aconteceu
 * nada" parecer defeito de armazenamento. Agora o erro inteiro vai para o log
 * com um código, e a tela mostra o mesmo código.
 */
export async function criarAgente(
  estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  return comFalhaVisivel(
    "agente.criar",
    () => criarAgenteImpl(estado, formData),
    (falha) => ({ erro: falha.erro }),
  );
}

async function criarAgenteImpl(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const criado = await cadastrarAgente(
    lerFormulario(formData),
    autorDaSessao(sessao),
  );
  if (!criado.ok) {
    return { erro: criado.erro, camposComErro: criado.camposComErro };
  }

  redirect(`/agentes/${criado.id}`);
}

export async function atualizarAgente(
  id: string,
  estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  return comFalhaVisivel(
    "agente.atualizar",
    () => atualizarAgenteImpl(id, estado, formData),
    (falha) => ({ erro: falha.erro }),
  );
}

async function atualizarAgenteImpl(
  id: string,
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const gravado = await gravarAgente(
    id,
    lerFormulario(formData),
    autorDaSessao(sessao),
  );
  if (!gravado.ok) {
    return { erro: gravado.erro, camposComErro: gravado.camposComErro };
  }

  // A mensagem NOMEIA o que aconteceu: mudar prompt, modelo ou effort cria uma
  // versão no histórico, e mudar nome ou descrição não. Sem isso, o operador
  // não tem como saber se o que ele mexeu foi o que versionou.
  return {
    ok: gravado.mudouComportamento
      ? "Agente salvo. O prompt mudou, então uma nova versão entrou no histórico."
      : "Agente salvo.",
  };
}

export async function alternarAtivo(id: string) {
  const sessao = await exigirPapel(UserRole.ADMIN);
  const agente = await db.agent.findUniqueOrThrow({
    where: { id },
    select: { active: true, archivedAt: true },
  });

  // Arquivado não liga: teria um agente fora da lista principal atendendo
  // cliente. Restaurar primeiro é a ordem certa, e é decisão consciente.
  if (agente.archivedAt && !agente.active) return;

  await definirAtivo(id, !agente.active, autorDaSessao(sessao));
}

/** Define o agente de entrada — ver `definirEntrada`. */
export async function definirAgenteDeEntrada(
  id: string,
): Promise<{ aviso?: string }> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  const r = await definirEntrada(id, autorDaSessao(sessao));

  // A tela só sabe mostrar `aviso`; uma recusa que não aparecesse ali seria o
  // clique que "não faz nada".
  if ("erro" in r) return { aviso: r.erro };
  return r.aviso ? { aviso: r.aviso } : {};
}

export type EstadoArquivo = { ok?: string; erro?: string };

/** Tira o agente de circulação sem perder nada — ver `arquivar`. */
export async function arquivarAgente(id: string): Promise<EstadoArquivo> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  return arquivar(id, autorDaSessao(sessao));
}

/** Devolve o agente para a lista principal, desligado — ver `restaurar`. */
export async function restaurarAgente(id: string): Promise<EstadoArquivo> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  return restaurar(id, autorDaSessao(sessao));
}

/**
 * ⚠ Excluir fica SÓ no painel, de propósito: não existe no serviço
 * compartilhado, e o MCP não o oferece a ninguém. Cascateia para execuções,
 * versões e custo — um assistente que entendesse mal "limpe os agentes velhos"
 * apagaria o histórico de cobrança sem volta.
 */
export async function excluirAgente(id: string) {
  const sessao = await exigirPapel(UserRole.ADMIN);
  await db.agent.delete({ where: { id } });
  await auditar(autorDaSessao(sessao), "agent.deleted", "Agent", id);
  revalidatePath("/agentes");
  redirect("/agentes");
}

/** O que a exclusão leva junto, para a tela poder avisar antes. */
export async function impactoDaExclusao(id: string) {
  await exigirPapel(UserRole.ADMIN);
  const agente = await db.agent.findUnique({
    where: { id },
    select: {
      _count: { select: { runs: true, conversations: true, versions: true } },
    },
  });

  return {
    execucoes: agente?._count.runs ?? 0,
    conversas: agente?._count.conversations ?? 0,
    versoes: agente?._count.versions ?? 0,
  };
}
