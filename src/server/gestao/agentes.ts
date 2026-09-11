import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { slugUnico } from "@/lib/slug";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { EFFORTS, listarModelos } from "@/server/agents/catalogo";
import { auditar, type Autor, type Desfecho } from "./autor";

/**
 * O que se pode fazer com um agente — a regra, sem a porta.
 *
 * O painel e o MCP chamam estas funções. Quem chama confere o papel e traduz o
 * resultado; o que é permitido fazer com o agente, e em que ordem, mora aqui.
 */

export const agenteSchema = z.object({
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

/**
 * Os campos do formulário, ainda crus. `unknown` de propósito: o painel manda
 * o que sai do `FormData` e o MCP manda número, e quem converte e recusa é o
 * schema — um lugar só.
 */
export type DadosDoAgente = Record<keyof z.input<typeof agenteSchema>, unknown>;

export type Recusa = { erro: string; camposComErro?: Record<string, string> };

function recusaDeValidacao(issues: z.ZodIssue[]): Recusa {
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
async function validarModelo(modelId: string): Promise<Recusa | null> {
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

export type Criacao =
  | { ok: true; id: string; key: string }
  | ({ ok: false } & Recusa);

export async function criarAgente(
  dados: DadosDoAgente,
  autor: Autor,
): Promise<Criacao> {
  const parsed = agenteSchema.safeParse(dados);
  if (!parsed.success) {
    return { ok: false, ...recusaDeValidacao(parsed.error.issues) };
  }

  const modeloInvalido = await validarModelo(parsed.data.model);
  if (modeloInvalido) return { ok: false, ...modeloInvalido };

  const jaExiste = await db.agent.findUnique({
    where: { name: parsed.data.name },
  });
  if (jaExiste) {
    return {
      ok: false,
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
      ownerId: autor.userId,
      updatedById: autor.userId,
      versions: {
        create: {
          version: 1,
          systemPrompt: parsed.data.systemPrompt,
          model: parsed.data.model,
          effort: parsed.data.effort,
          note: "Versão inicial",
          createdById: autor.userId,
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

  await auditar(autor, "agent.created", "Agent", agente.id);

  revalidatePath("/agentes");
  return { ok: true, id: agente.id, key: agente.key };
}

export type Atualizacao =
  | { ok: true; mudouComportamento: boolean; versao: number | null }
  | ({ ok: false } & Recusa);

/**
 * Grava os campos do formulário do agente.
 *
 * `promptEsperado` é a trava de concorrência do MCP: a escrita só acontece se
 * o prompt no banco ainda for aquele. Vai no `where` do próprio UPDATE, e não
 * numa leitura antes dele — ler, comparar e depois gravar deixaria uma janela
 * em que a alteração de outra pessoa seria apagada sem ninguém ver.
 */
export async function atualizarAgente(
  id: string,
  dados: DadosDoAgente,
  autor: Autor,
  opcoes: { promptEsperado?: string; nota?: string } = {},
): Promise<Atualizacao> {
  const parsed = agenteSchema.safeParse(dados);
  if (!parsed.success) {
    return { ok: false, ...recusaDeValidacao(parsed.error.issues) };
  }

  const atual = await db.agent.findUnique({ where: { id } });
  if (!atual) return { ok: false, erro: "Agente não encontrado." };

  // Só confere o modelo quando ele MUDA. Um modelo que saiu do catálogo depois
  // de escolhido travava qualquer outra edição do agente — inclusive o conserto
  // do prompt — sem ninguém ter mexido no modelo. Achado no teste de ponta a
  // ponta do MCP, em 11/09/2026; o painel tinha o mesmo defeito.
  if (parsed.data.model !== atual.model) {
    const modeloInvalido = await validarModelo(parsed.data.model);
    if (modeloInvalido) return { ok: false, ...modeloInvalido };
  }

  // Renomear para um nome em uso estourava a restrição única do banco, e a tela
  // mostrava só um código de falha.
  if (parsed.data.name !== atual.name) {
    const homonimo = await db.agent.findUnique({
      where: { name: parsed.data.name },
      select: { id: true },
    });
    if (homonimo) {
      return {
        ok: false,
        erro: "Já existe um agente com esse nome.",
        camposComErro: { name: "Nome em uso" },
      };
    }
  }

  // Versiona só quando o que define o comportamento muda — evita encher o
  // histórico com edições de nome ou descrição.
  const mudouComportamento =
    atual.systemPrompt !== parsed.data.systemPrompt ||
    atual.model !== parsed.data.model ||
    atual.effort !== parsed.data.effort;

  const campos = {
    ...parsed.data,
    description: parsed.data.description || null,
    routingDescription: parsed.data.routingDescription || null,
    updatedById: autor.userId,
  };

  const gravado = await db.$transaction(async (tx) => {
    if (opcoes.promptEsperado !== undefined) {
      const { count } = await tx.agent.updateMany({
        where: { id, systemPrompt: opcoes.promptEsperado },
        data: campos,
      });
      if (count === 0) return null;
    } else {
      await tx.agent.update({ where: { id }, data: campos });
    }

    if (!mudouComportamento) return { versao: null };

    const ultima = await tx.agentVersion.findFirst({
      where: { agentId: id },
      orderBy: { version: "desc" },
    });
    const versao = (ultima?.version ?? 0) + 1;
    await tx.agentVersion.create({
      data: {
        agentId: id,
        version: versao,
        systemPrompt: parsed.data.systemPrompt,
        model: parsed.data.model,
        effort: parsed.data.effort,
        note: opcoes.nota,
        createdById: autor.userId,
      },
    });
    return { versao };
  });

  if (!gravado) {
    return {
      ok: false,
      erro: "O prompt deste agente mudou depois da sua leitura. Nada foi gravado — leia o agente de novo e refaça a alteração em cima do texto atual.",
    };
  }

  await auditar(
    autor,
    mudouComportamento ? "agent.prompt.updated" : "agent.updated",
    "Agent",
    id,
    gravado.versao ? { versao: gravado.versao } : undefined,
  );

  revalidatePath(`/agentes/${id}`);
  revalidatePath("/agentes");

  return { ok: true, mudouComportamento, versao: gravado.versao };
}

export async function definirAtivo(
  id: string,
  ligar: boolean,
  autor: Autor,
): Promise<Desfecho> {
  const agente = await db.agent.findUnique({
    where: { id },
    select: { active: true, archivedAt: true, isEntry: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  // Arquivado não liga: teria um agente fora da lista principal atendendo
  // cliente. Restaurar primeiro é a ordem certa, e é decisão consciente.
  if (ligar && agente.archivedAt) {
    return {
      erro: "Este agente está arquivado. Restaure antes de ligar — e confira o prompt, que pode estar desatualizado.",
    };
  }

  if (agente.active === ligar) {
    return { ok: ligar ? "O agente já estava ligado." : "O agente já estava desligado." };
  }

  await db.agent.update({ where: { id }, data: { active: ligar } });

  await auditar(
    autor,
    ligar ? "agent.activated" : "agent.deactivated",
    "Agent",
    id,
  );

  revalidatePath("/agentes");
  revalidatePath(`/agentes/${id}`);

  if (!ligar && agente.isEntry) {
    return {
      ok: "Agente desligado.",
      aviso:
        "Ele é o agente de entrada: enquanto estiver desligado, quem atende primeiro é o agente do bot que recebeu a mensagem.",
    };
  }
  return { ok: ligar ? "Agente ligado: ele volta a atender." : "Agente desligado." };
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
export async function definirEntrada(
  id: string,
  autor: Autor,
): Promise<Desfecho> {
  const agente = await db.agent.findUnique({
    where: { id },
    select: { active: true, archivedAt: true, isEntry: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  // Arquivar limpa `isEntry`; pôr de volta um arquivado como entrada desfaria
  // isso pela porta dos fundos.
  if (agente.archivedAt) {
    return { erro: "Agente arquivado não pode ser a entrada. Restaure e ligue antes." };
  }

  if (!agente.isEntry) {
    await db.$transaction([
      db.agent.updateMany({
        where: { isEntry: true, id: { not: id } },
        data: { isEntry: false },
      }),
      db.agent.update({ where: { id }, data: { isEntry: true } }),
    ]);

    await auditar(autor, "agent.entry.set", "Agent", id);

    revalidatePath("/agentes");
    revalidatePath(`/agentes/${id}`);
  }

  if (!agente.active) {
    return {
      ok: "Definido como agente de entrada.",
      aviso:
        "Definido como entrada, mas o agente está desligado — enquanto isso, quem atende é o agente do bot que recebeu a mensagem.",
    };
  }
  return { ok: "Definido como agente de entrada." };
}

/**
 * Tira o agente de circulação sem perder nada.
 *
 * Desliga na hora — arquivado que continuasse atendendo seria o pior dos dois
 * mundos — e limpa `isEntry`, senão o painel ficaria com um agente de entrada
 * que não atende e o roteamento cairia silenciosamente na porta.
 *
 * Prompt, modelo, integrações, versões e histórico ficam intactos.
 */
export async function arquivar(id: string, autor: Autor): Promise<Desfecho> {
  const agente = await db.agent.findUnique({
    where: { id },
    select: { archivedAt: true, isEntry: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };
  if (agente.archivedAt) return { erro: "Este agente já está arquivado." };

  await db.agent.update({
    where: { id },
    data: {
      archivedAt: new Date(),
      active: false,
      isEntry: false,
      updatedById: autor.userId,
    },
  });

  await auditar(autor, "agent.archived", "Agent", id);
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
 *
 * ⚠ Recusa agente que não está arquivado. Sem isso, "restaurar" um agente
 * ativo o DESLIGARIA — o painel nunca oferece esse botão, mas o MCP aceita
 * qualquer id.
 */
export async function restaurar(id: string, autor: Autor): Promise<Desfecho> {
  const agente = await db.agent.findUnique({
    where: { id },
    select: { archivedAt: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };
  if (!agente.archivedAt) return { erro: "Este agente não está arquivado." };

  await db.agent.update({
    where: { id },
    data: { archivedAt: null, active: false, updatedById: autor.userId },
  });

  await auditar(autor, "agent.restored", "Agent", id);
  revalidatePath("/agentes");
  revalidatePath(`/agentes/${id}`);

  return { ok: "Restaurado, e desligado. Confira o prompt antes de ligar." };
}
