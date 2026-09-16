import { db } from "@/lib/db";
import { decifrar } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { DIAS_DE_REGISTRO } from "@/server/conversa-marcada/mensagem";
import { clickupIntegration, resolverLista } from "@/server/integrations/clickup";
import { ClickUpClient } from "@/server/integrations/clickup/client";
import {
  clickupConfigSchema,
  type ClickUpConfig,
} from "@/server/integrations/clickup/config";
import type { ToolContext } from "@/server/integrations/types";
import type { NpsConfig } from "./config";
import { notaSemCrm } from "./regras";

/**
 * Onde a pesquisa de satisfação toca o CRM do ClickUp: a task do atendimento
 * recebe a nota quando ela chega.
 *
 * ⚠ **E só isso.** O webhook do n8n movia para "analise" TODAS as tasks daquele
 * telefone no CRM de Atendimentos quando a pesquisa saía, inclusive as fechadas
 * havia meses. Decisão do usuário (16/09/2026): a task fica no status em que
 * estiver. Nada aqui chama `clickup_mudar_status`.
 *
 * ⚠ Pelas MESMAS ferramentas que os agentes usam, chamadas sem modelo. A busca
 * por telefone confere o número gravado em cada task e aplica a janela de dias;
 * reescrevê-la aqui seria capacidade duplicada, e a cópia é a que diverge — a
 * nota do n8n foi parar numa task de maio por buscar telefone do próprio jeito.
 */

const DIA = 24 * 60 * 60 * 1000;

type ClickUpDoSistema = {
  cliente: ClickUpClient;
  config: ClickUpConfig;
  executar: (ferramenta: string, entrada: unknown) => Promise<unknown>;
};

async function abrirClickUp(): Promise<ClickUpDoSistema | { erro: string }> {
  const integracao = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CLICKUP },
    include: { credential: true },
  });
  // Desligado no painel é desligado para todo mundo, inclusive para o sistema.
  if (!integracao?.enabled) return { erro: "a integração do ClickUp está desligada" };
  if (!integracao.credential) return { erro: "o ClickUp está sem token" };

  const config = clickupConfigSchema.safeParse(integracao.config);
  if (!config.success) return { erro: "a configuração do ClickUp está incompleta" };

  let credential: string;
  try {
    credential = decifrar(integracao.credential);
  } catch {
    return { erro: "não consegui decifrar o token do ClickUp" };
  }

  const ctx: ToolContext = {
    provider: IntegrationProvider.CLICKUP,
    config: integracao.config as Record<string, unknown>,
    credential,
    // Nenhuma ferramenta do ClickUp lê o agente: o rótulo só diz quem chamou.
    agentId: "sistema-nps",
  };

  return {
    cliente: new ClickUpClient(credential),
    config: config.data,
    async executar(ferramenta, entrada) {
      const definicao = clickupIntegration.tools.find((t) => t.name === ferramenta);
      if (!definicao) throw new Error(`a ferramenta ${ferramenta} não existe`);
      return definicao.execute(definicao.inputSchema.parse(entrada), ctx);
    },
  };
}

export type TarefaDoAtendimento = {
  id: string;
  url: string | null;
  /** Criada por um agente nesta conversa, ou achada pelo telefone. */
  origem: "conversa" | "telefone";
};

/**
 * A task deste atendimento numa lista do CRM (decisão do usuário, 15/09/2026):
 * a que um agente criou NESTA conversa; sem ela, a mais recente do telefone,
 * criada ou atualizada nos últimos 30 dias. Sem as duas, nenhuma.
 */
async function tarefaDoAtendimento(
  clickup: ClickUpDoSistema,
  args: {
    conversaLocalId: string | null;
    listaId: string;
    telefone: string | null;
    campoDoTelefone: string;
    agora: number;
  },
): Promise<TarefaDoAtendimento | null> {
  if (args.conversaLocalId) {
    const chamadas = await db.toolCall.findMany({
      where: {
        toolName: "clickup_criar_tarefa",
        isError: false,
        createdAt: { gte: new Date(args.agora - DIAS_DE_REGISTRO * DIA) },
        run: { conversationId: args.conversaLocalId },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { output: true },
    });

    for (const { output } of chamadas) {
      const saida = objeto(output);
      if (saida.criada !== true || typeof saida.id !== "string") continue;

      try {
        // O retorno da criação traz o NOME da lista; o id vem da própria task.
        const tarefa = await clickup.cliente.obterTarefa(saida.id);
        if (tarefa.list?.id !== args.listaId) continue;
        return { id: tarefa.id, url: tarefa.url ?? null, origem: "conversa" };
      } catch (erro) {
        // Apagada, ou fora do alcance do token: vale a próxima.
        logger.warn(
          { tarefa: saida.id, erro: mensagemDe(erro) },
          "NPS: task criada na conversa não pôde ser lida",
        );
      }
    }
  }

  if (!args.telefone) return null;

  const busca = objeto(
    await clickup.executar("clickup_buscar_tarefas_por_telefone", {
      telefone: args.telefone,
      listas: [args.listaId],
      campo: args.campoDoTelefone,
      ultimosDias: DIAS_DE_REGISTRO,
    }),
  );
  if (typeof busca.erro === "string") throw new Error(busca.erro);

  // A ferramenta devolve da mais recente para a mais antiga.
  const primeira = Array.isArray(busca.tarefas) ? objeto(busca.tarefas[0]) : {};
  if (typeof primeira.id !== "string") return null;
  return { id: primeira.id, url: textoOuNulo(primeira.url), origem: "telefone" };
}

export type RegistroDaNota = {
  gravadas: {
    lista: string;
    tarefaId: string;
    url: string | null;
    origem: TarefaDoAtendimento["origem"];
  }[];
  problemas: string[];
  /** Nenhuma task recebeu a nota, e a nota interna com ela foi deixada. */
  notaInterna: boolean;
};

/**
 * Grava a nota no campo de cada lista configurada. Sem task nenhuma para gravar,
 * a nota vai numa nota interna da conversa. Nunca lança: o que deu errado volta
 * em `problemas`, para o rastro da pesquisa.
 */
export async function gravarNotaNoCrm(args: {
  chatwootConversationId: number;
  nota: number;
  telefone: string | null;
  config: NpsConfig;
  notaInterna: (texto: string) => Promise<boolean>;
  agora?: number;
}): Promise<RegistroDaNota> {
  const agora = args.agora ?? Date.now();
  const gravadas: RegistroDaNota["gravadas"] = [];
  const problemas: string[] = [];

  try {
    const clickup =
      args.config.listasDaNota.length > 0
        ? await abrirClickUp()
        : { erro: "nenhuma lista do CRM configurada" };

    if ("erro" in clickup) {
      problemas.push(clickup.erro);
    } else {
      const conversaLocalId = await idDaConversa(args.chatwootConversationId);

      for (const termo of args.config.listasDaNota) {
        const { listaId } = resolverLista(termo, clickup.config);
        const lista = nomeDaLista(listaId ?? termo, clickup.config);
        if (!listaId) {
          problemas.push(`${lista}: lista não encontrada`);
          continue;
        }

        try {
          const tarefa = await tarefaDoAtendimento(clickup, {
            conversaLocalId,
            listaId,
            telefone: args.telefone,
            campoDoTelefone: args.config.campoDoTelefone,
            agora,
          });
          if (!tarefa) {
            problemas.push(
              `${lista}: nenhuma task desta conversa nem do telefone nos últimos ${DIAS_DE_REGISTRO} dias`,
            );
            continue;
          }

          const falha = falhaAoGravar(
            await clickup.executar("clickup_definir_campo_personalizado", {
              tarefaId: tarefa.id,
              campos: [{ campo: args.config.campoDaNota, valor: args.nota }],
            }),
          );
          if (falha) {
            problemas.push(`${lista}: ${falha}`);
            continue;
          }

          gravadas.push({ lista, tarefaId: tarefa.id, url: tarefa.url, origem: tarefa.origem });
        } catch (erro) {
          problemas.push(`${lista}: ${mensagemDe(erro)}`);
        }
      }
    }
  } catch (erro) {
    problemas.push(`CRM: ${mensagemDe(erro)}`);
  }

  const notaInterna =
    gravadas.length === 0
      ? await args.notaInterna(notaSemCrm(args.nota, problemas))
      : false;

  return { gravadas, problemas, notaInterna };
}

/** `clickup_definir_campo_personalizado` responde em texto quando grava, e em objeto quando recusa. */
function falhaAoGravar(saida: unknown): string | null {
  if (typeof saida === "string") return /preenchido/.test(saida) ? null : saida;

  const recusa = objeto(saida);
  if (typeof recusa.erro !== "string") return null;

  const motivos = Array.isArray(recusa.problemas)
    ? recusa.problemas
        .map((p) => objeto(p).motivo)
        .filter((m): m is string => typeof m === "string")
    : [];
  return [recusa.erro, ...motivos].join(" ");
}

async function idDaConversa(chatwootConversationId: number): Promise<string | null> {
  const conversa = await db.conversation.findUnique({
    where: { chatwootConversationId },
    select: { id: true },
  });
  return conversa?.id ?? null;
}

/** O apelido cadastrado no ClickUp, que é o que a equipe reconhece. */
function nomeDaLista(listaId: string, config: ClickUpConfig): string {
  return config.listasNomeadas.find((l) => l.listId === listaId)?.nome ?? `lista ${listaId}`;
}

function objeto(valor: unknown): Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

function textoOuNulo(valor: unknown): string | null {
  return typeof valor === "string" && valor ? valor : null;
}

function mensagemDe(erro: unknown) {
  return erro instanceof Error ? erro.message : String(erro);
}
