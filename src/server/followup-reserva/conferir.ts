import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { reservasDosAgentes, situacaoDoPagamento, type Chamada } from "@/server/auto-venda/regras";
import { ChatwootApiError, type ChatwootClient } from "@/server/integrations/chatwoot/client";
import { clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import { portaDaCaixa } from "@/server/integrations/chatwoot/porta";
import { ConexaApiError } from "@/server/integrations/conexa/client";
import {
  ehCobrancaPendente,
  formatarCobranca,
  formatarReserva,
} from "@/server/integrations/conexa/formatacao";
import { abrirConexa, type ConexaDoSistema } from "@/server/integrations/conexa/sistema";
import { lerConfigFollowup, type FollowupConfig } from "./config";
import {
  chaveDaReserva,
  CONFERIR_A_CADA_MS,
  decidirEnvio,
  diaDaReserva,
  DIAS_PARA_TRAS,
  ehRecusaClara,
  horaCurta,
  momentoDoFollowup,
  nomeDaSala,
  notaDeDesistencia,
  notaDeEnvio,
  notaParaQuemAtende,
  primeiroNome,
  PROVIDER_FOLLOWUP,
  RESERVA_ABANDONADA_MS,
  RESERVAS_POR_RODADA,
  resumoDaReserva,
  textoDoFollowup,
  ultimaMensagemDoCliente,
  valorEmReais,
} from "./regras";

/**
 * A rodada do follow-up de reserva, no relógio do vigia (regras e o porquê de
 * cada uma em `regras.ts`).
 *
 * - **Sem reserva na hora, não abre nada**: quem está longe do horário é decidido
 *   com o que o banco já sabe (as `ToolCall` do agente). Só a reserva cuja hora
 *   chegou custa leitura no Conexa e no Chatwoot.
 * - ⚠ **Cada reserva tem UM desfecho**, numa linha de `WebhookEvent` (provider
 *   `FOLLOWUP_RESERVA`, `reserva:<id>`); a unique dessa linha é a trava contra
 *   duas rodadas mandando a mesma mensagem. "Aguardar" não grava nada: a reserva
 *   volta na rodada seguinte.
 * - ⚠ **Reserva antes de enviar; INCERTO segura.** A linha nasce "reservado". O
 *   Chatwoot recusando com 4xx é "nada saiu" (`falhou`); rede, prazo ou 5xx DEPOIS
 *   de pedir o envio PODE ter saído: fica `incerto`, e nada é reenviado.
 * - **Modo sombra**: lê e decide de verdade, e registra o que faria numa chave
 *   própria (`sombra:reserva:<id>`), sem mandar mensagem nem nota. Passar para
 *   `ligado` não herda os ensaios: a reserva ainda futura é tratada de novo.
 */

let ultimaConferencia = 0;
let rodando = false;

export type Candidato = {
  reservaId: number;
  cobrancaId: number | null;
  agentId: string | null;
  chatwootConversationId: number;
  inboxId: number | null;
  criadaEm: Date;
  inicio: Date;
  /** Previsão feita só com o banco: a janela conta da criação da reserva. */
  previsto: Date | null;
};

export type RodadaDeFollowup = {
  acao: "cedo" | "em andamento" | "desligada" | "iniciada" | "conferido";
  modo?: FollowupConfig["modo"];
  /** Reservas futuras dos agentes ainda sem desfecho. */
  candidatos?: number;
  /** Mensagens ao cliente (ligado) ou o que sairia (sombra), por reserva. */
  enviados?: number[];
  ensaios?: number[];
  notas?: number[];
  semFollowup?: string[];
  aguardando?: string[];
  incertos?: number[];
  falhas?: string[];
  erro?: string;
};

/** Chamada pelo vigia a cada minuto; confere de fato a cada `CONFERIR_A_CADA_MS`. */
export async function conferirFollowupsDeReserva(
  agora = new Date(),
  opcoes: { esperar?: boolean; forcar?: boolean } = {},
): Promise<RodadaDeFollowup> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }

  const integracao = await db.integration.findUnique({
    where: { provider: IntegrationProvider.FOLLOWUP_RESERVA },
    select: { enabled: true, config: true },
  });
  if (!integracao?.enabled) return { acao: "desligada" };
  const config = lerConfigFollowup(integracao.config);

  ultimaConferencia = agora.getTime();
  rodando = true;
  const rodada = rodar(agora, config)
    .catch((erro: unknown): RodadaDeFollowup => {
      logger.error({ erro }, "follow-up de reserva: a rodada falhou");
      return { acao: "conferido", modo: config.modo, erro: mensagem(erro) };
    })
    .finally(() => {
      rodando = false;
    });

  if (opcoes.esperar) return rodada;
  void rodada.then((r) => {
    if (r.enviados?.length || r.ensaios?.length || r.notas?.length || r.falhas?.length || r.incertos?.length || r.erro) {
      logger.info(r, "follow-up de reserva conferido");
    }
  });
  return { acao: "iniciada" };
}

/** Só para teste: esquece o relógio entre um caso e outro. */
export function reiniciarRelogioDoFollowup() {
  ultimaConferencia = 0;
  rodando = false;
}

/**
 * As reservas futuras que um agente criou nos últimos `DIAS_PARA_TRAS` dias e que
 * ainda não têm desfecho neste modo, com a hora prevista do follow-up. Só banco:
 * é também o que a tela e o MCP mostram como "próximos".
 */
export async function candidatosAoFollowup(
  agora: Date,
  config: FollowupConfig,
): Promise<Candidato[]> {
  const linhas = await db.toolCall.findMany({
    where: {
      toolName: { in: ["conexa_criar_reserva", "conexa_faturar_reserva"] },
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
      run: {
        select: {
          agentId: true,
          conversationId: true,
          conversation: { select: { chatwootConversationId: true, chatwootInboxId: true } },
        },
      },
    },
  });

  const conversas = new Map<string, { chatwoot: number; inbox: number | null; agentId: string }>();
  const chamadas: Chamada[] = [];
  for (const l of linhas) {
    const id = l.run.conversationId;
    if (!id || !l.run.conversation) continue;
    if (l.toolName === "conexa_criar_reserva") {
      conversas.set(id, {
        chatwoot: l.run.conversation.chatwootConversationId,
        inbox: l.run.conversation.chatwootInboxId ?? null,
        agentId: l.run.agentId,
      });
    }
    chamadas.push({
      toolName: l.toolName,
      input: l.input,
      output: l.output,
      createdAt: l.createdAt,
      conversaId: id,
    });
  }

  const futuras = reservasDosAgentes(chamadas)
    .map((r) => ({ r, inicio: r.inicio ? new Date(r.inicio) : null, conversa: conversas.get(r.conversaId) }))
    .filter(
      (x): x is typeof x & { inicio: Date; conversa: NonNullable<typeof x.conversa> } =>
        !!x.conversa && !!x.inicio && !Number.isNaN(x.inicio.getTime()) && x.inicio > agora,
    );
  if (!futuras.length) return [];

  const tratadas = new Set(
    (
      await db.webhookEvent.findMany({
        where: {
          provider: PROVIDER_FOLLOWUP,
          externalId: { in: futuras.map((x) => chaveDaReserva(x.r.reservaId, config.modo)) },
          // "reservado" de rodada que caiu é tratado na rodada, não escondido aqui.
          resultado: { not: "reservado" },
        },
        select: { externalId: true },
      })
    ).map((e) => e.externalId),
  );

  return futuras
    .filter((x) => !tratadas.has(chaveDaReserva(x.r.reservaId, config.modo)))
    .map((x) => ({
      reservaId: x.r.reservaId,
      cobrancaId: x.r.cobrancaId,
      agentId: x.conversa.agentId,
      chatwootConversationId: x.conversa.chatwoot,
      inboxId: x.conversa.inbox,
      criadaEm: x.r.criadaEm,
      inicio: x.inicio,
      previsto: momentoDoFollowup({
        inicio: x.inicio,
        criadaEm: x.r.criadaEm,
        ultimaDoCliente: x.r.criadaEm,
        config,
      }),
    }))
    .sort((a, b) => (a.previsto?.getTime() ?? 0) - (b.previsto?.getTime() ?? 0));
}

type Desfecho =
  | { tipo: "enviado" | "ensaio" | "nota" | "incerto" }
  | { tipo: "sem follow-up" | "aguardando" | "falhou"; motivo: string };

async function rodar(agora: Date, config: FollowupConfig): Promise<RodadaDeFollowup> {
  const candidatos = await candidatosAoFollowup(agora, config);
  const rodada: RodadaDeFollowup = {
    acao: "conferido",
    modo: config.modo,
    candidatos: candidatos.length,
    enviados: [],
    ensaios: [],
    notas: [],
    semFollowup: [],
    aguardando: [],
    incertos: [],
    falhas: [],
  };

  let conexa: ConexaDoSistema | null = null;
  let conferidas = 0;
  for (const c of candidatos) {
    // Sem instante possível (começa cedo demais depois de reservar): decide-se
    // com o que o banco sabe, sem gastar leitura.
    if (!c.previsto) {
      const motivo = "não há horário de envio possível antes da reserva";
      await registrar(c, config, "sem follow-up", motivo);
      rodada.semFollowup!.push(`${c.reservaId}: ${motivo}`);
      continue;
    }
    if (c.previsto > agora) continue;
    if (conferidas >= RESERVAS_POR_RODADA) break;
    conferidas += 1;

    if (!conexa) {
      const aberto = await abrirConexa("follow-up de reserva");
      if ("erro" in aberto) return { ...rodada, erro: aberto.erro };
      conexa = aberto;
    }

    let desfecho: Desfecho;
    try {
      desfecho = await tratar(c, { agora, config, conexa });
    } catch (erro) {
      // Erro de leitura (Conexa ou Chatwoot fora do ar): nada saiu, e a reserva
      // volta na rodada seguinte.
      desfecho = { tipo: "aguardando", motivo: `leitura falhou: ${mensagem(erro)}` };
    }

    switch (desfecho.tipo) {
      case "enviado":
        rodada.enviados!.push(c.reservaId);
        break;
      case "ensaio":
        rodada.ensaios!.push(c.reservaId);
        break;
      case "nota":
        rodada.notas!.push(c.reservaId);
        break;
      case "incerto":
        rodada.incertos!.push(c.reservaId);
        break;
      case "sem follow-up":
        rodada.semFollowup!.push(`${c.reservaId}: ${desfecho.motivo}`);
        break;
      case "aguardando":
        rodada.aguardando!.push(`${c.reservaId}: ${desfecho.motivo}`);
        break;
      case "falhou":
        rodada.falhas!.push(`${c.reservaId}: ${desfecho.motivo}`);
        break;
    }
  }
  return rodada;
}

async function tratar(
  c: Candidato,
  ctx: { agora: Date; config: FollowupConfig; conexa: ConexaDoSistema },
): Promise<Desfecho> {
  const { agora, config, conexa } = ctx;
  const sombra = config.modo === "sombra";
  const chave = chaveDaReserva(c.reservaId, config.modo);

  // Reserva de uma rodada que caiu no meio: pode ter saído. Nunca reenvia.
  const existente = await db.webhookEvent.findUnique({
    where: { provider_externalId: { provider: PROVIDER_FOLLOWUP, externalId: chave } },
    select: { id: true, resultado: true, createdAt: true },
  });
  if (existente) {
    if (
      existente.resultado === "reservado" &&
      agora.getTime() - existente.createdAt.getTime() > RESERVA_ABANDONADA_MS
    ) {
      await db.webhookEvent.update({
        where: { id: existente.id },
        data: {
          resultado: "incerto",
          detalhe: "a rodada caiu no meio do envio; a mensagem pode ter saído",
          processedAt: new Date(),
        },
      });
      return { tipo: "incerto" };
    }
    return { tipo: "aguardando", motivo: "outra rodada está tratando esta reserva" };
  }

  // 1. A reserva AGORA, no Conexa: paga, do pacote ou cancelada não recebe nada.
  let bruta: Record<string, unknown>;
  try {
    bruta = await conexa.cliente.obterReserva(c.reservaId);
  } catch (erro) {
    if (erro instanceof ConexaApiError && erro.status === 404) {
      return semFollowup(c, config, "a reserva não existe mais no Conexa");
    }
    throw erro;
  }
  const situacao = situacaoDoPagamento(bruta);
  if (situacao === "paga") return semFollowup(c, config, "a reserva está paga");
  if (situacao === "pacote") return semFollowup(c, config, "descontada do pacote de horas");
  if (situacao === "cancelada") return semFollowup(c, config, "a reserva foi cancelada");

  const reserva = formatarReserva(bruta);
  // A equipe pode ter mudado o horário: vale o que o Conexa diz agora.
  const inicio = reserva.inicio ? new Date(reserva.inicio) : c.inicio;
  const fim = reserva.fim ? new Date(reserva.fim) : null;
  if (Number.isNaN(inicio.getTime())) return semFollowup(c, config, "a reserva está sem horário legível");

  // 2. A cobrança que o agente gerou.
  if (c.cobrancaId == null) {
    return semFollowup(c, config, "o agente não gerou cobrança para esta reserva");
  }
  const cobranca = formatarCobranca(await conexa.cliente.obterCobranca(c.cobrancaId));
  if (String(cobranca.status ?? "").toLowerCase() === "paid") {
    return semFollowup(c, config, "a cobrança está paga");
  }
  if (!ehCobrancaPendente(cobranca.status)) {
    return semFollowup(c, config, `a cobrança não está em aberto (${cobranca.status ?? "sem situação"})`);
  }
  const link = cobranca.faturaUrl ?? cobranca.boletoUrl;
  if (!link) return semFollowup(c, config, "a cobrança não tem link de pagamento");
  const valor = cobranca.valorAtual != null ? valorEmReais(cobranca.valorAtual) : "a reserva";

  // 3. A conversa AO VIVO, pelo robô da caixa.
  const porta = await portaDaCaixa(c.chatwootConversationId, c.inboxId);
  const chatwoot = porta ? await clienteDoAgente(porta) : null;
  if (!chatwoot) return semFollowup(c, config, "sem o robô do Chatwoot desta caixa");

  const [aoVivo, mensagens] = await Promise.all([
    chatwoot.obterConversa(c.chatwootConversationId),
    chatwoot.listarMensagens(c.chatwootConversationId),
  ]);
  const ultimaDoCliente = ultimaMensagemDoCliente(mensagens) ?? c.criadaEm;

  // Com a última mensagem de verdade (o cliente pode ter escrito depois de
  // reservar) e o horário de agora, a hora pode ter ficado para depois.
  const momento = momentoDoFollowup({ inicio, criadaEm: c.criadaEm, ultimaDoCliente, config });
  if (momento && momento > agora) return { tipo: "aguardando", motivo: "ainda não é a hora" };

  const dados = {
    sala: nomeDaSala(reserva.sala),
    data: diaDaReserva(inicio, agora),
    inicio: horaCurta(inicio),
    fim: fim && !Number.isNaN(fim.getTime()) ? horaCurta(fim) : "o fim marcado",
  };
  const resumo = resumoDaReserva({ reservaId: c.reservaId, ...dados });
  const daCobranca = `cobrança ${c.cobrancaId}, ${valor}`;

  const decisao = momento
    ? decidirEnvio({ agora, inicio, ultimaDoCliente, conversa: aoVivo, mensagens, config })
    : ({ acao: "desistir", motivo: "não há mais horário de envio possível antes da reserva" } as const);

  switch (decisao.acao) {
    case "aguardar":
      return { tipo: "aguardando", motivo: decisao.motivo };

    case "desistir":
      if (!sombra) {
        await notaInterna(chatwoot, c.chatwootConversationId, notaDeDesistencia(resumo, daCobranca, decisao.motivo));
      }
      return semFollowup(c, config, decisao.motivo);

    case "avisar-quem-atende": {
      const quem = decisao.quem ?? "a pessoa que atende";
      if (sombra) {
        await registrar(c, config, "ensaio", `deixaria uma nota para ${quem}, sem falar com o cliente`);
        return { tipo: "ensaio" };
      }
      await notaInterna(chatwoot, c.chatwootConversationId, notaParaQuemAtende(resumo, daCobranca));
      await registrar(c, config, "nota", `a conversa está com ${quem}: nota interna para ela, nada ao cliente`);
      return { tipo: "nota" };
    }

    case "enviar":
      break;
  }

  let nome: string | null = null;
  if (aoVivo.contactId != null) {
    try {
      nome = primeiroNome((await chatwoot.obterContato(aoVivo.contactId)).nome);
    } catch {
      // Sem o nome, o "Oi, {nome}!" vira "Oi!".
    }
  }
  const texto = textoDoFollowup(config.texto, { nome, ...dados, valor, link });

  if (sombra) {
    await registrar(c, config, "ensaio", `mandaria ao cliente a confirmação com o link (${daCobranca})`);
    return { tipo: "ensaio" };
  }

  // 4. Reserva, envio e desfecho.
  let reservaDaLinha: string;
  try {
    reservaDaLinha = (
      await db.webhookEvent.create({
        data: {
          provider: PROVIDER_FOLLOWUP,
          externalId: chave,
          eventType: "followup",
          payload: payloadDe(c),
          resultado: "reservado",
        },
        select: { id: true },
      })
    ).id;
  } catch {
    return { tipo: "aguardando", motivo: "outra rodada reservou esta reserva no mesmo instante" };
  }

  try {
    await chatwoot.enviarMensagem(c.chatwootConversationId, texto);
  } catch (erro) {
    const clara = erro instanceof ChatwootApiError && ehRecusaClara(erro.status);
    const motivo = mensagem(erro).slice(0, 300);
    await db.webhookEvent.update({
      where: { id: reservaDaLinha },
      data: {
        resultado: clara ? "falhou" : "incerto",
        detalhe: clara
          ? `o Chatwoot recusou a mensagem: ${motivo}`
          : `o envio falhou sem resposta clara (pode ter saído): ${motivo}`,
        processedAt: new Date(),
      },
    });
    return clara ? { tipo: "falhou", motivo } : { tipo: "incerto" };
  }

  await db.webhookEvent.update({
    where: { id: reservaDaLinha },
    data: {
      resultado: "enviado",
      detalhe: `mensagem aceita pelo Chatwoot (${daCobranca})`,
      processedAt: new Date(),
    },
  });
  await notaInterna(chatwoot, c.chatwootConversationId, notaDeEnvio(resumo, c.cobrancaId));
  return { tipo: "enviado" };
}

async function semFollowup(c: Candidato, config: FollowupConfig, motivo: string): Promise<Desfecho> {
  await registrar(c, config, "sem follow-up", motivo);
  return { tipo: "sem follow-up", motivo };
}

/** O desfecho da reserva. Já registrado (outra rodada), fica o primeiro. */
async function registrar(c: Candidato, config: FollowupConfig, resultado: string, detalhe: string) {
  try {
    await db.webhookEvent.create({
      data: {
        provider: PROVIDER_FOLLOWUP,
        externalId: chaveDaReserva(c.reservaId, config.modo),
        eventType: config.modo === "sombra" ? "followup-sombra" : "followup",
        payload: payloadDe(c),
        resultado,
        detalhe: (config.modo === "sombra" ? `sombra: ${detalhe}` : detalhe).slice(0, 500),
        processedAt: new Date(),
      },
    });
  } catch {
    // unique: outra rodada registrou antes.
  }
}

/** O que a linha guarda: ids e horários, nunca nome nem telefone do cliente. */
function payloadDe(c: Candidato) {
  return {
    reservaId: c.reservaId,
    cobrancaId: c.cobrancaId,
    agentId: c.agentId,
    conversa: c.chatwootConversationId,
    inicio: c.inicio.toISOString(),
  };
}

/** Nota que falha não desfaz o que já foi feito: registra no log e segue. */
async function notaInterna(cliente: ChatwootClient, conversa: number, texto: string) {
  try {
    await cliente.enviarMensagem(conversa, texto, { privado: true });
  } catch (erro) {
    logger.warn({ conversa, erro: mensagem(erro) }, "follow-up de reserva: nota interna não gravada");
  }
}

function mensagem(erro: unknown) {
  return erro instanceof Error ? erro.message : String(erro);
}
