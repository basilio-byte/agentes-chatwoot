import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { dentroDoHorario } from "@/server/cobranca/regras";
import { abrirClickUp } from "@/server/integrations/clickup/sistema";
import type { ClickUpClient } from "@/server/integrations/clickup/client";

import { casarContratosComTarefas } from "./casamento";
import { lerTarefasDoFluxo, type TarefaDoFluxo } from "./clickup";
import {
  CAMPO_REAJUSTE,
  CAMPO_VALOR_CONTRATO,
  chaveDaPropagacao,
  comentarioDaPropagacao,
  confereOCliente,
  decidirPercentual,
  decidirStatus,
  decidirValor,
  dentroDaJanela,
  loteChegou,
  PAUSA_ENTRE_TAREFAS_MS,
  PROPAGACOES_POR_RODADA,
  DIAS_PARA_PROPAGAR,
  type DesfechoDaPropagacao,
  type RetratoParaPropagar,
} from "./propagacao";
import { PROVIDER_RENOVACAO } from "./regras";

/**
 * A rodada que leva o reajuste do Conexa para a tarefa do ClickUp — fase 2 da
 * renovação. As regras, e o porquê de cada uma, estão em `propagacao.ts`.
 *
 * ⚠ **Só abre o ClickUp quando há candidato.** A pergunta "o lote passou em
 * algum contrato da leva?" é respondida por uma consulta ao nosso banco, sobre
 * as linhas que a rodada do retrato já gravou. Rodada sem candidato não custa
 * uma chamada externa — é a mesma doutrina do presente de aniversário, que só
 * abre o Conexa com pedido esperando.
 *
 * ⚠ **Reserva antes de escrever**, e a reserva é desfeita quando NADA é
 * gravado: propagação que falhou não pode contar como feita. A chave é
 * `reajuste:<contrato>:<data do reajuste>`, então rodar de novo não escreve de
 * novo, e o reajuste do ano seguinte é outra chave.
 */

/** De meia em meia hora, em horário comercial. O lote é mensal; isto é folga. */
export const CONFERIR_A_CADA_MS = 30 * 60_000;

/** O desfecho da rodada fica aqui, um por dia, ao lado do retrato. */
export const CHAVE_DA_RODADA = "propagacao";

let ultimaConferencia = 0;
let rodando = false;

export type RodadaDePropagacao = {
  acao:
    | "cedo"
    | "em andamento"
    | "fora do horário"
    | "nada a propagar"
    | "sem clickup"
    | "propagado";
  motivo?: string;
  candidatos?: number;
  propagados?: number;
  /** Candidatos que a rodada olhou e não escreveu, com o motivo. */
  pendentes?: string[];
  desfechos?: DesfechoDaPropagacao[];
  tarefasCompletas?: boolean;
  erro?: string;
};

/**
 * Os contratos cujo lote de reajuste já passou e que ainda não foram
 * propagados.
 *
 * `loteChegou` é a mesma régua que `decidirRetrato` usa para congelar o valor:
 * o reajuste de agora não é o que o retrato viu. A janela de
 * `DIAS_PARA_PROPAGAR` evita que todo reajuste já visto fique na fila para
 * sempre.
 */
export async function candidatosDaPropagacao(hoje: string) {
  const corte = (() => {
    const [a, m, d] = hoje.split("-").map(Number);
    const base = new Date(Date.UTC(a, m - 1, d - DIAS_PARA_PROPAGAR));
    return base.toISOString().slice(0, 10);
  })();

  const linhas = await db.retratoDeRenovacao.findMany({
    where: { reajusteEm: { not: null, gte: corte } },
    select: {
      contratoId: true,
      clienteId: true,
      leva: true,
      fidelidade: true,
      valorCentavos: true,
      valorAtualCentavos: true,
      reajusteDoRetrato: true,
      reajusteEm: true,
      reajustePct: true,
      reajusteIndice: true,
      periodicidade: true,
    },
    orderBy: { reajusteEm: "desc" },
  });

  const comLote = linhas.filter(
    (l) => loteChegou(l as RetratoParaPropagar) && dentroDaJanela(l, hoje),
  ) as RetratoParaPropagar[];
  if (!comLote.length) return { candidatos: [], tomadas: new Map<number, Set<string>>() };

  // O que já foi propagado sai da fila pela reserva, não por campo novo.
  const jaFeitos = await db.webhookEvent.findMany({
    where: {
      provider: PROVIDER_RENOVACAO,
      externalId: { in: comLote.map(chaveDaPropagacao) },
    },
    select: { externalId: true, detalhe: true },
  });
  const feitos = new Map(jaFeitos.map((e) => [e.externalId, e.detalhe ?? null]));

  // ⚠ As tarefas que um contrato JÁ levou. Cliente com contratos iguais e
  // tarefas iguais (quatro e quatro) pode ter só parte do lote propagada numa
  // rodada; sem isto, a rodada seguinte casaria o contrato que falta com uma
  // tarefa que já foi escrita — e a que ficou para trás nunca seria atualizada.
  const tomadas = new Map<number, Set<string>>();
  for (const r of comLote) {
    const detalhe = feitos.get(chaveDaPropagacao(r));
    const tarefaId = detalhe ? /"tarefaId":"([^"]+)"/.exec(detalhe)?.[1] : undefined;
    if (!tarefaId) continue;
    const doCliente = tomadas.get(r.clienteId) ?? new Set<string>();
    doCliente.add(tarefaId);
    tomadas.set(r.clienteId, doCliente);
  }

  return { candidatos: comLote.filter((r) => !feitos.has(chaveDaPropagacao(r))), tomadas };
}

/** O valor de um campo personalizado na tarefa, como número. */
function numeroDoCampo(tarefa: { custom_fields?: Array<{ id: string; value?: unknown }> }, id: string) {
  const campo = tarefa.custom_fields?.find((c) => c.id === id);
  if (campo?.value == null || campo.value === "") return null;
  const n = Number(campo.value);
  return Number.isFinite(n) ? n : null;
}

function textoDoCampo(tarefa: { custom_fields?: Array<{ id: string; value?: unknown }> }, id: string) {
  const campo = tarefa.custom_fields?.find((c) => c.id === id);
  return typeof campo?.value === "string" ? campo.value : null;
}

/** O `CONEXA LINK` da Base de clientes. */
const CAMPO_CONEXA_LINK = "4f3ca1c7-2933-49d5-b2de-d6e9c8d506bd";

export async function propagarReajustes(
  opcoes: { forcar?: boolean } = {},
  agora = new Date(),
): Promise<RodadaDePropagacao> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  if (!opcoes.forcar && !dentroDoHorario(agora)) return { acao: "fora do horário" };
  rodando = true;
  ultimaConferencia = agora.getTime();

  try {
    const hoje = diaEmSaoPaulo(agora);
    const { candidatos, tomadas } = await candidatosDaPropagacao(hoje);
    if (!candidatos.length) return { acao: "nada a propagar" };

    const clickup = await abrirClickUp("propagação da renovação");
    if ("erro" in clickup) {
      return { acao: "sem clickup", motivo: clickup.erro, candidatos: candidatos.length };
    }

    const { tarefas, completa } = await lerTarefasDoFluxo(clickup.cliente);
    const porCliente = new Map<number, TarefaDoFluxo[]>();
    for (const t of tarefas) {
      if (t.clienteId === null) continue;
      const lista = porCliente.get(t.clienteId) ?? [];
      lista.push(t);
      porCliente.set(t.clienteId, lista);
    }

    const desfechos: DesfechoDaPropagacao[] = [];
    const pendentes: string[] = [];
    // ⚠ O teto conta as tarefas ABERTAS, não as escritas: cada uma custa a
    // leitura ao vivo, e é a conta de chamadas que o teto protege.
    let olhados = 0;

    // ⚠ O cliente é a unidade de trabalho, não o contrato: quem tem quatro
    // contratos e quatro tarefas precisa que as quatro sejam casadas JUNTAS, ou
    // o pareamento de uma rodada desfaria o da seguinte.
    const contratosPorCliente = new Map<number, RetratoParaPropagar[]>();
    for (const r of candidatos) {
      const lista = contratosPorCliente.get(r.clienteId) ?? [];
      lista.push(r);
      contratosPorCliente.set(r.clienteId, lista);
    }

    for (const [clienteId, doCliente] of contratosPorCliente) {
      if (olhados >= PROPAGACOES_POR_RODADA) break;

      // Tarefa que um contrato deste lote já levou não volta ao páreo.
      const jaTomadas = tomadas.get(clienteId);
      const tarefasDoCliente = (porCliente.get(clienteId) ?? []).filter(
        (t) => !jaTomadas?.has(t.id),
      );

      // ⚠ Cada tarefa é o contrato de UM produto (Duda, 13/11/2026): cliente com
      // várias tarefas tem vários contratos, cada um com a sua data de
      // reajuste, e TODOS precisam ser reajustados. O que liga um contrato à
      // tarefa é o valor e a data de reajuste (ver `casamento.ts`); o que não
      // casa com segurança fica pendente com o motivo, nunca vai para a
      // primeira da lista.
      const casamento = casarContratosComTarefas(
        doCliente.map((retrato) => ({
          id: retrato.contratoId,
          fidelidade: retrato.fidelidade ?? null,
          antes: retrato.valorCentavos / 100,
          atual: retrato.valorAtualCentavos / 100,
          assinatura: [
            retrato.valorCentavos,
            retrato.valorAtualCentavos,
            retrato.fidelidade,
            retrato.reajusteEm,
            retrato.reajustePct,
            retrato.reajusteIndice,
            retrato.periodicidade,
          ].join("|"),
          retrato,
        })),
        tarefasDoCliente.map((t) => ({
          id: t.id,
          valor: t.valor ?? null,
          dataDeReajuste: t.dataDeReajuste ?? null,
          status: t.status,
          tarefa: t,
        })),
      );

      for (const { contrato, motivo } of [...casamento.semTarefa, ...casamento.ambiguos]) {
        pendentes.push(`${clienteId}: contrato ${contrato.id}: ${motivo}`);
      }

      // Cliente inteiro ou nada: se não cabe na rodada, fica para a seguinte
      // (a menos que seja o primeiro, que nunca ficaria).
      if (olhados > 0 && olhados + casamento.pares.length > PROPAGACOES_POR_RODADA) break;

      for (const par of casamento.pares) {
        olhados++;
        try {
          desfechos.push(await propagarUm(clickup.cliente, par.contrato.retrato, par.tarefa.tarefa));
        } catch (erro) {
          pendentes.push(`${clienteId}: contrato ${par.contrato.id}: ${(erro as Error).message}`);
        }

        await new Promise((r) => setTimeout(r, PAUSA_ENTRE_TAREFAS_MS));
      }
    }

    const propagados = desfechos.filter(
      (d) => d.valorEscrito != null || d.percentualEscrito != null || d.statusNovo != null,
    ).length;

    const rodada: RodadaDePropagacao = {
      acao: "propagado",
      candidatos: candidatos.length,
      propagados,
      pendentes,
      desfechos,
      tarefasCompletas: completa,
    };
    await registrarRodada(agora, propagados ? "propagado" : "nada escrito", rodada);
    return rodada;
  } catch (erro) {
    logger.error({ erro }, "propagação da renovação falhou");
    await registrarRodada(agora, "falhou", { erro: (erro as Error).message });
    throw erro;
  } finally {
    rodando = false;
  }
}

/**
 * Um contrato: lê a tarefa ao vivo, decide, reserva, escreve e comenta.
 *
 * ⚠ **Lê a tarefa de novo** em vez de usar o que veio na listagem: entre a
 * listagem e a escrita alguém pode ter digitado o valor à mão, e é justamente
 * esse valor que `decidirValor` tem de ver.
 *
 * ⚠ **Cada escrita tem o seu `try`.** Um campo que o ClickUp recusa não pode
 * custar os outros nem o comentário — é a lição do cadastro completo.
 */
async function propagarUm(
  cliente: Pick<
    ClickUpClient,
    "obterTarefa" | "definirCampoPersonalizado" | "atualizarTarefa" | "comentarTarefa"
  >,
  retrato: RetratoParaPropagar,
  naListagem: TarefaDoFluxo,
): Promise<DesfechoDaPropagacao> {
  const tarefa = await cliente.obterTarefa(naListagem.id);

  const confere = confereOCliente(retrato.clienteId, textoDoCampo(tarefa, CAMPO_CONEXA_LINK));
  if (!confere.confere) {
    return {
      contratoId: retrato.contratoId,
      clienteId: retrato.clienteId,
      problemas: [confere.motivo],
    };
  }

  const valor = decidirValor(numeroDoCampo(tarefa, CAMPO_VALOR_CONTRATO), retrato);
  const percentual = decidirPercentual(numeroDoCampo(tarefa, CAMPO_REAJUSTE), retrato);
  const status = decidirStatus(tarefa.status?.status);

  // Nada a escrever: a reserva fecha o assunto como "já estava em dia", senão
  // este contrato voltaria à fila de meia em meia hora até a janela fechar.
  const temAlgoAFazer = valor.escreve || percentual.escreve || status.avanca;

  const chave = chaveDaPropagacao(retrato);
  let reservaId: string;
  try {
    const linha = await db.webhookEvent.create({
      data: {
        provider: PROVIDER_RENOVACAO,
        externalId: chave,
        eventType: "propagacao",
        payload: {},
        resultado: "reservado",
      },
      select: { id: true },
    });
    reservaId = linha.id;
  } catch {
    // Outra rodada chegou primeiro. Não é erro e não vira pendência.
    return { contratoId: retrato.contratoId, clienteId: retrato.clienteId, problemas: [] };
  }

  const desfecho: DesfechoDaPropagacao = {
    contratoId: retrato.contratoId,
    clienteId: retrato.clienteId,
    tarefaId: tarefa.id,
    problemas: [],
  };

  if (valor.escreve) {
    try {
      await cliente.definirCampoPersonalizado(tarefa.id, CAMPO_VALOR_CONTRATO, valor.valor);
      desfecho.valorEscrito = valor.valor;
    } catch (erro) {
      desfecho.problemas.push(`VALOR CONTRATO: ${(erro as Error).message}`);
    }
  }

  if (percentual.escreve) {
    try {
      await cliente.definirCampoPersonalizado(tarefa.id, CAMPO_REAJUSTE, percentual.valor);
      desfecho.percentualEscrito = percentual.valor;
    } catch (erro) {
      desfecho.problemas.push(`REAJUSTE: ${(erro as Error).message}`);
    }
  }

  if (status.avanca) {
    try {
      await cliente.atualizarTarefa(tarefa.id, { status: status.para });
      desfecho.statusNovo = status.para;
    } catch (erro) {
      desfecho.problemas.push(`status: ${(erro as Error).message}`);
    }
  }

  // O comentário vai depois, e conta o que de fato aconteceu — inclusive o que
  // não foi feito e por quê.
  const escreveu =
    desfecho.valorEscrito != null || desfecho.percentualEscrito != null || desfecho.statusNovo != null;
  if (escreveu) {
    try {
      await cliente.comentarTarefa(
        tarefa.id,
        comentarioDaPropagacao({
          retrato,
          valor: desfecho.valorEscrito != null ? valor : { escreve: false, motivo: motivoDe(valor, desfecho.problemas, "VALOR CONTRATO") },
          percentual:
            desfecho.percentualEscrito != null
              ? percentual
              : { escreve: false, motivo: motivoDe(percentual, desfecho.problemas, "REAJUSTE") },
          status: desfecho.statusNovo ? status : { avanca: false, motivo: motivoDe(status, desfecho.problemas, "status") },
          linkDoConexa: textoDoCampo(tarefa, CAMPO_CONEXA_LINK),
        }),
      );
    } catch (erro) {
      desfecho.problemas.push(`comentário: ${(erro as Error).message}`);
    }
  }

  if (!escreveu && temAlgoAFazer) {
    // Tinha o que fazer e nada entrou: a reserva é desfeita para a rodada
    // seguinte tentar de novo.
    await db.webhookEvent.delete({ where: { id: reservaId } }).catch(() => {});
    return desfecho;
  }

  await db.webhookEvent
    .update({
      where: { id: reservaId },
      data: {
        resultado: escreveu ? (desfecho.problemas.length ? "propagado em parte" : "propagado") : "já estava em dia",
        detalhe: JSON.stringify(desfecho).slice(0, 2000),
        processedAt: new Date(),
      },
    })
    .catch((erro) => logger.error({ erro }, "não consegui fechar a reserva da propagação"));

  return desfecho;
}

/**
 * O motivo que vai para o comentário quando um campo não foi escrito: o da
 * decisão, ou o erro do ClickUp se a escrita é que falhou.
 */
function motivoDe(
  decisao: { escreve: boolean; motivo?: string } | { avanca: boolean; motivo?: string },
  problemas: string[],
  prefixo: string,
) {
  const falha = problemas.find((p) => p.startsWith(`${prefixo}:`));
  if (falha) return `o ClickUp recusou a escrita — ${falha.slice(prefixo.length + 2)}`;
  return decisao.motivo ?? "sem motivo registrado";
}

async function registrarRodada(agora: Date, resultado: string, detalhe: unknown) {
  try {
    const dia = diaEmSaoPaulo(agora);
    const externalId = `${CHAVE_DA_RODADA}:${dia}`;
    await db.webhookEvent.upsert({
      where: { provider_externalId: { provider: PROVIDER_RENOVACAO, externalId } },
      create: {
        provider: PROVIDER_RENOVACAO,
        externalId,
        eventType: "propagacao-rodada",
        payload: {},
        resultado,
        detalhe: JSON.stringify(detalhe).slice(0, 2000),
        processedAt: agora,
      },
      update: {
        resultado,
        detalhe: JSON.stringify(detalhe).slice(0, 2000),
        processedAt: agora,
      },
    });
  } catch (erro) {
    logger.error({ erro }, "não consegui registrar o desfecho da propagação");
  }
}

/** As últimas rodadas de propagação, para o MCP. */
export async function ultimasPropagacoes(limite = 5) {
  return db.webhookEvent.findMany({
    where: { provider: PROVIDER_RENOVACAO, externalId: { startsWith: `${CHAVE_DA_RODADA}:` } },
    select: { externalId: true, resultado: true, detalhe: true, processedAt: true },
    orderBy: { createdAt: "desc" },
    take: limite,
  });
}
