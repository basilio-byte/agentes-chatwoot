"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { EFFORTS, listarModelos } from "@/server/agents/catalogo";
import { slugUnico } from "@/lib/slug";
import { comFalhaVisivel } from "@/server/actions/falha-visivel";

const agenteSchema = z.object({
  name: z.string().min(2, "Informe um nome").max(80),
  description: z.string().max(280).optional().or(z.literal("")),
  systemPrompt: z.string().min(20, "O prompt precisa de pelo menos 20 caracteres"),
  // Slug da OpenRouter: "provedor/modelo".
  model: z
    .string()
    .regex(/^[\w.-]+\/[\w.:-]+$/, "Selecione um modelo da lista"),
  effort: z.enum(EFFORTS),
  maxTokens: z.coerce.number().int().min(256).max(200000),
  maxToolIterations: z.coerce.number().int().min(1).max(20),
  /// Vazio esconde o agente do roster dos colegas — ninguém transfere para ele.
  routingDescription: z.string().max(400).optional().or(z.literal("")),
});

export type EstadoFormulario = {
  erro?: string;
  /** Confirmação de sucesso. Sem ela, salvar e falhar são iguais na tela. */
  ok?: string;
  camposComErro?: Record<string, string>;
};

function lerFormulario(formData: FormData) {
  return agenteSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
    systemPrompt: formData.get("systemPrompt"),
    model: formData.get("model"),
    effort: formData.get("effort"),
    maxTokens: formData.get("maxTokens"),
    maxToolIterations: formData.get("maxToolIterations"),
    routingDescription: formData.get("routingDescription"),
  });
}

function erros(issues: z.ZodIssue[]): EstadoFormulario {
  return {
    erro: "Confira os campos destacados.",
    camposComErro: Object.fromEntries(
      issues.map((i) => [i.path.join("."), i.message]),
    ),
  };
}

/**
 * Confere se o slug existe no catálogo da OpenRouter.
 *
 * Se o catálogo caiu para a lista de reserva (API fora do ar), não bloqueia —
 * seria pior impedir a edição de um agente por indisponibilidade externa.
 */
async function validarModelo(
  modelId: string,
): Promise<EstadoFormulario | null> {
  const modelos = await listarModelos();
  if (modelos.length <= 5) return null; // lista de reserva: não dá para afirmar

  if (!modelos.some((m) => m.id === modelId)) {
    return {
      erro: "Modelo não encontrado no catálogo da OpenRouter.",
      camposComErro: { model: "Slug inexistente" },
    };
  }
  return null;
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
  const parsed = lerFormulario(formData);
  if (!parsed.success) return erros(parsed.error.issues);

  const modeloInvalido = await validarModelo(parsed.data.model);
  if (modeloInvalido) return modeloInvalido;

  const jaExiste = await db.agent.findUnique({
    where: { name: parsed.data.name },
  });
  if (jaExiste) {
    return {
      erro: "Já existe um agente com esse nome.",
      camposComErro: { name: "Nome em uso" },
    };
  }

  // A chave nasce do nome, mas não acompanha renomeações: os colegas já
  // referenciam este agente por ela nos prompts deles.
  const usadas = (await db.agent.findMany({ select: { key: true } })).map(
    (a) => a.key,
  );

  const agente = await db.agent.create({
    data: {
      ...parsed.data,
      key: slugUnico(parsed.data.name, usadas),
      description: parsed.data.description || null,
      routingDescription: parsed.data.routingDescription || null,
      ownerId: sessao.user.id,
      updatedById: sessao.user.id,
      versions: {
        create: {
          version: 1,
          systemPrompt: parsed.data.systemPrompt,
          model: parsed.data.model,
          effort: parsed.data.effort,
          note: "Versão inicial",
          createdById: sessao.user.id,
        },
      },
    },
  });

  // O Chatwoot já nasce ligado: ele é o canal, não uma integração opcional.
  // Sem o vínculo, o agente responde mas não consegue transferir para colega
  // nem escalar para humano — e descobrir isso exige ler o código.
  const chatwoot = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CHATWOOT },
    select: { id: true },
  });
  if (chatwoot) {
    await db.agentIntegration.create({
      data: { agentId: agente.id, integrationId: chatwoot.id, enabled: true },
    });
  }

  await registrarAuditoria(sessao.user.id, "agent.created", agente.id);

  revalidatePath("/agentes");
  redirect(`/agentes/${agente.id}`);
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
  const parsed = lerFormulario(formData);
  if (!parsed.success) return erros(parsed.error.issues);

  const modeloInvalido = await validarModelo(parsed.data.model);
  if (modeloInvalido) return modeloInvalido;

  const atual = await db.agent.findUniqueOrThrow({ where: { id } });

  // Versiona só quando o que define o comportamento muda — evita encher o
  // histórico com edições de nome ou descrição.
  const mudouComportamento =
    atual.systemPrompt !== parsed.data.systemPrompt ||
    atual.model !== parsed.data.model ||
    atual.effort !== parsed.data.effort;

  await db.$transaction(async (tx) => {
    await tx.agent.update({
      where: { id },
      data: {
        ...parsed.data,
        description: parsed.data.description || null,
        routingDescription: parsed.data.routingDescription || null,
        updatedById: sessao.user.id,
      },
    });

    if (mudouComportamento) {
      const ultima = await tx.agentVersion.findFirst({
        where: { agentId: id },
        orderBy: { version: "desc" },
      });
      await tx.agentVersion.create({
        data: {
          agentId: id,
          version: (ultima?.version ?? 0) + 1,
          systemPrompt: parsed.data.systemPrompt,
          model: parsed.data.model,
          effort: parsed.data.effort,
          createdById: sessao.user.id,
        },
      });
    }
  });

  await registrarAuditoria(
    sessao.user.id,
    mudouComportamento ? "agent.prompt.updated" : "agent.updated",
    id,
  );

  revalidatePath(`/agentes/${id}`);
  revalidatePath("/agentes");

  // A mensagem NOMEIA o que aconteceu: mudar prompt, modelo ou effort cria uma
  // versão no histórico, e mudar nome ou descrição não. Sem isso, o operador
  // não tem como saber se o que ele mexeu foi o que versionou.
  return {
    ok: mudouComportamento
      ? "Agente salvo. O prompt mudou, então uma nova versão entrou no histórico."
      : "Agente salvo.",
  };
}

export async function alternarAtivo(id: string) {
  const sessao = await exigirPapel(UserRole.ADMIN);
  const agente = await db.agent.findUniqueOrThrow({ where: { id } });

  // Arquivado não liga: teria um agente fora da lista principal atendendo
  // cliente. Restaurar primeiro é a ordem certa, e é decisão consciente.
  if (agente.archivedAt && !agente.active) return;

  await db.agent.update({
    where: { id },
    data: { active: !agente.active },
  });

  await registrarAuditoria(
    sessao.user.id,
    agente.active ? "agent.deactivated" : "agent.activated",
    id,
  );

  revalidatePath("/agentes");
  revalidatePath(`/agentes/${id}`);
}

/**
 * Define o agente de entrada — quem recebe a primeira mensagem e distribui.
 *
 * Só um pode existir. A troca acontece numa transação porque desligar o antigo
 * e ligar o novo em passos separados deixaria uma janela sem entrada nenhuma,
 * e nessa janela quem atende passa a ser a porta, de forma arbitrária.
 * O índice parcial no banco é a garantia final contra dois salvamentos
 * simultâneos.
 */
export async function definirAgenteDeEntrada(id: string) {
  const sessao = await exigirPapel(UserRole.ADMIN);
  const agente = await db.agent.findUniqueOrThrow({ where: { id } });

  await db.$transaction([
    db.agent.updateMany({
      where: { isEntry: true, id: { not: id } },
      data: { isEntry: false },
    }),
    db.agent.update({ where: { id }, data: { isEntry: true } }),
  ]);

  await registrarAuditoria(sessao.user.id, "agent.entry.set", id);

  revalidatePath("/agentes");
  revalidatePath(`/agentes/${id}`);

  if (!agente.active) {
    return {
      aviso:
        "Definido como entrada, mas o agente está desligado — enquanto isso, quem atende é o agente do bot que recebeu a mensagem.",
    };
  }
  return {};
}

export type EstadoArquivo = { ok?: string; erro?: string };

/**
 * Tira o agente de circulação sem perder nada.
 *
 * Desliga na hora — arquivado que continuasse atendendo seria o pior dos dois
 * mundos — e limpa `isEntry`, senão o painel ficaria com um agente de entrada
 * que não atende e o roteamento cairia silenciosamente na porta.
 *
 * Prompt, modelo, integrações, versões e histórico ficam intactos.
 */
export async function arquivarAgente(id: string): Promise<EstadoArquivo> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  const agente = await db.agent.findUniqueOrThrow({ where: { id } });

  if (agente.archivedAt) return { erro: "Este agente já está arquivado." };

  await db.agent.update({
    where: { id },
    data: {
      archivedAt: new Date(),
      active: false,
      isEntry: false,
      updatedById: sessao.user.id,
    },
  });

  await registrarAuditoria(sessao.user.id, "agent.archived", id);
  revalidatePath("/agentes");
  revalidatePath(`/agentes/${id}`);

  if (agente.isEntry) {
    return {
      ok: "Arquivado. Ele era o agente de entrada — defina outro, senão quem atende primeiro passa a ser o agente do bot que recebeu a mensagem.",
    };
  }
  return { ok: "Agente arquivado e desligado." };
}

/**
 * Devolve o agente para a lista principal — **desligado**.
 *
 * Voltar a atender é uma segunda decisão: restaurar e religar de uma vez faria
 * um agente antigo voltar a falar com cliente sem ninguém conferir se o prompt
 * ainda faz sentido.
 */
export async function restaurarAgente(id: string): Promise<EstadoArquivo> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  await db.agent.update({
    where: { id },
    data: { archivedAt: null, active: false, updatedById: sessao.user.id },
  });

  await registrarAuditoria(sessao.user.id, "agent.restored", id);
  revalidatePath("/agentes");
  revalidatePath(`/agentes/${id}`);

  return { ok: "Restaurado, e desligado. Confira o prompt antes de ligar." };
}

export async function excluirAgente(id: string) {
  const sessao = await exigirPapel(UserRole.ADMIN);
  await db.agent.delete({ where: { id } });
  await registrarAuditoria(sessao.user.id, "agent.deleted", id);
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

async function registrarAuditoria(
  userId: string,
  action: string,
  entityId: string,
) {
  await db.auditLog.create({
    data: { userId, action, entity: "Agent", entityId },
  });
}
