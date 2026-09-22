import { IntegrationProvider, IntegrationStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { agoraEmSaoPaulo } from "@/lib/tempo";
import { conversaParaAviso } from "@/server/alerta-de-saldo/conversa";
import { resolverAtendente } from "@/server/integrations/chatwoot/atendentes";
import { ChatwootApiError, type ChatwootClient } from "@/server/integrations/chatwoot/client";
import { clienteComTokenDeUsuario } from "@/server/integrations/chatwoot/credenciais";
import type { ClickUpClient } from "@/server/integrations/clickup/client";
import { abrirClickUp } from "@/server/integrations/clickup/sistema";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";
import {
  comentarioDeEnvio,
  comentarioDeFalha,
  CONFERIR_A_CADA_MS,
  dentroDoHorario,
  ETIQUETAS,
  etiquetasDaTarefa,
  HORAS_SEM_REENVIO,
  lerConfigCobranca,
  naOrdemDeChegada,
  notaDaConversa,
  PROVIDER_DA_COBRANCA,
  telefoneDaTarefa,
  type CobrancaConfig,
  type Etiqueta,
} from "./regras";

/**
 * A rodada do aviso de cobrança, no relógio do vigia (regras em `regras.ts`).
 *
 * - **Não prende o vigia.** Com 30 s entre um envio e outro, uma rodada cheia
 *   leva minutos, e o vigia escala conversa de minuto em minuto. Ela começa e
 *   segue sozinha; a trava `rodando` impede duas ao mesmo tempo.
 * - **A mensagem sai pela caixa 31 com o token de Integrações → Chatwoot**, o
 *   mesmo caminho provado do alerta de saldo (`conversaParaAviso`): reaproveita
 *   contato e conversa aberta, confere o número com e sem o nono dígito. Aparece
 *   no Chatwoot em nome da pessoa dona do token. Na caixa 31 não há robô, prazo
 *   nem NPS nossos para isso atrapalhar.
 * - ⚠ **Reserva antes de enviar.** A linha em `WebhookEvent` nasce "reservado"
 *   e vira "enviado" depois; se o processo cair no meio, a reserva que ficou
 *   impede a rodada seguinte de mandar de novo, e a task ganha um comentário
 *   pedindo para conferir.
 * - **A etiqueta só sai depois do envio aceito.** Se tirar a etiqueta falhar, a
 *   trava de `HORAS_SEM_REENVIO` segura o reenvio e a rodada seguinte só tenta
 *   tirar de novo.
 * - **Falha que não se resolve sozinha** (sem CELULAR, número recusado) comenta
 *   UMA vez e deixa a etiqueta — é ela que mostra ao Laercio o que não saiu.
 *   Corrigido o número, a chave muda e a task é tentada de novo.
 */

const PAGINAS_MAXIMAS = 10;
const POR_PAGINA = 100;
/** Reserva mais velha que isto não é de uma rodada viva: o processo caiu no meio. */
const RESERVA_ABANDONADA_MS = 10 * 60_000;

let ultimaConferencia = 0;
let rodando = false;

export type RodadaDeCobranca = {
  acao:
    | "cedo"
    | "em andamento"
    | "desligada"
    | "fora do horário"
    | "sem clickup"
    | "sem chatwoot"
    | "iniciada"
    | "conferido";
  tarefas?: number;
  enviados?: number;
  falhas?: number;
  jaEnviados?: number;
  paradaPeloTeto?: boolean;
  erro?: string;
};

type Dependencias = {
  /** Espera entre envios; o teste troca por uma que não espera. */
  dormir?: (ms: number) => Promise<void>;
  /** Para teste: devolve a rodada inteira em vez de só iniciá-la. */
  esperar?: boolean;
  forcar?: boolean;
};

const dormirDeVerdade = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Chamada pelo vigia a cada minuto; confere de fato a cada `CONFERIR_A_CADA_MS`. */
export async function conferirCobrancas(
  agora = new Date(),
  opcoes: Dependencias = {},
): Promise<RodadaDeCobranca> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }

  const linha = await db.integration.findUnique({
    where: { provider: IntegrationProvider.COBRANCA },
    select: { enabled: true, config: true },
  });
  if (!linha?.enabled) return { acao: "desligada" };
  // Fora do horário não conta como conferência: às 8h ela roda no primeiro minuto.
  if (!opcoes.forcar && !dentroDoHorario(agora)) return { acao: "fora do horário" };

  ultimaConferencia = agora.getTime();
  rodando = true;
  const config = lerConfigCobranca(linha.config);
  const rodada = rodar(agora, config, opcoes.dormir ?? dormirDeVerdade)
    .then(async (r) => {
      await registrarRodada(agora, r);
      if (r.enviados || r.falhas) logger.info(r, "aviso de cobrança conferido");
      return r;
    })
    .catch(async (erro: unknown) => {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      logger.error({ erro }, "aviso de cobrança falhou");
      const r: RodadaDeCobranca = { acao: "conferido", erro: mensagem };
      await registrarRodada(agora, r).catch(() => {});
      return r;
    })
    .finally(() => {
      rodando = false;
    });

  if (opcoes.esperar) return rodada;
  void rodada;
  return { acao: "iniciada" };
}

/** Só para teste: esquece o relógio entre um caso e outro. */
export function reiniciarRelogioDaCobranca() {
  ultimaConferencia = 0;
  rodando = false;
}

async function rodar(
  agora: Date,
  config: CobrancaConfig,
  dormir: (ms: number) => Promise<void>,
): Promise<RodadaDeCobranca> {
  const clickup = await abrirClickUp("cobranca");
  if ("erro" in clickup) return { acao: "sem clickup", erro: clickup.erro };
  const chatwoot = await clienteComTokenDeUsuario();
  if (!chatwoot) {
    return {
      acao: "sem chatwoot",
      erro: "sem o token de Integrações → Chatwoot não há como mandar a mensagem",
    };
  }

  const tarefas = naOrdemDeChegada(await tarefasComEtiqueta(clickup.cliente, config.listaId));
  const rodada: RodadaDeCobranca = {
    acao: "conferido",
    tarefas: tarefas.length,
    enviados: 0,
    falhas: 0,
    jaEnviados: 0,
  };

  let atendentes: Awaited<ReturnType<ChatwootClient["listarAtendentes"]>> | null = null;
  let enviouAlgum = false;

  for (const tarefa of tarefas) {
    for (const etiqueta of etiquetasDaTarefa(tarefa)) {
      const desfecho = await tratar({
        tarefa,
        etiqueta,
        agora,
        config,
        clickup: clickup.cliente,
        chatwoot,
        antesDeEnviar: async () => {
          // Espaça os envios. O primeiro da rodada não espera.
          if (enviouAlgum) await dormir(config.intervaloSegundos * 1000);
          return (await enviadosNaUltimaHora(new Date())) < config.tetoPorHora;
        },
        atendentes: async () => (atendentes ??= await chatwoot.listarAtendentes()),
      });
      if (desfecho === "enviado") {
        enviouAlgum = true;
        rodada.enviados! += 1;
      }
      if (desfecho === "falhou") rodada.falhas! += 1;
      if (desfecho === "jaEnviado") rodada.jaEnviados! += 1;
      if (desfecho === "teto") {
        rodada.paradaPeloTeto = true;
        return rodada;
      }
    }
  }
  return rodada;
}

/** As tasks da lista com qualquer etiqueta de cobrança, página a página. */
async function tarefasComEtiqueta(cliente: ClickUpClient, listaId: string) {
  const todas: ClickUpTarefa[] = [];
  for (let page = 0; page < PAGINAS_MAXIMAS; page++) {
    const { tasks } = await cliente.listarTarefasDaLista(listaId, {
      page,
      tags: [...ETIQUETAS],
      // A task pode estar num status de encerramento (inadimplente, negativado).
      incluirFechadas: true,
    });
    todas.push(...tasks);
    if (tasks.length < POR_PAGINA) break;
  }
  return todas;
}

type Desfecho = "enviado" | "falhou" | "jaEnviado" | "teto" | "pulado";

async function tratar(args: {
  tarefa: ClickUpTarefa;
  etiqueta: Etiqueta;
  agora: Date;
  config: CobrancaConfig;
  clickup: ClickUpClient;
  chatwoot: ChatwootClient;
  antesDeEnviar: () => Promise<boolean>;
  atendentes: () => Promise<Awaited<ReturnType<ChatwootClient["listarAtendentes"]>>>;
}): Promise<Desfecho> {
  const { tarefa, etiqueta, config, clickup, chatwoot } = args;
  const urlDaTarefa = tarefa.url ?? null;

  // 1. Já foi enviado há pouco? Então a etiqueta só não saiu: tira de novo.
  const recente = await envioRecente(tarefa.id, etiqueta, args.agora);
  if (recente) {
    const abandonada =
      recente.resultado === "reservado" &&
      args.agora.getTime() - recente.createdAt.getTime() > RESERVA_ABANDONADA_MS;
    if (recente.resultado === "reservado" && !abandonada) return "pulado";
    if (abandonada) {
      await db.webhookEvent.update({
        where: { id: recente.id },
        data: {
          resultado: "incerto",
          detalhe: "a rodada caiu no meio do envio; pode ter saído",
          processedAt: new Date(),
        },
      });
      await tentar(() =>
        clickup.comentarTarefa(
          tarefa.id,
          `⚠ O envio do aviso "${etiqueta}" foi interrompido no meio e PODE ter chegado ao cliente. Confira a conversa no Chatwoot antes de pôr a etiqueta de novo.`,
        ),
      );
    }
    await tentar(() => clickup.removerTag(tarefa.id, etiqueta));
    return "jaEnviado";
  }

  // 2. Sem telefone utilizável não há o que fazer: comenta uma vez e segue.
  const telefone = telefoneDaTarefa(tarefa, config.campoTelefone);
  if (!telefone) {
    return falhaDefinitiva(args, "sem-celular", "a task não tem CELULAR válido.");
  }
  const chaveDaFalha = (codigo: string) => `falha:${tarefa.id}:${etiqueta}:${codigo}:${telefone}`;
  if (await existe(chaveDaFalha("recusado"))) return "pulado";

  // 3. Ritmo e teto por hora.
  if (!(await args.antesDeEnviar())) return "teto";

  // 4. Reserva, envio, e só então o resto.
  const reserva = await db.webhookEvent.create({
    data: {
      provider: PROVIDER_DA_COBRANCA,
      externalId: `envio:${tarefa.id}:${etiqueta}:${args.agora.toISOString()}:${Math.random().toString(36).slice(2, 8)}`,
      eventType: etiqueta,
      payload: { taskId: tarefa.id, taskUrl: urlDaTarefa, etiqueta },
      resultado: "reservado",
    },
    select: { id: true },
  });

  let conversaId: number;
  try {
    const conversa = await conversaParaAviso(chatwoot, config.caixaId, {
      nome: tarefa.name?.trim() || "Cliente",
      telefone,
    });
    conversaId = conversa.conversaId;
    await chatwoot.enviarMensagem(conversaId, config.mensagens[etiqueta]);
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await db.webhookEvent.update({
      where: { id: reserva.id },
      data: { resultado: "falhou", detalhe: mensagem.slice(0, 500), processedAt: new Date() },
    });
    // 4xx é recusa do Chatwoot (número que ele não aceita, contato inválido):
    // tentar de 30 em 30 minutos não muda nada. O resto tenta na próxima rodada.
    if (erro instanceof ChatwootApiError && erro.status >= 400 && erro.status < 500) {
      await falhaDefinitiva(
        args,
        "recusado",
        `o Chatwoot recusou o envio (${erro.status}). Confira o número no campo CELULAR.`,
        telefone,
      );
    }
    return "falhou";
  }

  const problemas: string[] = [];
  const linkDaConversa = `${chatwoot.baseUrl}/app/accounts/${chatwoot.contaId}/conversations/${conversaId}`;

  await db.webhookEvent.update({
    where: { id: reserva.id },
    data: {
      resultado: "enviado",
      detalhe: "mensagem aceita pelo Chatwoot",
      processedAt: new Date(),
      payload: { taskId: tarefa.id, taskUrl: urlDaTarefa, etiqueta, conversaId },
    },
  });

  // A conversa vai para quem cuida da cobrança — mas nunca é tirada de quem
  // já está falando com o cliente.
  let atribuidoA: string | null = null;
  try {
    const aoVivo = await chatwoot.obterConversa(conversaId);
    if (aoVivo.assigneeId == null && config.atribuirA) {
      const destino = resolverAtendente(config.atribuirA, await args.atendentes());
      if (destino.tipo === "achado") {
        await chatwoot.atribuir(conversaId, { assigneeId: destino.atendente.id });
        atribuidoA = destino.atendente.name?.trim() || config.atribuirA;
      } else {
        problemas.push(`não achei "${config.atribuirA}" no Chatwoot para atribuir a conversa.`);
      }
    } else if (aoVivo.assigneeId != null) {
      problemas.push(
        `a conversa já estava com ${aoVivo.assigneeNome ?? "outra pessoa"}, e continua com ela.`,
      );
    }
  } catch (erro) {
    problemas.push(`não consegui atribuir a conversa (${mensagemDe(erro)}).`);
  }

  await tentar(
    () => chatwoot.enviarMensagem(conversaId, notaDaConversa(etiqueta, urlDaTarefa), { privado: true }),
    () => problemas.push("não consegui deixar a nota interna na conversa."),
  );

  const { data, hora } = agoraEmSaoPaulo(new Date());
  await tentar(
    () => clickup.removerTag(tarefa.id, etiqueta),
    () =>
      problemas.push(
        `não consegui tirar a etiqueta "${etiqueta}"; ela sai na próxima conferência, sem reenviar a mensagem.`,
      ),
  );
  await tentar(() =>
    clickup.comentarTarefa(
      tarefa.id,
      comentarioDeEnvio({ etiqueta, quando: `${data} às ${hora}`, linkDaConversa, atribuidoA, problemas }),
    ),
  );

  if (problemas.length) {
    await db.webhookEvent.update({
      where: { id: reserva.id },
      data: { detalhe: `mensagem aceita pelo Chatwoot · ${problemas.join(" · ")}`.slice(0, 500) },
    });
  }
  return "enviado";
}

/**
 * Registra a falha e comenta na task UMA vez por motivo (e por número): a
 * etiqueta fica, e é ela que mostra que a mensagem não saiu.
 */
async function falhaDefinitiva(
  args: { tarefa: ClickUpTarefa; etiqueta: Etiqueta; clickup: ClickUpClient },
  codigo: string,
  motivo: string,
  telefone = "sem",
): Promise<Desfecho> {
  const chave = `falha:${args.tarefa.id}:${args.etiqueta}:${codigo}:${telefone}`;
  if (await existe(chave)) return "pulado";
  await db.webhookEvent.create({
    data: {
      provider: PROVIDER_DA_COBRANCA,
      externalId: chave,
      eventType: args.etiqueta,
      payload: { taskId: args.tarefa.id, taskUrl: args.tarefa.url ?? null, etiqueta: args.etiqueta },
      resultado: "falhou",
      detalhe: motivo,
      processedAt: new Date(),
    },
  });
  await tentar(() => args.clickup.comentarTarefa(args.tarefa.id, comentarioDeFalha(args.etiqueta, motivo)));
  return "falhou";
}

async function envioRecente(taskId: string, etiqueta: Etiqueta, agora: Date) {
  return db.webhookEvent.findFirst({
    where: {
      provider: PROVIDER_DA_COBRANCA,
      externalId: { startsWith: `envio:${taskId}:${etiqueta}:` },
      resultado: { in: ["enviado", "reservado"] },
      createdAt: { gte: new Date(agora.getTime() - HORAS_SEM_REENVIO * 3_600_000) },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, resultado: true, createdAt: true },
  });
}

async function enviadosNaUltimaHora(agora: Date) {
  return db.webhookEvent.count({
    where: {
      provider: PROVIDER_DA_COBRANCA,
      resultado: "enviado",
      createdAt: { gte: new Date(agora.getTime() - 3_600_000) },
    },
  });
}

async function existe(externalId: string) {
  const linha = await db.webhookEvent.findUnique({
    where: { provider_externalId: { provider: PROVIDER_DA_COBRANCA, externalId } },
    select: { id: true },
  });
  return Boolean(linha);
}

async function tentar(acao: () => Promise<unknown>, seFalhar?: () => void) {
  try {
    await acao();
  } catch (erro) {
    logger.warn({ erro: mensagemDe(erro) }, "aviso de cobrança: passo complementar falhou");
    seFalhar?.();
  }
}

function mensagemDe(erro: unknown) {
  return (erro instanceof Error ? erro.message : String(erro)).slice(0, 200);
}

async function registrarRodada(agora: Date, r: RodadaDeCobranca) {
  const erro = r.erro ?? (r.falhas ? `${r.falhas} aviso(s) não enviado(s) nesta conferência` : null);
  await db.integration.update({
    where: { provider: IntegrationProvider.COBRANCA },
    data: {
      lastCheckedAt: agora,
      status: r.erro ? IntegrationStatus.ERROR : IntegrationStatus.OK,
      lastError: erro,
    },
  });
}
