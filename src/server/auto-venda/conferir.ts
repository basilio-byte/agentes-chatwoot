import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { dentroDoHorario } from "@/server/cobranca/regras";
import { ClickUpApiError } from "@/server/integrations/clickup/client";
import { abrirClickUp, type ClickUpDoSistema } from "@/server/integrations/clickup/sistema";
import type { ClickUpCampoPersonalizado } from "@/server/integrations/clickup/tipos";
import { ConexaApiError } from "@/server/integrations/conexa/client";
import { abrirConexa, type ConexaDoSistema } from "@/server/integrations/conexa/sistema";
import {
  CAMPO_DATA_GANHO,
  chaveDaReserva,
  cobrancaDaVenda,
  comentarioDoGanho,
  CONFERIR_A_CADA_MS,
  decidirTarefa,
  desistirDaReserva,
  DIAS_PARA_TRAS,
  estadoDaTarefa,
  ETIQUETA_DE_VENDA_GANHA,
  lerPagamento,
  PROVIDER_AUTO_VENDA,
  RESERVAS_POR_RODADA,
  reservasDosAgentes,
  situacaoDoPagamento,
  tarefasDasConversas,
  tarefasDaReserva,
  type Chamada,
  type EstadoDaTarefa,
  type Pagamento,
  type ReservaDoAgente,
} from "./regras";

/**
 * A rodada do ganho da venda autônoma, no relógio do vigia (regras em `regras.ts`).
 *
 * - **Só abre o Conexa com reserva esperando pagamento**, e o ClickUp só com
 *   reserva paga: sem venda autônoma na fila, a rodada é uma consulta ao banco.
 * - **Cada reserva sai da fila UMA vez**, numa linha de `WebhookEvent` (provider
 *   `AUTO_VENDA`, `reserva:<id>`): "ganho" ou "encerrado", com o motivo. A
 *   unique dessa linha é a trava contra duas rodadas escrevendo na mesma task.
 * - ⚠ **Reserva antes de escrever.** A linha nasce "reservado"; se a etiqueta
 *   não entrar, ela é apagada e a rodada seguinte tenta de novo. Se o processo
 *   cair no meio, a linha fica "reservado" e nada é repetido — o comentário em
 *   dobro na task é pior que um ganho que alguém completa à mão.
 * - **Nunca por cima da equipe**: task já ganha sai da fila sem escrita, e a
 *   "Data ganho" preenchida por alguém não é trocada.
 */

let ultimaConferencia = 0;
let rodando = false;

export type RodadaDeAutoVenda = {
  acao: "cedo" | "em andamento" | "fora do horário" | "iniciada" | "conferido";
  reservas?: number;
  ganhos?: number;
  encerradas?: number;
  esperando?: number;
  falhas?: number;
  erro?: string;
};

const RESERVA_FEITA = "reservado";

/** Chamada pelo vigia a cada minuto; confere de fato a cada `CONFERIR_A_CADA_MS`. */
export async function conferirAutoVendas(
  agora = new Date(),
  opcoes: { esperar?: boolean; forcar?: boolean } = {},
): Promise<RodadaDeAutoVenda> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  // Fora do horário não conta como conferência: às 8h ela roda no primeiro minuto.
  if (!opcoes.forcar && !dentroDoHorario(agora)) return { acao: "fora do horário" };

  ultimaConferencia = agora.getTime();
  rodando = true;
  const rodada = rodar(agora)
    .catch((erro: unknown): RodadaDeAutoVenda => {
      logger.error({ erro }, "auto venda: a rodada falhou");
      return { acao: "conferido", erro: mensagem(erro) };
    })
    .finally(() => {
      rodando = false;
    });

  if (opcoes.esperar) return rodada;
  void rodada.then((r) => {
    if (r.ganhos || r.falhas || r.encerradas) logger.info(r, "auto venda: ganhos conferidos");
  });
  return { acao: "iniciada" };
}

/** Só para teste: esquece o relógio entre um caso e outro. */
export function reiniciarRelogioDaAutoVenda() {
  ultimaConferencia = 0;
  rodando = false;
}

async function rodar(agora: Date): Promise<RodadaDeAutoVenda> {
  const chamadas = await chamadasRecentes(agora);
  const tarefas = tarefasDasConversas(chamadas);
  const todas = reservasDosAgentes(chamadas);

  const vistas = new Set(
    (
      await db.webhookEvent.findMany({
        where: {
          provider: PROVIDER_AUTO_VENDA,
          externalId: { in: todas.map((r) => chaveDaReserva(r.reservaId)) },
        },
        select: { externalId: true },
      })
    ).map((e) => e.externalId),
  );
  const pendentes = todas.filter((r) => !vistas.has(chaveDaReserva(r.reservaId)));

  const rodada: RodadaDeAutoVenda = {
    acao: "conferido",
    reservas: pendentes.length,
    ganhos: 0,
    encerradas: 0,
    esperando: 0,
    falhas: 0,
  };
  if (pendentes.length === 0) return rodada;

  let conexa: ConexaDoSistema | null = null;
  let clickup: ClickUpDoSistema | null = null;
  const camposDaLista = new Map<string, ClickUpCampoPersonalizado[]>();
  let lidasNoConexa = 0;

  for (const reserva of pendentes) {
    const candidatas = tarefasDaReserva(reserva, tarefas);
    if (desistirDaReserva(reserva, agora)) {
      await encerrar(reserva, agora, "sem pagamento no prazo de espera", candidatas[0] ?? null);
      rodada.encerradas! += 1;
      continue;
    }
    // Sem task da conversa no CRM não há onde dar o ganho: espera sem gastar
    // chamada, até a reserva sair pelo prazo.
    if (candidatas.length === 0) {
      rodada.esperando! += 1;
      continue;
    }
    if (lidasNoConexa >= RESERVAS_POR_RODADA) break;

    try {
      if (!conexa) {
        const aberto = await abrirConexa("auto-venda");
        if ("erro" in aberto) return { ...rodada, erro: aberto.erro };
        conexa = aberto;
      }

      lidasNoConexa += 1;
      let bruta: Record<string, unknown>;
      try {
        bruta = await conexa.cliente.obterReserva(reserva.reservaId);
      } catch (erro) {
        if (erro instanceof ConexaApiError && erro.status === 404) {
          await encerrar(reserva, agora, "a reserva não existe mais no Conexa", candidatas[0]);
          rodada.encerradas! += 1;
          continue;
        }
        throw erro;
      }

      const situacao = situacaoDoPagamento(bruta);
      if (situacao === "pacote") {
        await encerrar(reserva, agora, "descontada do pacote de horas: não há pagamento", candidatas[0]);
        rodada.encerradas! += 1;
        continue;
      }
      if (situacao === "cancelada") {
        await encerrar(reserva, agora, "reserva cancelada no Conexa", candidatas[0]);
        rodada.encerradas! += 1;
        continue;
      }
      if (situacao === "esperando") {
        rodada.esperando! += 1;
        continue;
      }

      if (!clickup) {
        const aberto = await abrirClickUp("auto-venda");
        if ("erro" in aberto) return { ...rodada, erro: aberto.erro };
        clickup = aberto;
      }

      const achada = await tarefaDoCrm(clickup, candidatas, camposDaLista);
      if (!achada) {
        await encerrar(reserva, agora, "nenhuma task desta conversa no CRM Comercial", candidatas[0]);
        rodada.encerradas! += 1;
        continue;
      }

      const decisao = decidirTarefa(achada.estado);
      if (decisao.acao === "encerrar") {
        await encerrar(reserva, agora, decisao.motivo, achada.id);
        rodada.encerradas! += 1;
        continue;
      }
      if (decisao.acao === "esperar") {
        rodada.esperando! += 1;
        continue;
      }

      const pagamento = await pagamentoDaReserva(conexa, reserva, bruta);
      const resultado = await darGanho({ clickup, reserva, tarefaId: achada.id, estado: achada.estado, pagamento, agora });
      if (resultado === "ganho") rodada.ganhos! += 1;
      else if (resultado === "falhou") rodada.falhas! += 1;
    } catch (erro) {
      // Falha passageira (Conexa ou ClickUp fora do ar): a reserva continua na
      // fila e a rodada seguinte tenta de novo.
      rodada.falhas! += 1;
      logger.warn(
        { reserva: reserva.reservaId, erro: mensagem(erro) },
        "auto venda: reserva não conferida nesta rodada",
      );
    }
  }
  return rodada;
}

/** As chamadas de ferramenta que a rodada lê, só de execuções numa conversa. */
async function chamadasRecentes(agora: Date): Promise<Chamada[]> {
  const linhas = await db.toolCall.findMany({
    where: {
      toolName: {
        in: [
          "conexa_criar_reserva",
          "conexa_faturar_reserva",
          "clickup_criar_tarefa",
          "clickup_definir_campo_personalizado",
        ],
      },
      isError: false,
      createdAt: { gte: new Date(agora.getTime() - DIAS_PARA_TRAS * 24 * 60 * 60_000) },
      run: { conversationId: { not: null } },
    },
    orderBy: { createdAt: "asc" },
    select: {
      toolName: true,
      input: true,
      output: true,
      createdAt: true,
      run: { select: { conversationId: true } },
    },
  });
  return linhas.flatMap((l) =>
    l.run.conversationId
      ? [
          {
            toolName: l.toolName,
            input: l.input,
            output: l.output,
            createdAt: l.createdAt,
            conversaId: l.run.conversationId,
          },
        ]
      : [],
  );
}

/** A primeira candidata que está no CRM Comercial e não foi arquivada. */
async function tarefaDoCrm(
  clickup: ClickUpDoSistema,
  candidatas: string[],
  camposDaLista: Map<string, ClickUpCampoPersonalizado[]>,
): Promise<{ id: string; estado: EstadoDaTarefa } | null> {
  for (const id of candidatas) {
    let tarefa;
    try {
      tarefa = await clickup.cliente.obterTarefa(id);
    } catch (erro) {
      // Apagada ou fora do alcance do token: vale a próxima.
      if (erro instanceof ClickUpApiError && (erro.status === 404 || erro.status === 401)) continue;
      throw erro;
    }
    const listaId = tarefa.list?.id;
    if (!listaId) continue;
    let campos = camposDaLista.get(listaId);
    if (!campos) {
      campos = (await clickup.cliente.listarCamposPersonalizados(listaId)).fields;
      camposDaLista.set(listaId, campos);
    }
    const estado = estadoDaTarefa(tarefa, campos);
    if (estado.noCrmComercial && !estado.arquivada) return { id, estado };
  }
  return null;
}

/**
 * Data e valor do pagamento, pela cobrança que o agente gerou ou, sem ela (a
 * equipe faturou), pela cobrança paga do cliente que contém a venda da reserva.
 * Falhar aqui não impede o ganho: a data vira a do dia em que a rodada viu.
 */
async function pagamentoDaReserva(
  conexa: ConexaDoSistema,
  reserva: ReservaDoAgente,
  bruta: Record<string, unknown>,
): Promise<Pagamento | null> {
  try {
    if (reserva.cobrancaId) {
      const pagamento = lerPagamento(await conexa.cliente.obterCobranca(reserva.cobrancaId));
      if (pagamento) return pagamento;
    }
    const vendaId = Number(bruta.saleId);
    const clienteId = Number(bruta.customerId);
    if (!Number.isInteger(vendaId) || !Number.isInteger(clienteId)) return null;
    const { itens } = await conexa.cliente.listarCobrancas({
      customerId: clienteId,
      status: "paid",
      paymentDateFrom: diaEmSaoPaulo(new Date(reserva.criadaEm.getTime() - 24 * 60 * 60_000)),
      limit: 100,
    });
    const cobranca = cobrancaDaVenda(itens, vendaId);
    return cobranca ? lerPagamento(cobranca) : null;
  } catch (erro) {
    logger.warn(
      { reserva: reserva.reservaId, erro: mensagem(erro) },
      "auto venda: pagamento sem data (cobrança não lida)",
    );
    return null;
  }
}

async function darGanho(args: {
  clickup: ClickUpDoSistema;
  reserva: ReservaDoAgente;
  tarefaId: string;
  estado: EstadoDaTarefa;
  pagamento: Pagamento | null;
  agora: Date;
}): Promise<"ganho" | "falhou" | "outra rodada"> {
  const { clickup, reserva, tarefaId, pagamento, agora } = args;
  const dataGanho = pagamento?.pagaEm ?? diaEmSaoPaulo(agora);

  let linhaId: string;
  try {
    linhaId = (
      await db.webhookEvent.create({
        data: {
          provider: PROVIDER_AUTO_VENDA,
          externalId: chaveDaReserva(reserva.reservaId),
          eventType: "ganho",
          payload: { reservaId: reserva.reservaId, tarefaId, conversaId: reserva.conversaId },
          resultado: RESERVA_FEITA,
        },
        select: { id: true },
      })
    ).id;
  } catch (erro) {
    if ((erro as { code?: string }).code === "P2002") return "outra rodada";
    throw erro;
  }

  try {
    await clickup.executar("clickup_adicionar_tag", { tarefaId, tag: ETIQUETA_DE_VENDA_GANHA });
  } catch (erro) {
    // Nada foi escrito: desfaz a reserva e a rodada seguinte tenta de novo.
    await db.webhookEvent.delete({ where: { id: linhaId } }).catch(() => {});
    logger.warn({ tarefa: tarefaId, erro: mensagem(erro) }, "auto venda: etiqueta não aplicada");
    return "falhou";
  }

  const problemas: string[] = [];
  if (!args.estado.dataGanhoPreenchida) {
    try {
      const r = await clickup.executar("clickup_definir_campo_personalizado", {
        tarefaId,
        campos: [{ campo: CAMPO_DATA_GANHO, valor: dataGanho }],
      });
      if (r && typeof r === "object" && "erro" in r) problemas.push(`"${CAMPO_DATA_GANHO}" não preenchida`);
    } catch (erro) {
      problemas.push(`"${CAMPO_DATA_GANHO}" não preenchida: ${mensagem(erro)}`);
    }
  }
  try {
    await clickup.executar("clickup_comentar_tarefa", {
      tarefaId,
      texto: comentarioDoGanho({ reservaId: reserva.reservaId, pagamento, dataGanho }),
    });
  } catch (erro) {
    problemas.push(`comentário não publicado: ${mensagem(erro)}`);
  }

  const detalhe =
    `task ${tarefaId} · ` +
    (pagamento
      ? `cobrança ${pagamento.cobrancaId}${pagamento.pagaEm ? ` paga em ${pagamento.pagaEm}` : ""}`
      : "cobrança não lida") +
    (problemas.length ? ` · ${problemas.join("; ")}` : "");
  await db.webhookEvent.update({
    where: { id: linhaId },
    data: { resultado: "ganho", detalhe, processedAt: agora },
  });
  logger.info({ reserva: reserva.reservaId, tarefa: tarefaId, detalhe }, "auto venda: ganho dado");
  return "ganho";
}

async function encerrar(
  reserva: ReservaDoAgente,
  agora: Date,
  motivo: string,
  tarefaId: string | null,
): Promise<void> {
  try {
    await db.webhookEvent.create({
      data: {
        provider: PROVIDER_AUTO_VENDA,
        externalId: chaveDaReserva(reserva.reservaId),
        eventType: "encerrada",
        payload: { reservaId: reserva.reservaId, tarefaId, conversaId: reserva.conversaId },
        resultado: "encerrado",
        detalhe: motivo,
        processedAt: agora,
      },
    });
  } catch (erro) {
    if ((erro as { code?: string }).code !== "P2002") throw erro;
  }
}

function mensagem(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
