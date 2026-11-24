import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { agoraEmSaoPaulo } from "@/lib/tempo";
import { ClickUpApiError } from "@/server/integrations/clickup/client";
import { ETIQUETA_DE_VENDA_GANHA } from "@/server/integrations/clickup/repeticao";
import {
  abrirClickUp,
  type ClickUpDoSistema,
} from "@/server/integrations/clickup/sistema";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";
import {
  CAMPO_STATUS_CRM,
  LISTA_DO_CRM_COMERCIAL,
  STATUS_PERDIDO,
  celularDoCrm,
  classificacaoDoProduto,
  comentarioDaPerda,
  decidirPerda,
  statusCrmDaTarefa,
} from "./follow-up";

/**
 * A última etapa do follow-up no CRM: o lead que não respondeu fica PERDIDO,
 * com motivo "Não respondeu" — do jeito que a equipe marca à mão (conferido em
 * 24/11/2026 numa task marcada pelo Alan): o status da task NÃO muda; mudam
 * Status CRM, Motivo de perda e Data perdido.
 *
 * Qual task:
 * 1. **A que um agente criou NESTA conversa, neste atendimento** (`ToolCall` de
 *    `clickup_criar_tarefa`, `criada` ou `jaExistia`, depois do último corte do
 *    histórico) — nunca procurada por telefone, que acharia a negociação de
 *    outro atendimento, talvez de uma pessoa da equipe.
 * 2. Sem ela, **se o telefone já tem task em andamento no CRM, nada é feito**:
 *    é outro atendimento, e marcar como perdido o que alguém está trabalhando
 *    seria pior do que não registrar.
 * 3. Sem nenhuma das duas, **a task é criada para o registro** e marcada como
 *    perdida: o lead parou antes de o agente registrá-lo (em Salas Privativas o
 *    registro só acontece depois da sexta resposta), e "perder no CRM" é a única
 *    marca de que ele existiu.
 *
 * ⚠ **Nunca lança.** A conversa é encerrada de qualquer jeito; o que falhar aqui
 * volta em `problemas` e vai para a nota interna.
 */

const DIA = 24 * 60 * 60 * 1000;
/** Até onde olhar para trás nas ferramentas da conversa, se o histórico não foi cortado. */
const DIAS = 30;
/**
 * As regras de criação do ClickBot rodam ~2 s depois da criação e preenchem o
 * Status CRM; marcar antes seria desfeito. A mesma espera da devolução ao
 * Backlog (`devolucao-ao-backlog.ts`).
 */
const ESPERA_DAS_REGRAS_MS = 5_000;

export type PerdaNoCrm = {
  tarefa: { id: string; url: string | null; origem: "conversa" | "criada" } | null;
  /** O Status CRM ficou Perdido (conferido lendo a task de volta). */
  marcada: boolean;
  /** Por que nada foi escrito, quando nada foi escrito de propósito. */
  observacao: string | null;
  problemas: string[];
};

export async function perderNoCrm(args: {
  chatwootConversationId: number;
  contato: { nome: string | null; telefone: string | null };
  produto: string | null;
  agente: string;
  minutos: number;
  linkDaConversa: string | null;
  agora?: number;
  esperar?: (ms: number) => Promise<void>;
}): Promise<PerdaNoCrm> {
  const agora = args.agora ?? Date.now();
  const esperar = args.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const resultado: PerdaNoCrm = { tarefa: null, marcada: false, observacao: null, problemas: [] };

  try {
    const clickup = await abrirClickUp("follow-up");
    if ("erro" in clickup) {
      resultado.problemas.push(`CRM não atualizado: ${clickup.erro}`);
      return resultado;
    }

    const daConversa = await tarefaDaConversa(clickup, args.chatwootConversationId, agora);
    let tarefa = daConversa;
    let criadaAgora = false;

    if (!tarefa) {
      const telefone = args.contato.telefone;
      if (telefone) {
        const busca = objeto(
          await clickup.executar("clickup_buscar_tarefas_por_telefone", {
            telefone,
            listas: [LISTA_DO_CRM_COMERCIAL],
            ultimosDias: DIAS,
          }),
        );
        if (typeof busca.erro === "string") {
          // Na dúvida, não cria: task em dobro no CRM é o defeito que três travas
          // já existem para segurar.
          resultado.problemas.push(`CRM não atualizado: a busca pelo telefone falhou (${busca.erro})`);
          return resultado;
        }
        const achadas = (Array.isArray(busca.tarefas) ? busca.tarefas : []).map(objeto);
        const emAndamento = achadas.find((t) => t.emAndamento === true);
        if (emAndamento) {
          resultado.observacao = `o telefone já tem a task ${textoOuNulo(emAndamento.url) ?? String(emAndamento.id)} em andamento no CRM Comercial, de outro atendimento — não mexi nela nem criei outra`;
          return resultado;
        }
        // Já perdido há pouco (por esta cadeia ou pela equipe): outra task
        // perdida do mesmo telefone só dobraria o lead na contagem.
        for (const achada of achadas.slice(0, 3)) {
          if (typeof achada.id !== "string") continue;
          const lida = await clickup.cliente.obterTarefa(achada.id);
          if (statusCrmDaTarefa(lida.custom_fields ?? []) === STATUS_PERDIDO) {
            resultado.observacao = `o telefone já tem a task ${lida.url ?? lida.id} marcada como perdida no CRM Comercial nos últimos ${DIAS} dias — não criei outra`;
            return resultado;
          }
        }
      }

      const criada = await criarTarefaDoLead(clickup, args);
      if ("erro" in criada) {
        resultado.problemas.push(`CRM não atualizado: ${criada.erro}`);
        return resultado;
      }
      criadaAgora = true;
      await esperar(ESPERA_DAS_REGRAS_MS);
      tarefa = await clickup.cliente.obterTarefa(criada.id);
    }

    resultado.tarefa = {
      id: tarefa.id,
      url: tarefa.url ?? null,
      origem: criadaAgora ? "criada" : "conversa",
    };

    const { fields } = await clickup.cliente.listarCamposPersonalizados(LISTA_DO_CRM_COMERCIAL);
    const valores: Record<string, unknown> = {};
    for (const campo of fields) {
      valores[campo.name] = tarefa.custom_fields?.find((v) => v.id === campo.id)?.value;
    }
    const decisao = decidirPerda({
      campos: fields,
      valores,
      ganha: (tarefa.tags ?? []).some(
        (t) => t.name.trim().toLowerCase() === ETIQUETA_DE_VENDA_GANHA,
      ),
      hoje: agoraEmSaoPaulo(new Date(agora)).iso,
    });
    if (decisao.acao === "deixar") {
      resultado.observacao = decisao.motivo;
      return resultado;
    }

    const falha = falhaAoGravar(
      await clickup.executar("clickup_definir_campo_personalizado", {
        tarefaId: tarefa.id,
        campos: decisao.campos,
      }),
    );
    if (falha) {
      resultado.problemas.push(`campos da perda não gravados: ${falha}`);
      return resultado;
    }

    try {
      await clickup.executar("clickup_comentar_tarefa", {
        tarefaId: tarefa.id,
        texto: comentarioDaPerda({
          agente: args.agente,
          minutos: args.minutos,
          linkDaConversa: args.linkDaConversa,
          criadaAgora,
        }),
      });
    } catch (erro) {
      resultado.problemas.push(`comentário na task não gravado: ${mensagemDe(erro)}`);
    }

    // Chamada sem erro não prova campo gravado: uma automação do ClickUp pode
    // ter trocado o Status CRM. Quem diz é a leitura de volta.
    const depois = await clickup.cliente.obterTarefa(tarefa.id);
    resultado.marcada = statusCrmDaTarefa(depois.custom_fields ?? []) === STATUS_PERDIDO;
    if (!resultado.marcada) {
      resultado.problemas.push(
        `o ${CAMPO_STATUS_CRM} não ficou "${STATUS_PERDIDO}" na leitura de volta — confira a task`,
      );
    }
  } catch (erro) {
    resultado.problemas.push(`CRM não atualizado: ${mensagemDe(erro)}`);
  }

  if (resultado.problemas.length) {
    logger.warn(
      { conversa: args.chatwootConversationId, problemas: resultado.problemas },
      "follow-up: lead perdido não registrado por inteiro no CRM",
    );
  }
  return resultado;
}

/**
 * A task do CRM Comercial que um agente criou (ou que a barreira de task em
 * dobro devolveu) nesta conversa, NESTE atendimento. Apagada (404) ou arquivada
 * não conta: vale a próxima.
 */
async function tarefaDaConversa(
  clickup: ClickUpDoSistema,
  chatwootConversationId: number,
  agora: number,
): Promise<ClickUpTarefa | null> {
  const conversa = await db.conversation.findUnique({
    where: { chatwootConversationId },
    select: { id: true, historicoDesde: true },
  });
  if (!conversa) return null;

  const janela = agora - DIAS * DIA;
  const desde = Math.max(janela, conversa.historicoDesde?.getTime() ?? 0);
  const chamadas = await db.toolCall.findMany({
    where: {
      toolName: "clickup_criar_tarefa",
      isError: false,
      createdAt: { gte: new Date(desde) },
      run: { conversationId: conversa.id },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { output: true },
  });

  const ids: string[] = [];
  for (const { output } of chamadas) {
    const saida = objeto(output);
    // O retorno só traz a lista desde 05/10/2026; sem ela, quem confere é a leitura.
    if (typeof saida.listaId === "string" && saida.listaId !== LISTA_DO_CRM_COMERCIAL) continue;
    const id = saida.criada === true ? saida.id : saida.jaExistia === true ? objeto(saida.tarefa).id : null;
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }

  for (const id of ids.slice(0, 3)) {
    try {
      const tarefa = await clickup.cliente.obterTarefa(id);
      if (tarefa.list?.id !== LISTA_DO_CRM_COMERCIAL || tarefa.archived) continue;
      return tarefa;
    } catch (erro) {
      if (!(erro instanceof ClickUpApiError && erro.status === 404)) throw erro;
    }
  }
  return null;
}

/**
 * Cria a task do lead que parou antes de ser registrado, só com o que o sistema
 * sabe. Os campos da perda NÃO vão aqui: as regras de criação do ClickBot
 * preencheriam o Status CRM por cima. Sem `responsavel` e sem VENDEDOR: ninguém
 * da equipe atendeu, e "Auto Venda" é venda que o agente fechou.
 */
async function criarTarefaDoLead(
  clickup: ClickUpDoSistema,
  args: {
    contato: { nome: string | null; telefone: string | null };
    produto: string | null;
    agente: string;
    linkDaConversa: string | null;
  },
): Promise<{ id: string } | { erro: string }> {
  const nome = args.contato.nome?.trim() || "Lead do WhatsApp";
  const celular = celularDoCrm(args.contato.telefone);
  const { produto, categoria, atendimento } = classificacaoDoProduto(args.produto);
  const basicos = [
    { campo: "NOME CLIENTE", valor: nome },
    ...(celular ? [{ campo: "CELULAR", valor: celular }] : []),
  ];
  const completos = [
    ...basicos,
    { campo: "TIPO DE PRODUTO", valor: produto },
    { campo: "CATEGORIA DE SERVIÇO", valor: categoria },
    { campo: "Tipo de Atendimento", valor: atendimento },
  ];
  const pedido = (camposPersonalizados: { campo: string; valor: string }[]) => ({
    nome: `CW — ${nome}`,
    lista: LISTA_DO_CRM_COMERCIAL,
    status: "sem contato",
    descricao: [
      `Lead que parou de responder ao agente ${args.agente} no WhatsApp e não respondeu ao follow-up automático.`,
      "Registrado pelo sistema para constar como perdido no CRM.",
      args.linkDaConversa ? `Conversa: ${args.linkDaConversa}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    camposPersonalizados,
  });

  // Uma opção que a lista não tenha recusa o lote inteiro: tenta de novo só com
  // nome e telefone, que bastam para o registro.
  for (const campos of [completos, basicos]) {
    const saida = objeto(await clickup.executar("clickup_criar_tarefa", pedido(campos)));
    if (saida.criada === true && typeof saida.id === "string") return { id: saida.id };
    if (!Array.isArray(saida.problemas)) {
      return { erro: `a task do lead não foi criada (${textoOuNulo(saida.erro) ?? JSON.stringify(saida).slice(0, 200)})` };
    }
  }
  return { erro: "a task do lead não foi criada: o CRM recusou os campos" };
}

/** `clickup_definir_campo_personalizado` responde em texto quando grava, e em objeto quando recusa. */
function falhaAoGravar(saida: unknown): string | null {
  if (typeof saida === "string") return /preenchido/.test(saida) ? null : saida;
  const recusa = objeto(saida);
  if (typeof recusa.erro !== "string") return null;
  const motivos = Array.isArray(recusa.problemas)
    ? recusa.problemas.map((p) => objeto(p).motivo).filter((m): m is string => typeof m === "string")
    : [];
  return [recusa.erro, ...motivos].join(" ");
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
