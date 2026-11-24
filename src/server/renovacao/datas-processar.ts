import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import type { ClickUpClient } from "@/server/integrations/clickup/client";
import { deTimestamp } from "@/server/integrations/clickup/datas";
import { paraTimestamp } from "@/server/integrations/clickup/formatacao";
import { abrirClickUp } from "@/server/integrations/clickup/sistema";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";
import type { ConexaClient } from "@/server/integrations/conexa/client";
import { abrirConexa } from "@/server/integrations/conexa/sistema";

import { CAMPO_DATA_DE_REAJUSTE, idDoClienteNaTarefa, tarefaDoFluxo } from "./clickup";
import { configDaRenovacao, hostDoConexaDaSeahub } from "./config";
import { contratoDaLeva } from "./conexa";
import {
  chaveDasDatas,
  comentarioDasDatas,
  planejarDatas,
  type ContratoParaDatas,
  type PedidoDasDatas,
} from "./datas";
import { PROVIDER_RENOVACAO, deOutraContaDoConexa, hostDoLink } from "./regras";

/**
 * Uma entrega da automação 8 do ClickUp: avança as datas da tarefa e a
 * fidelidade do contrato dela. As regras, e o porquê de cada uma, em `datas.ts`.
 *
 * ⚠⚠ **Escreve no Conexa** (`fidelityDate`), então tem três modos e nasce
 * `desligado`: `sombra` lê, planeja e registra o plano SEM escrever nada — é o
 * que permite ligar o endereço como SEGUNDA ação da automação, ao lado do n8n, e
 * conferir o plano contra o que o n8n fez; só depois vem `ligado`.
 *
 * ⚠ **Ligar exige tirar o n8n da automação no MESMO movimento.** Os dois
 * rodando avançam o contrato duas vezes (o n8n soma 365 dias a `data[0]` sem
 * olhar se já foi avançado). Daqui para o n8n não há como proteger.
 */

/** O campo "DATA DE ENCERRAMENTO CONTRATO [BASE CLIENTES]" da Base de clientes. */
export const CAMPO_DATA_DE_ENCERRAMENTO = "885c7420-baa9-4125-95cd-53934b47b147";
/** O `CONEXA LINK`. */
const CAMPO_CONEXA_LINK = "4f3ca1c7-2933-49d5-b2de-d6e9c8d506bd";

/** Entrega repetida da mesma tarefa dentro deste prazo não avança de novo. */
export const FREIO_POR_TAREFA_MS = 20 * 60 * 60_000;

export type DesfechoDasDatas = {
  resultado:
    | "desligado"
    | "recusado"
    | "ignorado"
    | "repetida"
    | "sombra"
    | "avançado"
    | "em parte"
    | "falhou";
  detalhe: string;
};

type Cliente = Pick<ClickUpClient, "obterTarefa" | "definirCampoPersonalizado" | "comentarTarefa">;
type Conexa = Pick<ConexaClient, "listarContratos" | "obterContrato" | "atualizarFidelidadeDoContrato">;

function textoDoCampo(tarefa: ClickUpTarefa, id: string) {
  const v = tarefa.custom_fields?.find((c) => c.id === id)?.value;
  return typeof v === "string" ? v : null;
}

/** As datas lidas do campo, no dia de São Paulo. */
function dataDoCampo(tarefa: ClickUpTarefa, id: string) {
  const v = tarefa.custom_fields?.find((c) => c.id === id)?.value;
  return v == null || v === "" ? null : deTimestamp(String(v));
}

export async function processarDatas(pedido: PedidoDasDatas): Promise<DesfechoDasDatas> {
  const config = await configDaRenovacao();
  if (config.avancarDatas === "desligado") {
    return { resultado: "desligado", detalhe: "o avanço de datas está desligado em Integrações → Renovação" };
  }
  const sombra = config.avancarDatas === "sombra";

  if (!pedido.tarefaId) {
    return { resultado: "recusado", detalhe: "a chamada não trouxe o id da tarefa (taskid)" };
  }

  const clickup = await abrirClickUp("avanço de datas da renovação");
  if ("erro" in clickup) return { resultado: "falhou", detalhe: `ClickUp indisponível — ${clickup.erro}` };
  const cliente = clickup.cliente as Cliente;

  let tarefa: ClickUpTarefa;
  try {
    tarefa = await cliente.obterTarefa(pedido.tarefaId);
  } catch (erro) {
    return { resultado: "falhou", detalhe: `não consegui ler a tarefa — ${(erro as Error).message}` };
  }

  // Freio por tarefa: o ClickUp repete entrega, e sem a data na URL (a chamada
  // seguinte já veria a data avançada como ponto de partida) só o relógio segura.
  if (!sombra) {
    const recente = await db.webhookEvent.findFirst({
      where: {
        provider: PROVIDER_RENOVACAO,
        externalId: { startsWith: `datas:${pedido.tarefaId}:` },
        createdAt: { gte: new Date(Date.now() - FREIO_POR_TAREFA_MS) },
      },
      select: { id: true },
    });
    if (recente) {
      return { resultado: "repetida", detalhe: "esta tarefa já teve as datas avançadas nas últimas 20 horas" };
    }
  }

  const fluxo = tarefaDoFluxo(tarefa);
  const link = textoDoCampo(tarefa, CAMPO_CONEXA_LINK);
  // ⚠ Tarefa da ONE Empreendimentos (outro Conexa): o "(72)" dela não é o
  // cliente 72 da Seahub, e o Conexa da Seahub não é tocado.
  const hostDaSeahub = await hostDoConexaDaSeahub();
  const deOutraConta = deOutraContaDoConexa(link, hostDaSeahub);
  const clienteId = deOutraConta ? null : idDoClienteNaTarefa(tarefa.name ?? "", link);

  // Os contratos do cliente, ao vivo, com o valor de antes do lote do retrato.
  let conexa: Conexa | null = null;
  const contratos: ContratoParaDatas[] = [];
  let erroDoConexa: string | null = null;
  if (clienteId) {
    const aberto = await abrirConexa("avanço de datas da renovação");
    if ("erro" in aberto) {
      erroDoConexa = aberto.erro;
    } else {
      conexa = aberto.cliente as Conexa;
      try {
        const { itens } = await conexa.listarContratos({ customerId: clienteId, isActive: 1, limit: 50 });
        const retratos = await db.retratoDeRenovacao.findMany({
          where: { clienteId },
          select: { contratoId: true, valorCentavos: true, reajusteDoRetrato: true, reajusteEm: true },
        });
        const antes = new Map(
          retratos
            // O valor do retrato só é "de antes" se foi tirado antes do lote.
            .filter((r) => r.reajusteEm !== r.reajusteDoRetrato)
            .map((r) => [r.contratoId, r.valorCentavos / 100]),
        );
        for (const bruto of itens) {
          const c = contratoDaLeva(bruto);
          if (c) {
            contratos.push({
              id: c.id,
              fidelidade: c.fidelidade,
              valor: c.valor,
              antes: antes.get(c.id) ?? null,
              ativo: c.ativo,
            });
          }
        }
      } catch (erro) {
        erroDoConexa = (erro as Error).message;
      }
    }
  }

  const plano = planejarDatas({
    tarefa: {
      id: tarefa.id,
      status: tarefa.status?.status ?? "",
      valor: fluxo.valor ?? null,
      dataDeReajuste: fluxo.dataDeReajuste ?? dataDoCampo(tarefa, CAMPO_DATA_DE_REAJUSTE),
      dataDeEncerramento: dataDoCampo(tarefa, CAMPO_DATA_DE_ENCERRAMENTO),
    },
    pedido,
    contratos,
    hoje: diaEmSaoPaulo(new Date()),
  });

  if (!plano.aplicavel) {
    return { resultado: "ignorado", detalhe: plano.motivo };
  }
  // Sem como ler o Conexa, não se afirma "nenhum contrato": o motivo é outro.
  if (erroDoConexa && !plano.contrato) {
    plano.semContrato = `não consegui ler os contratos do cliente no Conexa — ${erroDoConexa}`;
  }
  if (deOutraConta) {
    plano.semContrato = `a tarefa é de outra conta do Conexa (${hostDoLink(link)}), não da Seahub: a fidelidade não é tocada daqui`;
  }

  const chave = chaveDasDatas(tarefa.id, plano.baseDoReajuste, sombra);
  let reservaId: string;
  try {
    reservaId = (
      await db.webhookEvent.create({
        data: {
          provider: PROVIDER_RENOVACAO,
          externalId: chave,
          eventType: "datas",
          payload: {},
          resultado: "reservado",
        },
        select: { id: true },
      })
    ).id;
  } catch {
    return { resultado: "repetida", detalhe: "esta tarefa já foi tratada a partir desta data" };
  }

  const resumoDoPlano = {
    tarefaId: tarefa.id,
    base: plano.baseDoReajuste,
    reajusteNovo: plano.escreverReajuste ? plano.reajusteNovo : null,
    encerramentoNovo: plano.escreverEncerramento ? plano.encerramentoNovo : null,
    contrato: plano.contrato,
    semContrato: plano.semContrato,
    avisos: plano.avisos,
  };

  if (sombra) {
    await db.webhookEvent.update({
      where: { id: reservaId },
      data: { resultado: "sombra", detalhe: JSON.stringify(resumoDoPlano).slice(0, 2000), processedAt: new Date() },
    });
    return { resultado: "sombra", detalhe: "plano registrado, nada foi escrito" };
  }

  // ── Escrita ──────────────────────────────────────────────────────────────
  const erros: string[] = [];
  let fidelidadeNoConexa: "avancada" | "falhou" | "nao-tocada" = "nao-tocada";
  let escreveuAlgo = false;

  // O Conexa primeiro: é o sistema de registro, e o resto se conta a partir dele.
  if (plano.contrato && conexa) {
    try {
      await conexa.atualizarFidelidadeDoContrato(plano.contrato.id, plano.contrato.fidelidadeNova);
      // ⚠ Sem sandbox no ERP: lê de volta, e só afirma o que o Conexa devolve.
      const lido = contratoDaLeva(await conexa.obterContrato(plano.contrato.id));
      if (lido?.fidelidade === plano.contrato.fidelidadeNova) {
        fidelidadeNoConexa = "avancada";
        escreveuAlgo = true;
      } else {
        fidelidadeNoConexa = "falhou";
        erros.push(
          `o Conexa aceitou o PATCH do contrato ${plano.contrato.id}, mas devolveu a fidelidade ${lido?.fidelidade ?? "vazia"} em vez de ${plano.contrato.fidelidadeNova}`,
        );
      }
    } catch (erro) {
      fidelidadeNoConexa = "falhou";
      erros.push(`fidelidade do contrato ${plano.contrato.id}: ${(erro as Error).message}`);
    }
  }

  const escreverCampo = async (campo: string, nome: string, dia: string | null) => {
    const ms = paraTimestamp(dia);
    if (ms === undefined) {
      erros.push(`${nome}: a data ${dia} não é válida`);
      return false;
    }
    try {
      await cliente.definirCampoPersonalizado(tarefa.id, campo, ms);
      escreveuAlgo = true;
      return true;
    } catch (erro) {
      erros.push(`${nome}: ${(erro as Error).message}`);
      return false;
    }
  };

  const escreveuReajuste = plano.escreverReajuste
    ? await escreverCampo(CAMPO_DATA_DE_REAJUSTE, "DATA DE REAJUSTE", plano.reajusteNovo)
    : false;
  const escreveuEncerramento = plano.escreverEncerramento
    ? await escreverCampo(CAMPO_DATA_DE_ENCERRAMENTO, "DATA DE ENCERRAMENTO", plano.encerramentoNovo)
    : false;

  // Nada entrou e algo deveria ter entrado: a reserva se desfaz e a próxima
  // entrega tenta de novo.
  const queriaEscrever = plano.escreverReajuste || plano.escreverEncerramento || !!plano.contrato;
  if (!escreveuAlgo && queriaEscrever) {
    await db.webhookEvent.delete({ where: { id: reservaId } }).catch(() => {});
    return { resultado: "falhou", detalhe: erros.join(" · ") || "nada foi escrito" };
  }

  await db.webhookEvent
    .update({
      where: { id: reservaId },
      data: {
        resultado: erros.length ? "em parte" : "avançado",
        detalhe: JSON.stringify({ ...resumoDoPlano, fidelidadeNoConexa, erros }).slice(0, 2000),
        processedAt: new Date(),
      },
    })
    .catch((erro) => logger.error({ erro }, "não consegui fechar a reserva das datas"));

  if (escreveuAlgo || erros.length) {
    await cliente
      .comentarTarefa(
        tarefa.id,
        comentarioDasDatas({ plano, escreveuReajuste, escreveuEncerramento, fidelidadeNoConexa, erros }),
      )
      .catch((erro) => logger.error({ erro, tarefa: tarefa.id }, "datas: o comentário não saiu"));
  }

  return {
    resultado: erros.length ? "em parte" : "avançado",
    detalhe: erros.length ? erros.join(" · ") : "datas avançadas",
  };
}
