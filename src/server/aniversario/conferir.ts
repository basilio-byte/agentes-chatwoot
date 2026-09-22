import {
  IntegrationProvider,
  IntegrationStatus,
  PresenteStatus,
} from "@/generated/prisma/enums";
import type { PresenteDeAniversario } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { w3cEmSaoPaulo } from "@/lib/tempo";
import { entregarAviso } from "@/server/alerta-de-saldo/conversa";
import { resolverAtendente } from "@/server/integrations/chatwoot/atendentes";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import {
  clienteComTokenDeUsuario,
  clienteDoAgente,
} from "@/server/integrations/chatwoot/credenciais";
import { humanidadeDoDono, podeAgir } from "@/server/integrations/chatwoot/regras";
import { entregarAoHumano } from "@/server/integrations/chatwoot/resolucao";
import { conferirHorario, instanteEmSaoPaulo } from "@/server/integrations/conexa/agenda";
import { periodoDaAgenda } from "@/server/integrations/conexa/entrada";
import { formatarReserva } from "@/server/integrations/conexa/formatacao";
import { abrirConexa, type ConexaDoSistema } from "@/server/integrations/conexa/sistema";
import {
  CONFERIR_A_CADA_MS,
  horarioDoPedido,
  lerConfigAniversario,
  notaDeEntrega,
  notaDeReserva,
  PROCESSANDO_ABANDONADO_MS,
  textoDeConfirmacao,
  TOLERANCIA_DA_VENDA_MS,
  vendaDoPresente,
  type ConfigAniversario,
  type VendaDoPresente,
} from "./regras";

/**
 * A rodada do presente de aniversário, no relógio do vigia.
 *
 * - **Só trabalha com pedido esperando.** Sem nenhum, a rodada é uma consulta
 *   ao nosso banco — o Conexa nem é aberto (o usuário pediu para não gastar
 *   processamento à toa).
 * - **Venda paga → reserva**, pela `conexa_criar_reserva` dos agentes, que
 *   confere conflito de horário e lê de volta o que gravou. A reserva só é
 *   confirmada ao cliente se saiu DESCONTADA do pacote (`deductedFromQuota`):
 *   o contrário seria uma reserva que vira cobrança, confirmada como presente.
 * - **Prazo vencido, ou reserva que não deu certo → a conversa vai para a
 *   equipe** (o atendente da config), com aviso ao cliente, nota interna e
 *   WhatsApp para quem foi avisado do pedido.
 * - ⚠ **Cada pedido é travado antes de agir** (AGUARDANDO → PROCESSANDO com
 *   `updateMany` condicionado): duas rodadas nunca reservam o mesmo presente.
 *   Um PROCESSANDO que ficou para trás (o processo caiu no meio) vira FALHOU
 *   com o pedido para conferir no Conexa — refazer às cegas poderia reservar
 *   duas vezes.
 * - **Nunca fala por cima de uma pessoa.** Antes de mandar qualquer coisa ao
 *   cliente, a conversa é lida ao vivo (`podeAgir`); com gente dona dela, sai só
 *   a nota interna.
 */

let ultimaConferencia = 0;
let rodando = false;

export type RodadaDePresentes = {
  acao: "cedo" | "em andamento" | "nada" | "desligada" | "conferido";
  pedidos?: number;
  reservados?: number;
  entregues?: number;
  falhas?: number;
  erro?: string;
};

export async function conferirPresentes(
  agora = new Date(),
  opcoes: { forcar?: boolean } = {},
): Promise<RodadaDePresentes> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  ultimaConferencia = agora.getTime();

  const pedidos = await db.presenteDeAniversario.findMany({
    where: { status: { in: [PresenteStatus.AGUARDANDO, PresenteStatus.PROCESSANDO] } },
    orderBy: { criadoEm: "asc" },
  });
  if (!pedidos.length) return { acao: "nada" };

  rodando = true;
  try {
    return await rodar(agora, pedidos);
  } finally {
    rodando = false;
  }
}

type Contexto = {
  agora: Date;
  config: ConfigAniversario;
  conexa: ConexaDoSistema | null;
};

async function rodar(
  agora: Date,
  pedidos: PresenteDeAniversario[],
): Promise<RodadaDePresentes> {
  const linha = await db.integration.findUnique({
    where: { provider: IntegrationProvider.ANIVERSARIO },
    select: { enabled: true, config: true },
  });

  // Desligar é o botão de parada: o que estava esperando cai, sem agir.
  if (!linha?.enabled) {
    await db.presenteDeAniversario.updateMany({
      where: { status: PresenteStatus.AGUARDANDO },
      data: {
        status: PresenteStatus.CANCELADO,
        resultado: "a integração do presente de aniversário foi desligada",
        finalizadoEm: agora,
      },
    });
    return { acao: "desligada", pedidos: pedidos.length };
  }

  const config = lerConfigAniversario(linha.config);
  const aberto = await abrirConexa("aniversario");
  // Sem o Conexa não dá para ver a venda, mas o prazo continua valendo: a
  // conversa não pode ficar esperando um pacote que ninguém consegue conferir.
  const conexa = "erro" in aberto ? null : aberto;
  const ctx: Contexto = { agora, config, conexa };

  const rodada: RodadaDePresentes = { acao: "conferido", pedidos: pedidos.length, reservados: 0, entregues: 0, falhas: 0 };
  for (const pedido of pedidos) {
    try {
      const desfecho = await conferirPedido(ctx, pedido);
      if (desfecho === "reservado") rodada.reservados!++;
      if (desfecho === "entregue") rodada.entregues!++;
      if (desfecho === "falhou") rodada.falhas!++;
    } catch (erro) {
      rodada.falhas!++;
      logger.error({ pedido: pedido.id, erro }, "presente de aniversário: pedido não conferido");
    }
  }

  const erro = "erro" in aberto ? aberto.erro : null;
  await db.integration
    .update({
      where: { provider: IntegrationProvider.ANIVERSARIO },
      data: {
        lastCheckedAt: agora,
        status: erro ? IntegrationStatus.ERROR : IntegrationStatus.OK,
        lastError: erro,
      },
    })
    .catch(() => undefined);
  return erro ? { ...rodada, erro } : rodada;
}

type Desfecho = "esperando" | "reservado" | "entregue" | "falhou";

async function conferirPedido(ctx: Contexto, pedido: PresenteDeAniversario): Promise<Desfecho> {
  if (pedido.status === PresenteStatus.PROCESSANDO) {
    if (ctx.agora.getTime() - pedido.atualizadoEm.getTime() < PROCESSANDO_ABANDONADO_MS) {
      return "esperando";
    }
    await finalizar(pedido.id, PresenteStatus.FALHOU, [
      pedido.resultado,
      "a rodada caiu no meio: confira no Conexa se a reserva saiu antes de fazer qualquer coisa",
    ]);
    await avisarEquipe(
      ctx.config,
      `⚠️ Presente de aniversário (Conexa ${pedido.clienteId}): a conferência caiu no meio. Confira no Conexa se a reserva de ${horarioDoPedido(pedido)} saiu. Conversa: ${await link(pedido)}`,
    );
    return "falhou";
  }

  let venda: VendaDoPresente = { tipo: "nenhuma" };
  if (ctx.conexa) {
    try {
      const { itens } = await ctx.conexa.cliente.listarVendas({
        customerId: pedido.clienteId,
        createdAtFrom: w3cEmSaoPaulo(new Date(pedido.criadoEm.getTime() - TOLERANCIA_DA_VENDA_MS)),
        limit: 50,
      });
      venda = vendaDoPresente(itens, {
        produtos: ctx.config.produtos,
        desdeMs: pedido.criadoEm.getTime() - TOLERANCIA_DA_VENDA_MS,
      });
    } catch (erro) {
      logger.warn({ pedido: pedido.id, erro }, "presente de aniversário: vendas não lidas");
    }
  }

  if (venda.tipo === "paga" && ctx.conexa) {
    if (!(await travar(pedido.id, venda.vendaId))) return "esperando";
    return reservar(ctx, ctx.conexa, pedido, venda);
  }

  if (ctx.agora < pedido.venceEm) return "esperando";

  if (!(await travar(pedido.id))) return "esperando";
  return entregar(ctx, pedido, {
    motivo:
      venda.tipo === "esperando"
        ? `o prazo venceu com a venda do pacote (${venda.vendaId}) lançada, mas ainda não paga.`
        : "o prazo venceu e o pacote de 2 h não foi lançado no Conexa.",
  });
}

/** AGUARDANDO → PROCESSANDO, só se ninguém travou antes. */
async function travar(id: string, vendaId?: number): Promise<boolean> {
  const { count } = await db.presenteDeAniversario.updateMany({
    where: { id, status: PresenteStatus.AGUARDANDO },
    data: { status: PresenteStatus.PROCESSANDO, ...(vendaId ? { vendaId } : {}) },
  });
  return count === 1;
}

async function reservar(
  ctx: Contexto,
  conexa: ConexaDoSistema,
  pedido: PresenteDeAniversario,
  venda: Extract<VendaDoPresente, { tipo: "paga" }>,
): Promise<Desfecho> {
  // A equipe às vezes reserva à mão junto com o pacote (foi assim na 14149).
  // Reserva do próprio cliente no horário pedido é a reserva do presente: não
  // se reserva de novo, e o cliente já foi atendido por quem reservou.
  const existente = await reservaJaFeita(conexa, pedido);
  if (existente && existente.status === "deductedFromQuota") {
    await finalizar(pedido.id, PresenteStatus.RESERVADO, [
      pedido.resultado,
      `pacote pago (venda ${venda.vendaId}); a reserva ${existente.id} já existia no horário pedido, e o sistema não reservou de novo`,
    ], { reservaId: existente.id });
    await notaNaConversa(
      pedido,
      `✅ Presente de aniversário: o pacote está pago e a reserva ${existente.id} já existia no horário pedido (${horarioDoPedido(pedido)}) — o sistema não reservou de novo nem mandou confirmação ao cliente.`,
    );
    return "reservado";
  }
  // ⚠ Reserva do cliente no horário que NÃO saiu do pacote foi feita antes dele
  // (por exemplo, pelo próprio agente, contra a instrução): vai virar cobrança.
  // Não é presente, e reservar de novo daria conflito — quem decide é a equipe.
  if (existente) {
    return entregar(ctx, pedido, {
      motivo: `o pacote está pago (venda ${venda.vendaId}), mas já existe a reserva ${existente.id} do cliente no horário pedido, e ela NÃO saiu do pacote (situação "${existente.status || "sem situação"}"). Confira no Conexa antes de confirmar ao cliente.`,
      reservaId: existente.id,
    });
  }

  let resultado: Record<string, unknown>;
  try {
    resultado = (await conexa.executar("conexa_criar_reserva", {
      clienteId: pedido.clienteId,
      sala: String(pedido.salaId),
      data: pedido.data,
      inicio: pedido.inicio,
      fim: pedido.fim,
      ...(pedido.pessoaId ?? venda.pessoaId
        ? { solicitanteId: pedido.pessoaId ?? venda.pessoaId }
        : {}),
      observacoes: `Presente de aniversário — reservado pelo sistema depois do pacote pago (venda ${venda.vendaId}).`,
    })) as Record<string, unknown>;
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    return entregar(ctx, pedido, {
      motivo: `o pacote está pago (venda ${venda.vendaId}), mas o Conexa recusou a reserva: ${motivo.slice(0, 200)}`,
    });
  }

  if (resultado.criada !== true) {
    const indeterminado = resultado.resultado === "indeterminado";
    return entregar(ctx, pedido, {
      motivo: indeterminado
        ? `o pacote está pago (venda ${venda.vendaId}), mas o Conexa não confirmou a reserva — ela PODE ter entrado. Confira a agenda antes de reservar.`
        : `o pacote está pago (venda ${venda.vendaId}), mas a reserva não saiu: ${String(resultado.erro ?? "motivo não informado").slice(0, 200)}`,
    });
  }

  const reserva = (resultado.reserva ?? {}) as { id?: number; sala?: string; status?: string };
  const reservaId = typeof reserva.id === "number" ? reserva.id : Number(resultado.reservaId) || null;

  // ⚠ Só é presente se saiu do pacote. Com outro status, a reserva existe mas
  // vai virar cobrança — confirmar ao cliente seria prometer de graça o que
  // vai ser cobrado.
  if (reserva.status !== "deductedFromQuota") {
    return entregar(ctx, pedido, {
      motivo: reserva.status
        ? `a reserva ${reservaId ?? "?"} foi criada, mas NÃO saiu do pacote de horas (situação "${reserva.status}"). Confira no Conexa antes de confirmar ao cliente.`
        : `a reserva ${reservaId ?? "?"} foi criada, mas não consegui ler de volta se saiu do pacote. Confira no Conexa antes de confirmar ao cliente.`,
      reservaId,
    });
  }

  const salaNome = reserva.sala?.trim() || pedido.salaNome;
  const clienteAvisado = await falarComOCliente(
    pedido,
    textoDeConfirmacao(ctx.config.confirmacao, { ...pedido, salaNome }),
  );
  await notaNaConversa(
    pedido,
    notaDeReserva({ pedido: { ...pedido, salaNome }, reservaId, vendaId: venda.vendaId, clienteAvisado }),
  );
  await finalizar(pedido.id, PresenteStatus.RESERVADO, [
    pedido.resultado,
    `reserva ${reservaId} criada do pacote (venda ${venda.vendaId})`,
    clienteAvisado ? "cliente avisado" : "cliente NÃO avisado: a conversa não estava com o robô",
  ], { reservaId });
  await avisarEquipe(
    ctx.config,
    `✅ Presente de aniversário reservado (Conexa ${pedido.clienteId}): ${horarioDoPedido({ ...pedido, salaNome })}.${
      clienteAvisado ? " O cliente recebeu a confirmação." : " ⚠️ O cliente NÃO recebeu a confirmação — avise-o na conversa."
    } ${await link(pedido)}`,
  );
  return "reservado";
}

/** A reserva do próprio cliente no horário pedido, se a equipe já fez. */
async function reservaJaFeita(
  conexa: ConexaDoSistema,
  pedido: PresenteDeAniversario,
): Promise<{ id: number; status: string } | null> {
  const inicioMs = instanteEmSaoPaulo(pedido.data, pedido.inicio);
  const fimMs = instanteEmSaoPaulo(pedido.data, pedido.fim);
  const dia = periodoDaAgenda(pedido.data, pedido.data);
  if (inicioMs === null || fimMs === null || "erro" in dia) return null;
  try {
    const { itens } = await conexa.cliente.listarReservas({
      customerId: pedido.clienteId,
      roomId: pedido.salaId,
      bookingDateTimeFrom: dia.de,
      bookingDateTimeTo: dia.ate,
      limit: 50,
    });
    const conferencia = conferirHorario(itens.map((r) => formatarReserva(r)), { inicioMs, fimMs });
    if (conferencia.livre) return null;
    const achada = conferencia.conflitam.find((r) => typeof r.id === "number");
    return achada ? { id: achada.id!, status: achada.status ?? "" } : null;
  } catch {
    // Sem a leitura, segue para reservar: a conferência de conflito da própria
    // ferramenta recusa se o horário estiver ocupado.
    return null;
  }
}

/**
 * Passa a conversa para a equipe: aviso ao cliente (se a conversa ainda é do
 * robô), atribuição ao atendente da config, nota interna e WhatsApp.
 */
async function entregar(
  ctx: Contexto,
  pedido: PresenteDeAniversario,
  args: { motivo: string; reservaId?: number | null },
): Promise<Desfecho> {
  const rastro: Array<string | null> = [pedido.resultado, args.motivo];
  const robo = await clienteDoAgente(pedido.portaAgentId);
  let atribuidoA: string | null = null;

  if (robo) {
    const conversa = pedido.chatwootConversationId;
    try {
      const aoVivo = await robo.obterConversa(conversa);
      const veredito = podeAgir({
        status: aoVivo.status,
        assigneeId: aoVivo.assigneeId,
        donoEhHumano: humanidadeDoDono(aoVivo.assigneeTipo),
      });
      if (veredito.pode) {
        // O aviso sai ANTES de atribuir: com dono, a regra global cala o robô.
        await robo.enviarMensagem(conversa, ctx.config.entrega);
        await robo.alternarStatus(conversa, "open");
        const destino = resolverAtendente(ctx.config.atendente, await robo.listarAtendentes());
        if (destino.tipo === "achado") {
          await robo.atribuir(conversa, { assigneeId: destino.atendente.id });
          atribuidoA = destino.atendente.name?.trim() || ctx.config.atendente;
        } else {
          rastro.push(`"${ctx.config.atendente}" não foi achado no Chatwoot`);
        }
        await entregarAoHumano(conversa, `presente de aniversário: ${args.motivo}`);
      } else {
        rastro.push(`nada foi dito ao cliente (${veredito.motivo})`);
      }
    } catch (erro) {
      rastro.push(`não consegui passar a conversa (${mensagem(erro)})`);
    }
    await notaNaConversa(pedido, notaDeEntrega({ pedido, motivo: args.motivo, atribuidoA }), robo);
  } else {
    rastro.push("sem o robô da conversa, nada foi feito no Chatwoot");
  }

  const avisou = await avisarEquipe(
    ctx.config,
    `⏱️ Presente de aniversário (Conexa ${pedido.clienteId}), ${horarioDoPedido(pedido)}: ${args.motivo}${
      atribuidoA ? ` A conversa foi atribuída a ${atribuidoA}.` : ""
    } ${await link(pedido)}`,
  );
  if (!avisou) rastro.push("o WhatsApp à equipe não saiu");

  const passou = atribuidoA != null || robo != null;
  await finalizar(pedido.id, passou ? PresenteStatus.ENTREGUE : PresenteStatus.FALHOU, rastro, {
    reservaId: args.reservaId ?? null,
  });
  return passou ? "entregue" : "falhou";
}

/** Manda ao cliente, se a conversa ainda é do robô. Devolve se mandou. */
async function falarComOCliente(pedido: PresenteDeAniversario, texto: string): Promise<boolean> {
  const robo = await clienteDoAgente(pedido.portaAgentId);
  if (!robo) return false;
  try {
    const aoVivo = await robo.obterConversa(pedido.chatwootConversationId);
    const veredito = podeAgir({
      status: aoVivo.status,
      assigneeId: aoVivo.assigneeId,
      donoEhHumano: humanidadeDoDono(aoVivo.assigneeTipo),
    });
    if (!veredito.pode) return false;
    await robo.enviarMensagem(pedido.chatwootConversationId, texto);
    return true;
  } catch (erro) {
    logger.warn({ pedido: pedido.id, erro }, "presente de aniversário: confirmação não saiu");
    return false;
  }
}

/** Nota que falha não desfaz o que já foi feito. */
async function notaNaConversa(
  pedido: PresenteDeAniversario,
  texto: string,
  robo?: ChatwootClient | null,
) {
  const cliente = robo ?? (await clienteDoAgente(pedido.portaAgentId));
  if (!cliente) return;
  try {
    await cliente.enviarMensagem(pedido.chatwootConversationId, texto, { privado: true });
  } catch (erro) {
    logger.warn({ pedido: pedido.id, erro }, "presente de aniversário: nota interna não foi gravada");
  }
}

/** WhatsApp para quem recebe os avisos do presente. Devolve se ao menos um saiu. */
async function avisarEquipe(config: ConfigAniversario, texto: string): Promise<boolean> {
  if (!config.avisar.length) return false;
  const usuario = await clienteComTokenDeUsuario();
  if (!usuario) return false;
  const entregas = await entregarAviso(usuario, config.caixaDoAviso, config.avisar, texto);
  return entregas.some((e) => e.ok);
}

async function finalizar(
  id: string,
  status: PresenteStatus,
  rastro: Array<string | null | undefined>,
  extra: { reservaId?: number | null } = {},
) {
  await db.presenteDeAniversario.update({
    where: { id },
    data: {
      status,
      resultado: rastro.filter(Boolean).join(" · ").slice(0, 2000),
      finalizadoEm: new Date(),
      ...(extra.reservaId ? { reservaId: extra.reservaId } : {}),
    },
  });
}

async function link(pedido: PresenteDeAniversario): Promise<string> {
  const robo = await clienteDoAgente(pedido.portaAgentId);
  return robo
    ? `${robo.baseUrl}/app/accounts/${robo.contaId}/conversations/${pedido.chatwootConversationId}`
    : `conversa ${pedido.chatwootConversationId}`;
}

function mensagem(erro: unknown) {
  return (erro instanceof Error ? erro.message : String(erro)).slice(0, 200);
}

/** Só para teste: zera o relógio da rodada. */
export function esquecerRodada() {
  ultimaConferencia = 0;
  rodando = false;
}
