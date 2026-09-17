import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  ConversationStatus,
  IntegrationProvider,
  PesquisaNpsStatus,
} from "@/generated/prisma/enums";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import {
  clienteDeLeitura,
  clienteDoAgente,
} from "@/server/integrations/chatwoot/credenciais";
import { portaDaCaixa } from "@/server/integrations/chatwoot/porta";
import { ehResolvida } from "@/server/integrations/chatwoot/regras";
import { marcarResolvida } from "@/server/integrations/chatwoot/resolucao";
import { telefoneCanonico } from "@/server/integrations/clickup/telefone";
import { agendarPesquisaNps } from "@/server/queue/nps";
import { lerConfigNps, type NpsConfig } from "./config";
import { gravarNotaNoCrm, type RegistroDaNota } from "./crm";
import { juntarRastro, motivoParaNaoAgir, respostaDaNota } from "./regras";

/**
 * As etapas da pesquisa de satisfação — o NPS SEAHUB do n8n, refeito como
 * função do sistema e sem modelo (15/09/2026).
 *
 *   AGENDADA ─enviar─▶ AGUARDANDO ─lembrar─▶ LEMBRADA ─expirar─▶ EXPIRADA
 *                          │                     │
 *                          └── nota (rota do bot) ┴─▶ RESPONDIDA ─agradecer─▶ AGRADECIDA ─encerrar─▶ CONCLUIDA
 *
 * O estado mora no banco. Quem executa é o vigia, de minuto em minuto; a fila
 * só adianta o relógio. Cada etapa se trava trocando o status com `updateMany`
 * ANTES de falar com o cliente: duas voltas, ou duas réplicas, nunca mandam a
 * mesma mensagem duas vezes, e uma queda no meio deixa a etapa pela metade em
 * vez de repetida. Antes de lembrar e de resolver, a conversa é lida AO VIVO,
 * com a garantia dos prazos: a pesquisa nunca age por cima de uma pessoa.
 */

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const POR_RODADA = 50;

/** Falhas seguidas numa etapa (Chatwoot fora do ar, conversa apagada) até desistir. */
export const TENTATIVAS_MAXIMAS = 5;

const {
  AGENDADA,
  AGUARDANDO,
  LEMBRADA,
  RESPONDIDA,
  AGRADECIDA,
  CONCLUIDA,
  EXPIRADA,
  CANCELADA,
  FALHOU,
} = PesquisaNpsStatus;

/** Etapas em que ainda há o que fazer quando o relógio vence. */
const COM_RELOGIO: PesquisaNpsStatus[] = [AGENDADA, AGUARDANDO, LEMBRADA, RESPONDIDA, AGRADECIDA];

type Pesquisa = NonNullable<Awaited<ReturnType<typeof db.pesquisaNps.findUnique>>>;

export type RodadaNps = { vistas: number; falhas: number };

export async function executarPesquisasVencidas(agora = Date.now()): Promise<RodadaNps> {
  const vencidas = await db.pesquisaNps.findMany({
    where: { status: { in: COM_RELOGIO }, venceEm: { lte: new Date(agora) } },
    orderBy: { venceEm: "asc" },
    take: POR_RODADA,
    select: { id: true },
  });

  let falhas = 0;
  for (const { id } of vencidas) {
    if (!(await avancarPesquisa(id, agora))) falhas++;
  }
  return { vistas: vencidas.length, falhas };
}

/**
 * Leva a pesquisa à etapa seguinte, se já for a hora. `false` quando a etapa
 * falhou: a pesquisa fica onde estava, e o vigia tenta de novo no minuto
 * seguinte, até `TENTATIVAS_MAXIMAS`.
 */
export async function avancarPesquisa(id: string, agora = Date.now()): Promise<boolean> {
  const pesquisa = await db.pesquisaNps.findUnique({ where: { id } });
  if (!pesquisa || !COM_RELOGIO.includes(pesquisa.status)) return true;
  if (pesquisa.venceEm.getTime() > agora) return true;

  try {
    const integracao = await db.integration.findUnique({
      where: { provider: IntegrationProvider.NPS },
      select: { enabled: true, config: true },
    });
    // Desligar é o botão de parada: o que estava em andamento não age mais.
    if (!integracao?.enabled) {
      await finalizar(pesquisa, CANCELADA, "a pesquisa de satisfação foi desligada");
      return true;
    }
    const config = lerConfigNps(integracao.config);

    switch (pesquisa.status) {
      case AGENDADA:
        await enviar(pesquisa, config, agora);
        break;
      case AGUARDANDO:
        await lembrar(pesquisa, config, agora);
        break;
      case LEMBRADA:
        await expirar(pesquisa, agora);
        break;
      case RESPONDIDA:
        await agradecer(pesquisa, config, agora);
        break;
      case AGRADECIDA:
        await encerrar(pesquisa, config, agora);
        break;
    }
    return true;
  } catch (erro) {
    const motivo = mensagemDe(erro);
    logger.error(
      { pesquisa: id, conversa: pesquisa.chatwootConversationId, status: pesquisa.status, erro: motivo },
      "NPS: a etapa falhou",
    );

    const tentativas = pesquisa.tentativas + 1;
    await db.pesquisaNps.updateMany({
      where: { id, status: pesquisa.status },
      data:
        tentativas >= TENTATIVAS_MAXIMAS
          ? {
              tentativas,
              status: FALHOU,
              finalizadaEm: new Date(agora),
              resultado: juntarRastro([
                pesquisa.resultado,
                `desisti depois de ${tentativas} tentativas: ${motivo}`,
              ]),
            }
          : { tentativas },
    });
    return false;
  }
}

/** Desmarca o checkbox, confere a conversa e manda as três mensagens da pesquisa. */
async function enviar(p: Pesquisa, config: NpsConfig, agora: number) {
  const conversa = p.chatwootConversationId;
  const avisos: string[] = [];

  // Desmarca na hora, com o token de usuário e mesclando os atributos: o caminho
  // que o gatilho de checkbox já provou em produção.
  const leitura = await clienteDeLeitura();
  if (!leitura) {
    await finalizar(
      p,
      FALHOU,
      "sem token de leitura do Chatwoot — configure em Integrações → Chatwoot",
    );
    return;
  }
  try {
    await leitura.cliente.definirAtributosDaConversa(conversa, { [config.checkbox]: null });
  } catch (erro) {
    avisos.push(`checkbox não desmarcado: ${mensagemDe(erro)}`);
  }

  // As mensagens saem pelo robô da caixa, como as do atendimento.
  const portaId = p.portaAgentId ?? (await portaDaCaixa(conversa, p.inboxId));
  const cliente = portaId ? await clienteDoAgente(portaId) : null;
  if (!portaId || !cliente) {
    await finalizar(p, FALHOU, "sem o robô do Chatwoot desta caixa — a pesquisa não saiu", avisos);
    return;
  }

  const aoVivo = await cliente.obterConversa(conversa);
  if (ehResolvida(aoVivo.status)) {
    await finalizar(p, CANCELADA, "a conversa já estava resolvida", avisos);
    return;
  }
  const inboxId = aoVivo.inboxId ?? p.inboxId;
  if (inboxId == null || !config.caixas.includes(inboxId)) {
    await finalizar(
      p,
      CANCELADA,
      `a caixa ${inboxId ?? "desconhecida"} está fora da pesquisa`,
      avisos,
    );
    return;
  }

  let telefone = p.telefone;
  if (!telefone && aoVivo.contactId) {
    try {
      const contato = await cliente.obterContato(aoVivo.contactId);
      telefone = telefoneCanonico(contato.telefone ?? "");
    } catch (erro) {
      avisos.push(`telefone do contato não lido: ${mensagemDe(erro)}`);
    }
  }
  if (telefone && config.horasEntrePesquisas > 0) {
    const recente = await db.pesquisaNps.findFirst({
      where: {
        telefone,
        id: { not: p.id },
        enviadaEm: { gte: new Date(agora - config.horasEntrePesquisas * HORA) },
      },
      select: { chatwootConversationId: true },
    });
    if (recente) {
      await finalizar(
        p,
        CANCELADA,
        `este telefone já recebeu a pesquisa nas últimas ${config.horasEntrePesquisas} h (conversa #${recente.chatwootConversationId})`,
        avisos,
      );
      return;
    }
  }

  // O marco: mensagem com id maior que este chegou depois da pesquisa.
  const mensagens = await cliente.listarMensagens(conversa);
  const referencia = mensagens.reduce((maior, m) => Math.max(maior, m.id), 0);

  try {
    const { count } = await db.pesquisaNps.updateMany({
      where: { id: p.id, status: AGENDADA },
      data: {
        status: AGUARDANDO,
        enviadaEm: new Date(agora),
        venceEm: new Date(agora + config.horasAteLembrete * HORA),
        portaAgentId: portaId,
        inboxId,
        telefone,
        referenciaMensagemId: referencia,
        tentativas: 0,
      },
    });
    if (count !== 1) return;
  } catch (erro) {
    // O índice parcial: já há uma pesquisa desta conversa em andamento.
    if (ehConflitoDeUnique(erro)) {
      await finalizar(p, CANCELADA, "já havia uma pesquisa em andamento nesta conversa", avisos);
      return;
    }
    throw erro;
  }

  // Desatribui, como o n8n: a pesquisa encerra o atendimento de quem atendeu.
  // Sem dono no Chatwoot, a conversa volta a ser do robô aqui também — é o que a
  // rota de conta gravaria ao ler o evento —, e uma mensagem do cliente que não
  // seja a nota é atendida pelo agente em vez de ficar sem ninguém.
  try {
    await cliente.desatribuir(conversa);
    await db.conversation.updateMany({
      where: { chatwootConversationId: conversa, status: ConversationStatus.HUMAN },
      data: { status: ConversationStatus.BOT },
    });
  } catch (erro) {
    avisos.push(`não desatribuí: ${mensagemDe(erro)}`);
  }

  try {
    // Uma de cada vez, esperando a anterior: o n8n mandou a terceira antes da
    // segunda na conversa 13925.
    for (const texto of [config.textos.agradecimento, config.textos.convite, config.textos.pergunta]) {
      await cliente.enviarMensagem(conversa, texto);
    }
  } catch (erro) {
    await finalizar(
      { ...p, status: AGUARDANDO },
      FALHOU,
      `a pesquisa não saiu inteira: ${mensagemDe(erro)}`,
      avisos,
    );
    return;
  }

  // A task do CRM não é tocada aqui: ela fica no status em que estiver
  // (decisão do usuário, 16/09/2026). A pesquisa só grava a nota, mais tarde.
  await anotar(p, ["pesquisa enviada", ...avisos]);
}

/** Sem nota até a hora do lembrete: confere a conversa ao vivo e lembra, uma vez. */
async function lembrar(p: Pesquisa, config: NpsConfig, agora: number) {
  const cliente = await clienteDaPesquisa(p);
  if (!cliente) {
    await finalizar(p, FALHOU, "sem o robô do Chatwoot desta caixa — o lembrete não saiu");
    return;
  }

  const conversa = p.chatwootConversationId;
  const [aoVivo, mensagens] = await Promise.all([
    cliente.obterConversa(conversa),
    cliente.listarMensagens(conversa),
  ]);
  if (ehResolvida(aoVivo.status)) {
    await finalizar(p, EXPIRADA, "sem nota, e a conversa foi resolvida antes do lembrete");
    return;
  }
  const motivo = motivoParaNaoAgir({
    conversa: aoVivo,
    mensagens,
    depoisDe: p.referenciaMensagemId ?? 0,
    clienteImpede: true,
  });
  if (motivo) {
    await finalizar(p, CANCELADA, `sem lembrete: ${motivo}`);
    return;
  }

  const { count } = await db.pesquisaNps.updateMany({
    where: { id: p.id, status: AGUARDANDO },
    data: {
      status: LEMBRADA,
      lembreteEm: new Date(agora),
      venceEm: new Date(agora + config.horasAteEncerrar * HORA),
      tentativas: 0,
    },
  });
  if (count !== 1) return;

  let rastro = "lembrete enviado";
  try {
    await cliente.enviarMensagem(conversa, config.textos.lembrete);
  } catch (erro) {
    rastro = `o lembrete não saiu: ${mensagemDe(erro)}`;
  }
  await anotar(p, [rastro]);
}

/** Sem nota até o fim do prazo depois do lembrete: resolve a conversa. */
async function expirar(p: Pesquisa, agora: number) {
  const cliente = await clienteDaPesquisa(p);
  if (!cliente) {
    await finalizar(p, FALHOU, "sem o robô do Chatwoot desta caixa — não resolvi");
    return;
  }

  const conversa = p.chatwootConversationId;
  const [aoVivo, mensagens] = await Promise.all([
    cliente.obterConversa(conversa),
    cliente.listarMensagens(conversa),
  ]);
  if (ehResolvida(aoVivo.status)) {
    await finalizar(p, EXPIRADA, "sem nota; a conversa já estava resolvida");
    return;
  }
  const motivo = motivoParaNaoAgir({
    conversa: aoVivo,
    mensagens,
    depoisDe: p.referenciaMensagemId ?? 0,
    clienteImpede: true,
  });
  if (motivo) {
    await finalizar(p, CANCELADA, `não resolvi: ${motivo}`);
    return;
  }

  const { count } = await db.pesquisaNps.updateMany({
    where: { id: p.id, status: LEMBRADA },
    data: { status: EXPIRADA, finalizadaEm: new Date(agora) },
  });
  if (count !== 1) return;

  await anotar(p, [await resolver(cliente, conversa, "sem nota até o fim do prazo")]);
}

/** A nota chegou: responde conforme a nota e grava no CRM. */
async function agradecer(p: Pesquisa, config: NpsConfig, agora: number) {
  if (p.nota == null) {
    await finalizar(p, FALHOU, "pesquisa respondida sem nota registrada");
    return;
  }
  const cliente = await clienteDaPesquisa(p);
  if (!cliente) {
    await finalizar(p, FALHOU, "sem o robô do Chatwoot desta caixa — não respondi à nota");
    return;
  }

  const conversa = p.chatwootConversationId;
  const ultima = (p.ultimaMensagemEm ?? p.respondidaEm ?? new Date(agora)).getTime();
  const encerrarEm = ultima + config.minutosAposNota * MINUTO;

  const { count } = await db.pesquisaNps.updateMany({
    where: { id: p.id, status: RESPONDIDA },
    data: { status: AGRADECIDA, venceEm: new Date(encerrarEm), tentativas: 0 },
  });
  if (count !== 1) return;

  const rastro: string[] = [`nota ${p.nota}`];
  try {
    await cliente.enviarMensagem(conversa, respostaDaNota(p.nota, config.textos));
  } catch (erro) {
    rastro.push(`a resposta à nota não saiu: ${mensagemDe(erro)}`);
  }

  await adiantar(p.id, encerrarEm - agora);

  const registro = await gravarNotaNoCrm({
    chatwootConversationId: conversa,
    nota: p.nota,
    telefone: p.telefone,
    config,
    agora,
    notaInterna: (texto) => notaInterna(cliente, conversa, texto),
  });
  rastro.push(rastroDoRegistro(registro));

  await db.pesquisaNps.update({
    where: { id: p.id },
    data: {
      registro: registro as unknown as Prisma.InputJsonValue,
      resultado: juntarRastro([p.resultado, ...rastro]),
    },
  });
}

/**
 * O cliente ficou `minutosAposNota` sem escrever depois da nota: resolve a
 * conversa. Complemento recomeça o prazo, e a conversa não é resolvida por cima
 * de uma pessoa nem de alguém da equipe que escreveu depois da nota.
 */
async function encerrar(p: Pesquisa, config: NpsConfig, agora: number) {
  const ultima = (p.ultimaMensagemEm ?? p.respondidaEm ?? p.venceEm).getTime();
  const encerrarEm = ultima + config.minutosAposNota * MINUTO;

  if (encerrarEm > agora) {
    await db.pesquisaNps.updateMany({
      where: { id: p.id, status: AGRADECIDA },
      data: { venceEm: new Date(encerrarEm) },
    });
    await adiantar(p.id, encerrarEm - agora);
    return;
  }

  const cliente = await clienteDaPesquisa(p);
  if (!cliente) {
    await finalizar(p, FALHOU, "sem o robô do Chatwoot desta caixa — não resolvi");
    return;
  }

  const conversa = p.chatwootConversationId;
  const [aoVivo, mensagens] = await Promise.all([
    cliente.obterConversa(conversa),
    cliente.listarMensagens(conversa),
  ]);
  const motivo = motivoParaNaoAgir({
    conversa: aoVivo,
    mensagens,
    depoisDe: p.notaMensagemId ?? p.referenciaMensagemId ?? 0,
    clienteImpede: false,
  });
  if (motivo) {
    await finalizar(p, CONCLUIDA, `não resolvi: ${motivo}`);
    return;
  }

  // Complemento que chegue entre a leitura e aqui muda `ultimaMensagemEm`: a
  // troca não acontece, e o prazo recomeça na volta seguinte.
  const { count } = await db.pesquisaNps.updateMany({
    where: { id: p.id, status: AGRADECIDA, ultimaMensagemEm: p.ultimaMensagemEm },
    data: { status: CONCLUIDA, finalizadaEm: new Date(agora) },
  });
  if (count !== 1) return;

  await anotar(p, [
    await resolver(
      cliente,
      conversa,
      `${config.minutosAposNota} min sem mensagem do cliente depois da nota`,
    ),
  ]);
}

async function finalizar(
  p: Pesquisa,
  status: PesquisaNpsStatus,
  motivo: string,
  extras: string[] = [],
) {
  await db.pesquisaNps.updateMany({
    where: { id: p.id, status: p.status },
    data: {
      status,
      finalizadaEm: new Date(),
      resultado: juntarRastro([p.resultado, motivo, ...extras]),
    },
  });
}

async function anotar(p: Pesquisa, partes: (string | null)[]) {
  await db.pesquisaNps.update({
    where: { id: p.id },
    data: { resultado: juntarRastro([p.resultado, ...partes]) },
  });
}

async function clienteDaPesquisa(p: Pesquisa): Promise<ChatwootClient | null> {
  return p.portaAgentId ? clienteDoAgente(p.portaAgentId) : null;
}

/**
 * Resolver é exceção consciente à regra de que o robô nunca resolve (decisão do
 * usuário, 15/09/2026): o n8n já resolvia, e a pesquisa é o fim do atendimento.
 */
async function resolver(cliente: ChatwootClient, conversa: number, porque: string): Promise<string> {
  try {
    await cliente.alternarStatus(conversa, "resolved");
  } catch (erro) {
    return `não consegui resolver a conversa: ${mensagemDe(erro)}`;
  }
  try {
    // Sem esperar o webhook: o corte do histórico vale a partir de agora.
    await marcarResolvida(conversa);
  } catch (erro) {
    logger.warn({ conversa, erro: mensagemDe(erro) }, "NPS: resolvida no Chatwoot, mas não no banco");
  }
  return `conversa resolvida (${porque})`;
}

async function notaInterna(cliente: ChatwootClient, conversa: number, texto: string) {
  try {
    await cliente.enviarMensagem(conversa, texto, { privado: true });
    return true;
  } catch (erro) {
    logger.warn({ conversa, erro: mensagemDe(erro) }, "NPS: a nota interna não foi gravada");
    return false;
  }
}

/** Enfileira a próxima olhada para a hora certa. Sem fila, o vigia cobre. */
async function adiantar(pesquisaId: string, esperaMs: number) {
  try {
    await agendarPesquisaNps(pesquisaId, esperaMs + 1_000);
  } catch (erro) {
    logger.warn(
      { pesquisaId, erro: mensagemDe(erro) },
      "NPS: não consegui enfileirar — fica com o vigia",
    );
  }
}

function rastroDoRegistro(registro: RegistroDaNota): string {
  const partes: string[] = [];
  if (registro.gravadas.length > 0) {
    partes.push(
      `gravada em ${registro.gravadas
        .map(
          (g) =>
            `${g.lista} (${g.url ?? g.tarefaId}, ${g.origem === "conversa" ? "task da conversa" : "pelo telefone"})`,
        )
        .join(", ")}`,
    );
  }
  if (registro.problemas.length > 0) partes.push(`sem gravar: ${registro.problemas.join("; ")}`);
  if (registro.notaInterna) partes.push("nota interna com a nota deixada na conversa");
  return juntarRastro(partes) ?? "";
}

function mensagemDe(erro: unknown) {
  return erro instanceof Error ? erro.message : String(erro);
}

function ehConflitoDeUnique(erro: unknown) {
  return (
    typeof erro === "object" &&
    erro !== null &&
    "code" in erro &&
    (erro as { code?: string }).code === "P2002"
  );
}
