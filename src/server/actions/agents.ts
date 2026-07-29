"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { UserRole } from "@/generated/prisma/enums";
import { EFFORTS, listarModelos } from "@/server/agents/catalogo";

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
});

export type EstadoFormulario = {
  erro?: string;
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

export async function criarAgente(
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

  const agente = await db.agent.create({
    data: {
      ...parsed.data,
      description: parsed.data.description || null,
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

  await registrarAuditoria(sessao.user.id, "agent.created", agente.id);

  revalidatePath("/agentes");
  redirect(`/agentes/${agente.id}`);
}

export async function atualizarAgente(
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
  return {};
}

export async function alternarAtivo(id: string) {
  const sessao = await exigirPapel(UserRole.ADMIN);
  const agente = await db.agent.findUniqueOrThrow({ where: { id } });

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

export async function excluirAgente(id: string) {
  const sessao = await exigirPapel(UserRole.ADMIN);
  await db.agent.delete({ where: { id } });
  await registrarAuditoria(sessao.user.id, "agent.deleted", id);
  revalidatePath("/agentes");
  redirect("/agentes");
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
