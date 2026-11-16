import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { agoraEmSaoPaulo, diaEmSaoPaulo } from "@/lib/tempo";
import { conversaParaAviso } from "@/server/alerta-de-saldo/conversa";
import { resolverAtendente } from "@/server/integrations/chatwoot/atendentes";
import { opcoesDeAusencia } from "@/server/integrations/chatwoot/ausencias-config";
import { ChatwootApiError, type ChatwootClient } from "@/server/integrations/chatwoot/client";
import { clienteComTokenDeUsuario } from "@/server/integrations/chatwoot/credenciais";
import { camposDaTarefa } from "@/server/integrations/clickup/campos-da-tarefa";
import type { ClickUpClient } from "@/server/integrations/clickup/client";
import { abrirClickUp } from "@/server/integrations/clickup/sistema";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";

import { LISTA_BASE_DE_CLIENTES, PAGINAS_MAXIMAS } from "./clickup";
import { configDaRenovacao, type ConfigDaRenovacao, type ModoDeParte } from "./config";
import { PROVIDER_RENOVACAO, STATUS_NOTIFICACAO } from "./regras";
import {
  CAIXA_DO_WHATSAPP,
  chaveDaFalha,
  chaveDoEnsaio,
  chaveDoEnvio,
  CHAVE_DO_RESUMO,
  CODIGOS_SILENCIOSOS,
  comentarioDeEnvio,
  comentarioDeFalha,
  comentarioDeIncerto,
  CONFERIR_A_CADA_MS,
  decidirAviso,
  dentroDoHorarioComercial,
  ehClienteOne,
  ehRecusaClara,
  ENVIOS_POR_RODADA,
  finalDoTelefone,
  INTERVALO_ENTRE_ENVIOS_S,
  nomeDoContato,
  notaDaConversa,
  PREFIXO_DA_RESERVA,
  RESERVA_ABANDONADA_MS,
  responsavelDaTarefa,
  telefoneDaTarefaOne,
  TETO_POR_HORA,
  textoDaMensagem,
  type TarefaParaAvisar,
} from "./whatsapp";

/**
 * A rodada do WhatsApp da renovação para o cliente ONE (regras, e o porquê de
 * cada uma, em `whatsapp.ts`). Roda no relógio do vigia.
 *
 * ⚠⚠ **Nasce desligada** (`avisarPorWhatsapp`), e ligar fala com CLIENTE. Há um
 * degrau antes: o modo `sombra` lê, decide e registra para quem a mensagem iria,
 * sem tocar no Chatwoot nem no ClickUp. É o que se confere antes de ligar.
 *
 * - **Não prende o vigia.** Com 30 s entre envios a rodada leva minutos; ela
 *   começa e segue sozinha, e a trava `rodando` impede duas ao mesmo tempo.
 * - **A mensagem sai pela caixa 31 com o token de Integrações → Chatwoot**, o
 *   mesmo caminho do aviso de cobrança (`conversaParaAviso`): reaproveita contato
 *   e conversa aberta. Aparece no Chatwoot em nome da pessoa dona do token.
 * - ⚠ **Reserva antes de enviar** (`whatsapp:<tarefa>:<entrada>`): a MESMA entrada
 *   em `notificação renovação` nunca recebe duas mensagens. Voltar ao status e
 *   entrar de novo é outra entrada.
 * - ⚠ **Recusa libera; INCERTO segura.** O Chatwoot recusando (4xx) é "nada
 *   saiu", e a reserva se desfaz. Falha de rede, prazo ou 5xx DEPOIS de pedir o
 *   envio pode ter saído: a reserva fica `incerto`, a tarefa ganha um comentário e
 *   nada é reenviado. Repetir às cegas é o defeito de origem do fluxo do n8n
 *   (cliente recebendo o mesmo template três vezes).
 * - **Nunca tira a conversa de quem está com ela**: só atribui se não houver dono,
 *   e reabre a resolvida ANTES (a caixa 31 devolve a última conversa do contato,
 *   mesmo resolvida).
 */

const POR_PAGINA = 100;
/** Tempo para as automações do Chatwoot rodarem antes de conferir a atribuição. */
const ESPERA_PARA_CONFERIR_MS = 3_000;

let ultimaConferencia = 0;
let rodando = false;

type Cliente = Pick<ClickUpClient, "listarTarefasDaLista" | "tempoNoStatus" | "comentarTarefa">;
type Atendentes = Awaited<ReturnType<ChatwootClient["listarAtendentes"]>>;

export type RodadaDeWhatsapp = {
  acao:
    | "cedo"
    | "em andamento"
    | "desligada"
    | "fora do horário"
    | "sem clickup"
    | "sem chatwoot"
    | "iniciada"
    | "conferido";
  modo?: ModoDeParte;
  motivo?: string;
  /** Tarefas em `notificação renovação`. */
  noStatus?: number;
  clientesOne?: number;
  foraDaJanela?: number;
  enviadas?: string[];
  /** No modo `sombra`: para quem a mensagem iria. */
  planejadas?: string[];
  jaEnviadas?: number;
  falhas?: string[];
  incertas?: string[];
  /** O que a rodada olhou, quis mandar e não mandou — cada item com o motivo. */
  pendentes?: string[];
  paradaPeloTeto?: boolean;
  erro?: string;
};

type Opcoes = {
  /** Espera entre envios; o teste troca por uma que não espera. */
  dormir?: (ms: number) => Promise<void>;
  /** Para teste: devolve a rodada inteira em vez de só iniciá-la. */
  esperar?: boolean;
  forcar?: boolean;
};

const dormirDeVerdade = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Chamada pelo vigia a cada minuto; confere de fato a cada `CONFERIR_A_CADA_MS`. */
export async function avisarPorWhatsapp(
  opcoes: Opcoes = {},
  agora = new Date(),
): Promise<RodadaDeWhatsapp> {
  if (rodando) return { acao: "em andamento" };

  const config = await configDaRenovacao();
  if (config.avisarPorWhatsapp === "desligado") return { acao: "desligada" };

  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  // Fora do horário não conta como conferência: às 8h ela roda no primeiro minuto.
  if (!opcoes.forcar && !dentroDoHorarioComercial(agora)) return { acao: "fora do horário" };

  ultimaConferencia = agora.getTime();
  rodando = true;
  const rodada = rodar(agora, config, opcoes.dormir ?? dormirDeVerdade)
    .then(async (r) => {
      await registrarRodada(agora, r);
      if (r.enviadas?.length || r.falhas?.length || r.incertas?.length || r.planejadas?.length) {
        logger.info(r, "whatsapp da renovação conferido");
      }
      return r;
    })
    .catch(async (erro: unknown) => {
      logger.error({ erro }, "whatsapp da renovação falhou");
      const r: RodadaDeWhatsapp = {
        acao: "conferido",
        modo: config.avisarPorWhatsapp,
        erro: erro instanceof Error ? erro.message : String(erro),
      };
      await registrarRodada(agora, r);
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
export function reiniciarRelogioDoWhatsapp() {
  ultimaConferencia = 0;
  rodando = false;
}

async function tarefasEmNotificacao(cliente: Cliente) {
  const tarefas: ClickUpTarefa[] = [];
  for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
    const { tasks } = await cliente.listarTarefasDaLista(LISTA_BASE_DE_CLIENTES, {
      statuses: [STATUS_NOTIFICACAO],
      page: pagina,
    });
    tarefas.push(...tasks);
    if (tasks.length < POR_PAGINA) break;
  }
  return tarefas;
}

/** O nome da opção de `CATEGORIA DE SERVIÇO` (dropdown, traduzido por `camposDaTarefa`). */
function categoriaDe(campos: Record<string, unknown>) {
  const valor = campos["CATEGORIA DE SERVIÇO"];
  return typeof valor === "string" ? valor : null;
}

/** `tempoNoStatus` lê até 100 por chamada. */
async function desdeQuando(cliente: Cliente, ids: string[]) {
  const todas: Awaited<ReturnType<Cliente["tempoNoStatus"]>> = {};
  for (let i = 0; i < ids.length; i += 100) {
    Object.assign(todas, await cliente.tempoNoStatus(ids.slice(i, i + 100)));
  }
  return todas;
}

type Elegivel = { tarefa: ClickUpTarefa; t: TarefaParaAvisar; entrouEmMs: number; responsavel: string | null };

async function rodar(
  agora: Date,
  config: ConfigDaRenovacao,
  dormir: (ms: number) => Promise<void>,
): Promise<RodadaDeWhatsapp> {
  const modo = config.avisarPorWhatsapp;
  const ligado = modo === "ligado";

  const clickup = await abrirClickUp("whatsapp da renovação");
  if ("erro" in clickup) return { acao: "sem clickup", modo, motivo: clickup.erro };
  const cliente = clickup.cliente as Cliente;

  const lista = await tarefasEmNotificacao(cliente);
  // Só as ONE precisam do tempo no status: as outras nem entram na conta.
  const doOne = lista.filter((t) => ehClienteOne(categoriaDe(camposDaTarefa(t))));
  const desde = doOne.length ? await desdeQuando(cliente, doOne.map((t) => t.id)) : {};

  const rodada: RodadaDeWhatsapp = {
    acao: "conferido",
    modo,
    noStatus: lista.length,
    clientesOne: doOne.length,
    foraDaJanela: 0,
    enviadas: [],
    planejadas: [],
    jaEnviadas: 0,
    falhas: [],
    incertas: [],
    pendentes: [],
  };

  const elegiveis: Elegivel[] = [];
  for (const tarefa of lista) {
    const campos = camposDaTarefa(tarefa);
    const entrada = desde[tarefa.id];
    // ⚠ O tempo lido tem de ser do status DE AGORA: se a leitura diz outro status,
    // a tarefa mudou entre as duas chamadas e fica para a próxima.
    const entrouEmMs =
      entrada && entrada.status?.trim().toLowerCase() === STATUS_NOTIFICACAO
        ? entrada.desde
        : null;
    const t: TarefaParaAvisar = {
      id: tarefa.id,
      nome: tarefa.name ?? tarefa.id,
      status: tarefa.status?.status ?? "",
      entrouEmMs,
      categoria: categoriaDe(campos),
      telefone: telefoneDaTarefaOne(tarefa),
    };

    const decisao = decidirAviso(t, agora);
    if (decisao.enviar) {
      elegiveis.push({ tarefa, t, entrouEmMs: decisao.entrouEmMs, responsavel: responsavelDaTarefa(campos) });
      continue;
    }
    if (decisao.codigo === "fora-da-janela") rodada.foraDaJanela! += 1;
    if (CODIGOS_SILENCIOSOS.includes(decisao.codigo)) continue;

    rodada.pendentes!.push(`${t.nome}: ${decisao.motivo}`);
    // Sem CELULAR não se resolve esperando: comenta UMA vez, mas só no modo ligado
    // (a sombra não escreve nada em lugar nenhum).
    if (ligado && decisao.codigo === "sem-celular" && t.entrouEmMs != null) {
      await falhaDefinitiva(cliente, tarefa, t.entrouEmMs, "sem-celular", "sem", decisao.motivo);
    }
  }

  if (!elegiveis.length) return rodada;
  // As que esperam há mais tempo primeiro.
  elegiveis.sort((a, b) => a.entrouEmMs - b.entrouEmMs);

  if (!ligado) {
    for (const e of elegiveis) {
      const criada = await registrarEnsaio(e);
      if (criada) rodada.planejadas!.push(e.t.nome);
    }
    return rodada;
  }

  const chatwoot = await clienteComTokenDeUsuario();
  if (!chatwoot) {
    return {
      ...rodada,
      acao: "sem chatwoot",
      motivo: "sem o token de Integrações → Chatwoot não há como mandar a mensagem",
    };
  }

  let atendentes: Atendentes | null = null;
  let enviouAlgum = false;
  let envios = 0;

  for (const e of elegiveis) {
    if (envios >= ENVIOS_POR_RODADA) break;
    const desfecho = await tratar({
      ...e,
      agora,
      config,
      cliente,
      chatwoot,
      antesDeEnviar: async () => {
        // Espaça os envios. O primeiro da rodada não espera.
        if (enviouAlgum) await dormir(INTERVALO_ENTRE_ENVIOS_S * 1000);
        return (await enviadosNaUltimaHora(new Date())) < TETO_POR_HORA;
      },
      atendentes: async () => (atendentes ??= await chatwoot.listarAtendentes()),
      esperar: dormir,
    });

    if (desfecho === "enviado") {
      enviouAlgum = true;
      envios += 1;
      rodada.enviadas!.push(e.t.nome);
    } else if (desfecho === "incerto") {
      enviouAlgum = true;
      envios += 1;
      rodada.incertas!.push(e.t.nome);
    } else if (desfecho === "abandonada") {
      rodada.incertas!.push(e.t.nome);
    } else if (desfecho === "falhou") {
      rodada.falhas!.push(e.t.nome);
    } else if (desfecho === "jaEnviado") {
      rodada.jaEnviadas! += 1;
    } else if (desfecho === "teto") {
      rodada.paradaPeloTeto = true;
      break;
    }
  }
  return rodada;
}

/** O ensaio: uma linha por entrada, sem telefone inteiro. `true` se era nova. */
async function registrarEnsaio(e: Elegivel) {
  try {
    await db.webhookEvent.create({
      data: {
        provider: PROVIDER_RENOVACAO,
        externalId: chaveDoEnsaio(e.t.id, e.entrouEmMs),
        eventType: "whatsapp-sombra",
        payload: { tarefaId: e.t.id, tarefa: e.t.nome, telefone: finalDoTelefone(e.t.telefone ?? "") },
        resultado: "ensaio",
        detalhe: `enviaria ao número ${finalDoTelefone(e.t.telefone ?? "")}`,
        processedAt: new Date(),
      },
    });
    return true;
  } catch {
    return false; // já registrado nesta entrada
  }
}

/**
 * `incerto`: pediu o envio e não sabe se saiu. `abandonada`: achou a reserva de
 * uma rodada que caiu — nada foi pedido AGORA, então não conta como envio nem
 * pede espera antes do próximo.
 */
type Desfecho = "enviado" | "incerto" | "abandonada" | "falhou" | "jaEnviado" | "teto" | "pulado";

async function tratar(args: Elegivel & {
  agora: Date;
  config: ConfigDaRenovacao;
  cliente: Cliente;
  chatwoot: ChatwootClient;
  antesDeEnviar: () => Promise<boolean>;
  atendentes: () => Promise<Atendentes>;
  esperar: (ms: number) => Promise<void>;
}): Promise<Desfecho> {
  const { tarefa, t, entrouEmMs, config, cliente, chatwoot } = args;
  const telefone = t.telefone as string;
  const chave = chaveDoEnvio(t.id, entrouEmMs);

  // 1. Esta entrada já foi tratada?
  const existente = await db.webhookEvent.findUnique({
    where: { provider_externalId: { provider: PROVIDER_RENOVACAO, externalId: chave } },
    select: { id: true, resultado: true, createdAt: true },
  });
  if (existente) {
    const abandonada =
      existente.resultado === "reservado" &&
      args.agora.getTime() - existente.createdAt.getTime() > RESERVA_ABANDONADA_MS;
    if (abandonada) {
      await db.webhookEvent.update({
        where: { id: existente.id },
        data: {
          resultado: "incerto",
          detalhe: "a rodada caiu no meio do envio; pode ter saído",
          processedAt: new Date(),
        },
      });
      await tentar(() =>
        cliente.comentarTarefa(t.id, comentarioDeIncerto("o sistema foi interrompido no meio do envio")),
      );
      return "abandonada";
    }
    return existente.resultado === "reservado" ? "pulado" : "jaEnviado";
  }
  // Recusado antes, com este mesmo número: corrigir o CELULAR muda a chave.
  if (await existe(chaveDaFalha(t.id, entrouEmMs, "recusado", telefone))) return "pulado";

  // 2. Ritmo e teto por hora.
  if (!(await args.antesDeEnviar())) return "teto";

  // 3. Reserva.
  let reservaId: string;
  try {
    reservaId = (
      await db.webhookEvent.create({
        data: {
          provider: PROVIDER_RENOVACAO,
          externalId: chave,
          eventType: "whatsapp",
          payload: { tarefaId: t.id, tarefaUrl: tarefa.url ?? null },
          resultado: "reservado",
        },
        select: { id: true },
      })
    ).id;
  } catch {
    return "pulado"; // outra rodada reservou no mesmo instante
  }
  const desfazer = () => db.webhookEvent.delete({ where: { id: reservaId } }).catch(() => {});

  // 4. Achar ou abrir a conversa. Nada saiu ainda: qualquer falha aqui desfaz a reserva.
  let conversaId: number;
  try {
    const conversa = await conversaParaAviso(chatwoot, CAIXA_DO_WHATSAPP, {
      nome: nomeDoContato(t.nome, args.responsavel),
      telefone,
    });
    conversaId = conversa.conversaId;
  } catch (erro) {
    await desfazer();
    if (erro instanceof ChatwootApiError && ehRecusaClara(erro.status)) {
      await falhaDefinitiva(
        cliente,
        tarefa,
        entrouEmMs,
        "recusado",
        telefone,
        `o Chatwoot recusou o número (${erro.status}). Confira o campo CELULAR`,
      );
    }
    return "falhou";
  }

  // 5. O envio. Daqui em diante a mensagem PODE ter saído.
  try {
    await chatwoot.enviarMensagem(conversaId, textoDaMensagem(config.whatsappTexto, args.responsavel));
  } catch (erro) {
    if (erro instanceof ChatwootApiError && ehRecusaClara(erro.status)) {
      await desfazer();
      await falhaDefinitiva(
        cliente,
        tarefa,
        entrouEmMs,
        "recusado",
        telefone,
        `o Chatwoot recusou o envio (${erro.status}). Confira o campo CELULAR`,
      );
      return "falhou";
    }
    const motivo = erro instanceof Error ? erro.message : String(erro);
    await db.webhookEvent.update({
      where: { id: reservaId },
      data: {
        resultado: "incerto",
        detalhe: `o envio falhou sem resposta clara: ${motivo}`.slice(0, 500),
        processedAt: new Date(),
      },
    });
    await tentar(() => cliente.comentarTarefa(t.id, comentarioDeIncerto("falha de rede ou do Chatwoot")));
    return "incerto";
  }

  await db.webhookEvent.update({
    where: { id: reservaId },
    data: {
      resultado: "enviado",
      detalhe: "mensagem aceita pelo Chatwoot",
      processedAt: new Date(),
      payload: { tarefaId: t.id, tarefaUrl: tarefa.url ?? null, conversaId },
    },
  });

  // 6. O resto é acabamento: falha aqui vira aviso no comentário, nunca reenvio.
  const problemas: string[] = [];
  const destino = await cuidarDaConversa({
    chatwoot,
    conversaId,
    atribuirA: config.whatsappAtribuirA,
    atendentes: args.atendentes,
    esperar: args.esperar,
    problemas,
    urlDaTarefa: tarefa.url ?? null,
  });

  const { data, hora } = agoraEmSaoPaulo(args.agora);
  await tentar(() =>
    cliente.comentarTarefa(
      t.id,
      comentarioDeEnvio({
        quando: `${data} às ${hora}`,
        linkDaConversa: `${chatwoot.baseUrl}/app/accounts/${chatwoot.contaId}/conversations/${conversaId}`,
        destino,
        problemas,
      }),
    ),
  );
  if (problemas.length) {
    await db.webhookEvent
      .update({
        where: { id: reservaId },
        data: { detalhe: `mensagem aceita pelo Chatwoot · ${problemas.join(" · ")}`.slice(0, 500) },
      })
      .catch(() => {});
  }
  return "enviado";
}

/**
 * Depois do envio: a conversa vai para quem cuida da renovação — mas nunca é
 * tirada de quem já está falando com o cliente. Era o que o n8n fazia (abrir e
 * atribuir ao Felipe), sem a trava.
 */
async function cuidarDaConversa(args: {
  chatwoot: ChatwootClient;
  conversaId: number;
  atribuirA: string;
  atendentes: () => Promise<Atendentes>;
  esperar: (ms: number) => Promise<void>;
  problemas: string[];
  urlDaTarefa: string | null;
}): Promise<string | null> {
  const { chatwoot, conversaId, atribuirA, problemas } = args;
  let destino: string | null = null;
  try {
    const aoVivo = await chatwoot.obterConversa(conversaId);

    // ⚠ A caixa 31 devolve a ÚLTIMA conversa do contato, mesmo resolvida, e a
    // mensagem entra nela sem reabrir. Resolvida, some da fila da equipe — e a
    // automação do Chatwoot que tira o dono de conversa resolvida desfaz a
    // atribuição no mesmo segundo. Reabre ANTES de atribuir.
    if (aoVivo.status === "resolved") await chatwoot.alternarStatus(conversaId, "open");

    if (aoVivo.assigneeId != null) {
      destino = `A conversa já estava com ${aoVivo.assigneeNome ?? "outra pessoa"} e continua com ela.`;
    } else {
      // Com a pessoa ausente (ver `ausencias.ts`), quem recebe é o substituto.
      const alvo = resolverAtendente(atribuirA, await args.atendentes(), await opcoesDeAusencia());
      if (alvo.tipo === "achado") {
        await chatwoot.atribuir(conversaId, { assigneeId: alvo.atendente.id });
        // As automações do Chatwoot rodam logo depois, fora da nossa vista: o
        // comentário só diz "atribuída" se ela continuou.
        await args.esperar(ESPERA_PARA_CONFERIR_MS);
        const depois = await chatwoot.obterConversa(conversaId);
        if (depois.assigneeId === alvo.atendente.id) {
          destino = `Conversa atribuída a ${alvo.atendente.name?.trim() || atribuirA}.`;
        } else {
          problemas.push(
            `atribuí a conversa a ${alvo.atendente.name?.trim() || atribuirA}, mas ela ficou ${
              depois.assigneeNome ? `com ${depois.assigneeNome}` : "sem dono"
            } — provavelmente uma automação do Chatwoot desfez.`,
          );
        }
      } else {
        problemas.push(`não achei "${atribuirA}" no Chatwoot para atribuir a conversa.`);
      }
    }
  } catch (erro) {
    problemas.push(`não consegui cuidar da conversa (${mensagemDe(erro)}).`);
  }

  await tentar(
    () => chatwoot.enviarMensagem(conversaId, notaDaConversa(args.urlDaTarefa), { privado: true }),
    () => problemas.push("não consegui deixar a nota interna na conversa."),
  );
  return destino;
}

/** Registra a falha e comenta na tarefa UMA vez por motivo (e por número). */
async function falhaDefinitiva(
  cliente: Cliente,
  tarefa: ClickUpTarefa,
  entrouEmMs: number,
  codigo: string,
  telefone: string,
  motivo: string,
) {
  const chave = chaveDaFalha(tarefa.id, entrouEmMs, codigo, telefone);
  if (await existe(chave)) return;
  await db.webhookEvent.create({
    data: {
      provider: PROVIDER_RENOVACAO,
      externalId: chave,
      eventType: "whatsapp-falha",
      payload: { tarefaId: tarefa.id },
      resultado: "falhou",
      detalhe: motivo.slice(0, 500),
      processedAt: new Date(),
    },
  });
  await tentar(() => cliente.comentarTarefa(tarefa.id, comentarioDeFalha(motivo)));
}

async function enviadosNaUltimaHora(agora: Date) {
  return db.webhookEvent.count({
    where: {
      provider: PROVIDER_RENOVACAO,
      externalId: { startsWith: `${PREFIXO_DA_RESERVA}:` },
      resultado: "enviado",
      createdAt: { gte: new Date(agora.getTime() - 3_600_000) },
    },
  });
}

async function existe(externalId: string) {
  const linha = await db.webhookEvent.findUnique({
    where: { provider_externalId: { provider: PROVIDER_RENOVACAO, externalId } },
    select: { id: true },
  });
  return Boolean(linha);
}

async function tentar(acao: () => Promise<unknown>, seFalhar?: () => void) {
  try {
    await acao();
  } catch (erro) {
    logger.warn({ erro: mensagemDe(erro) }, "whatsapp da renovação: passo complementar falhou");
    seFalhar?.();
  }
}

function mensagemDe(erro: unknown) {
  return (erro instanceof Error ? erro.message : String(erro)).slice(0, 200);
}

/**
 * O desfecho do dia, uma linha (`mensagens:<dia>`). ⚠ Soma o que as rodadas
 * anteriores do mesmo dia fizeram: a das 10h manda e a das 10h30 não acha nada, e
 * sobrescrever apagaria a única prova de que a das 10h mandou.
 */
async function registrarRodada(agora: Date, r: RodadaDeWhatsapp) {
  try {
    const externalId = `${CHAVE_DO_RESUMO}:${diaEmSaoPaulo(agora)}`;
    const anterior = await db.webhookEvent.findUnique({
      where: { provider_externalId: { provider: PROVIDER_RENOVACAO, externalId } },
      select: { detalhe: true },
    });
    let antes: Partial<RodadaDeWhatsapp> = {};
    try {
      antes = anterior?.detalhe ? (JSON.parse(anterior.detalhe) as Partial<RodadaDeWhatsapp>) : {};
    } catch {
      antes = {};
    }
    const soma = (a?: string[], b?: string[]) => [...new Set([...(a ?? []), ...(b ?? [])])];
    const detalhe: RodadaDeWhatsapp = {
      ...r,
      enviadas: soma(antes.enviadas, r.enviadas),
      planejadas: soma(antes.planejadas, r.planejadas),
      incertas: soma(antes.incertas, r.incertas),
      falhas: soma(antes.falhas, r.falhas),
    };
    const resultado = r.erro
      ? "falhou"
      : detalhe.incertas?.length
        ? "incerto"
        : detalhe.enviadas?.length
          ? "enviado"
          : detalhe.planejadas?.length
            ? "ensaio"
            : detalhe.falhas?.length
              ? "com falhas"
              : "nada a enviar";
    const dados = {
      resultado,
      detalhe: JSON.stringify(detalhe).slice(0, 2000),
      processedAt: agora,
    };
    await db.webhookEvent.upsert({
      where: { provider_externalId: { provider: PROVIDER_RENOVACAO, externalId } },
      create: {
        provider: PROVIDER_RENOVACAO,
        externalId,
        eventType: "whatsapp-rodada",
        payload: {},
        ...dados,
      },
      update: dados,
    });
  } catch (erro) {
    logger.error({ erro }, "não consegui registrar o desfecho do whatsapp da renovação");
  }
}
