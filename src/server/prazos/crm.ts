import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  abrirClickUp,
  type ClickUpDoSistema,
} from "@/server/integrations/clickup/sistema";
import { opcaoDoVendedor } from "./vendedor";

/**
 * Quando o prazo troca quem atende, a task do CRM tem de trocar junto.
 *
 * Nasceu da conversa 13986 (16/09/2026): às 13:22 o rodízio atribuiu a Alan e o
 * CRM criou a task com Vendedor "Alan"; às 13:33 ninguém tinha respondido e a
 * conversa foi para Wellen Kelly. A task continuou no nome do Alan — e é por
 * ela que se mede quem vendeu.
 *
 * ⚠ **Só dois lugares dizem quem ATENDE** (decisão do usuário, 16/09/2026): o
 * campo `VENDEDOR` e o responsável NATIVO da task. `RESPONSÁVEL` e `E-mail do
 * responsável` são campos do CLIENTE — escrever o atendente neles apaga o dado
 * de quem contratou.
 *
 * ⚠ **Nunca lança, e nunca atrasa a troca.** Quem está esperando é o cliente; o
 * CRM é registro. O que falhar volta em `problemas` e entra no rastro do prazo.
 */

const NOME_DO_CAMPO = "VENDEDOR";
/** Janela para achar a task criada nesta conversa. A mesma do NPS. */
const DIAS = 30;

export type AtualizacaoDoCrm = {
  tarefas: { id: string; url: string | null; vendedor: string | null }[];
  problemas: string[];
};

/**
 * Passa a task desta conversa para quem assumiu.
 *
 * A task é a que um agente criou NESTA conversa, lida das `ToolCall` — nunca
 * procurada por telefone, que acharia a negociação de outro atendimento.
 */
export async function passarTarefaDoCrm(args: {
  chatwootConversationId: number;
  de: string | null;
  para: string;
  agora?: number;
}): Promise<AtualizacaoDoCrm> {
  const resultado: AtualizacaoDoCrm = { tarefas: [], problemas: [] };

  try {
    const clickup = await abrirClickUp("prazos");
    if ("erro" in clickup) {
      resultado.problemas.push(`CRM não atualizado: ${clickup.erro}`);
      return resultado;
    }

    const ids = await tarefasCriadasNaConversa(args.chatwootConversationId, args.agora ?? Date.now());
    if (ids.length === 0) return resultado;

    for (const tarefaId of ids) {
      try {
        await passarUma(clickup, tarefaId, args, resultado);
      } catch (erro) {
        resultado.problemas.push(`task ${tarefaId}: ${mensagem(erro)}`);
      }
    }
  } catch (erro) {
    resultado.problemas.push(`CRM não atualizado: ${mensagem(erro)}`);
  }

  if (resultado.problemas.length) {
    logger.warn(
      { conversa: args.chatwootConversationId, problemas: resultado.problemas },
      "prazo: CRM não atualizado por inteiro",
    );
  }
  return resultado;
}

async function passarUma(
  clickup: ClickUpDoSistema,
  tarefaId: string,
  args: { de: string | null; para: string },
  resultado: AtualizacaoDoCrm,
) {
  const tarefa = await clickup.cliente.obterTarefa(tarefaId);

  // Responsável nativo: sai quem perdeu o prazo, entra quem assumiu.
  await clickup.executar("clickup_atribuir_responsavel", {
    tarefaId,
    adicionar: [args.para],
    ...(args.de ? { remover: [args.de] } : {}),
  });

  // Campo VENDEDOR: só quando a lista tem o campo E o nome resolve para uma
  // única opção. Na dúvida fica como estava, com o motivo registrado.
  let vendedor: string | null = null;
  const listaId = tarefa.list?.id;
  const campo = listaId
    ? (await clickup.cliente.listarCamposPersonalizados(listaId)).fields.find(
        (c) => c.name?.trim().toUpperCase() === NOME_DO_CAMPO,
      )
    : undefined;

  if (campo) {
    const opcoes = (campo.type_config?.options ?? [])
      .map((o) => (o as { name?: string; label?: string }).name ?? (o as { label?: string }).label)
      .filter((n): n is string => typeof n === "string");
    const escolha = opcaoDoVendedor(args.para, opcoes);

    if ("erro" in escolha) {
      resultado.problemas.push(`${NOME_DO_CAMPO} não atualizado na task ${tarefaId}: ${escolha.erro}`);
    } else {
      await clickup.executar("clickup_definir_campo_personalizado", {
        tarefaId,
        campos: [{ campo: campo.name, valor: escolha.opcao }],
      });
      vendedor = escolha.opcao;
    }
  }

  resultado.tarefas.push({ id: tarefaId, url: tarefa.url ?? null, vendedor });
}

/** Tasks que um agente criou nesta conversa, da mais recente para a mais antiga. */
async function tarefasCriadasNaConversa(
  chatwootConversationId: number,
  agora: number,
): Promise<string[]> {
  const conversa = await db.conversation.findUnique({
    where: { chatwootConversationId },
    select: { id: true },
  });
  if (!conversa) return [];

  const chamadas = await db.toolCall.findMany({
    where: {
      toolName: "clickup_criar_tarefa",
      isError: false,
      createdAt: { gte: new Date(agora - DIAS * 24 * 60 * 60 * 1000) },
      run: { conversationId: conversa.id },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { output: true },
  });

  const ids: string[] = [];
  for (const { output } of chamadas) {
    const saida = (output ?? {}) as Record<string, unknown>;
    if (saida.criada === true && typeof saida.id === "string" && !ids.includes(saida.id)) {
      ids.push(saida.id);
    }
  }
  return ids;
}

const mensagem = (erro: unknown) => (erro instanceof Error ? erro.message : String(erro));
