import type { Prisma } from "@/generated/prisma/client";
import { IntegrationProvider, IntegrationStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import {
  clienteDeLeitura,
  clienteDoAgente,
} from "@/server/integrations/chatwoot/credenciais";
import { portaDaCaixa } from "@/server/integrations/chatwoot/porta";
import { lerConfigJanela, type JanelaConfig } from "./config";
import {
  decidir,
  estadoDaJanela,
  etiquetasDepoisDeFechar,
  HORAS_DA_JANELA,
  maisRecente,
  precisaLer,
  temEtiquetaDeFechada,
  textoDaNota,
  ultimaDoCliente,
  type EntradaDoCliente,
  type Janela,
  type LeituraDaJanela,
} from "./regras";

/**
 * A conferência da janela de 24 h, no relógio do vigia.
 *
 * Lê as conversas abertas e pendentes das caixas configuradas, deixa a nota
 * para quem atende quando falta `minutosDeAviso` para a janela fechar, e troca
 * `meta_janela_aberta` por `meta_janela_fechada` quando ela vence. Sem modelo:
 * é HTTP e decisão pura (`regras.ts`).
 *
 * - **A nota sai pelo robô da caixa**, não pelo token de uma pessoa. Nota de
 *   `user` conta como "alguém da equipe escreveu" para os prazos e para o NPS,
 *   e cancelaria o prazo de quem não respondeu; de `agent_bot`, não conta. Sem
 *   robô na caixa, sai pelo token de Integrações — lá também não há prazo nem
 *   pesquisa nossos para atrapalhar.
 * - **Uma nota por janela**, pela reserva em `WebhookEvent` chaveada pela
 *   mensagem do cliente: cliente escreveu de novo, é outra janela. Se a nota
 *   não sair, a reserva é desfeita e a conferência seguinte tenta de novo —
 *   aviso que falhou não pode contar como dado.
 * - ⚠ **A janela é do número, não da conversa.** Antes de escrever, as outras
 *   conversas do mesmo contato na mesma caixa são olhadas: a equipe pode ter
 *   aberto uma conversa nova com quem escreveu ontem na anterior. O fluxo do
 *   n8n guardava pelo telefone pelo mesmo motivo.
 * - ⚠ **Confere ao vivo antes de escrever.** Entre ler e escrever, o cliente
 *   pode ter mandado mensagem, e a automação 31 do Chatwoot já ter posto a
 *   etiqueta de aberta: trocar por "fechada" nesse instante deixaria a conversa
 *   marcada errado até a mensagem seguinte dele.
 * - ⚠ **Trocar etiqueta pela API dispara as automações de "conversa
 *   atualizada"** do Chatwoot, que avaliam o estado atual da conversa (conferido
 *   no código-fonte dele). Não é custo novo: o mesmo evento sai a cada mensagem,
 *   porque `waiting_since` também está na lista. O que muda é uma troca a mais
 *   por janela vencida.
 */

export const PROVIDER_DA_JANELA = "JANELA";

export const CONFERIR_JANELAS_A_CADA_MS = 5 * 60_000;

/** A listagem de conversas devolve 25 por página, e não há como pedir mais. */
const POR_PAGINA = 25;
/** Mil conversas abertas numa caixa: o teto é para o caso patológico, não para o dia a dia. */
const PAGINAS_MAXIMAS = 40;
/** A API de mensagens devolve no máximo 20 por chamada. */
const POR_PAGINA_DE_MENSAGENS = 20;
/** Cem mensagens para trás procurando o cliente. Além disso, a leitura para de andar. */
const PAGINAS_DE_MENSAGENS = 5;
/** Quantas conversas são lidas ao mesmo tempo. Gentil com o Chatwoot. */
const LOTE = 5;

/**
 * Teto de escritas por rodada. Na primeira conferência, a caixa 29 tinha 92
 * conversas vencidas marcadas como abertas; o teto espalha a correção por
 * algumas rodadas em vez de soltar quase duzentas chamadas de uma vez.
 */
export const TETO_DE_ESCRITAS_POR_RODADA = 40;

export type RodadaDaJanela = {
  acao: "cedo" | "em andamento" | "desligada" | "sem chatwoot" | "conferido";
  conversas?: number;
  lidas?: number;
  avisadas?: number;
  fechadas?: number;
  jaAvisadas?: number;
  mudaramAoVivo?: number;
  adiadas?: number;
  falhas?: number;
};

type ConversaListada = Awaited<ReturnType<ChatwootClient["listarConversas"]>>["conversas"][number];

type Alvo = {
  conversa: ConversaListada;
  caixa: number;
  ultima: EntradaDoCliente | null;
  janela: Janela;
};

/**
 * O que já se sabe de cada conversa, enquanto nada novo for escrito nela.
 *
 * A última mensagem do cliente só muda com mensagem nova, e mensagem nova muda
 * o `last_non_activity_message` da listagem. Enquanto ele for o mesmo, a leitura
 * de antes vale — e a conferência a cada 5 min deixa de reler a caixa inteira.
 * Vive na memória do processo: reiniciar só custa uma releitura.
 */
const cache = new Map<number, { ultimoIdVisto: number; leitura: LeituraDaJanela }>();

let ultimaConferencia = 0;
let conferindo = false;

/** Chamada pelo vigia a cada minuto; confere de fato a cada `CONFERIR_JANELAS_A_CADA_MS`. */
export async function conferirJanelas(
  agora = new Date(),
  opcoes: { forcar?: boolean } = {},
): Promise<RodadaDaJanela> {
  if (conferindo) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_JANELAS_A_CADA_MS) {
    return { acao: "cedo" };
  }

  conferindo = true;
  ultimaConferencia = agora.getTime();
  try {
    const linha = await db.integration.findUnique({
      where: { provider: IntegrationProvider.JANELA },
      select: { enabled: true, config: true },
    });
    if (!linha?.enabled) {
      cache.clear();
      return { acao: "desligada" };
    }

    const leitura = await clienteDeLeitura();
    if (!leitura) {
      await registrarRodada(
        agora,
        "Sem o token de leitura do Chatwoot (Integrações → Chatwoot), não há como ler as conversas.",
      );
      return { acao: "sem chatwoot" };
    }

    try {
      const rodada = await varrer(leitura.cliente, lerConfigJanela(linha.config), agora);
      await registrarRodada(agora, null);
      return rodada;
    } catch (erro) {
      await registrarRodada(agora, erro instanceof Error ? erro.message : String(erro));
      throw erro;
    }
  } finally {
    conferindo = false;
  }
}

async function varrer(
  leitor: ChatwootClient,
  config: JanelaConfig,
  agora: Date,
): Promise<RodadaDaJanela> {
  const agoraEmSegundos = Math.floor(agora.getTime() / 1000);
  const rodada: Required<Omit<RodadaDaJanela, "acao">> & { acao: "conferido" } = {
    acao: "conferido",
    conversas: 0,
    lidas: 0,
    avisadas: 0,
    fechadas: 0,
    jaAvisadas: 0,
    mudaramAoVivo: 0,
    adiadas: 0,
    falhas: 0,
  };

  const vistas = new Set<number>();
  const candidatas: { conversa: ConversaListada; caixa: number }[] = [];

  for (const caixa of config.caixas) {
    for (const status of ["open", "pending"] as const) {
      for (let pagina = 1; pagina <= PAGINAS_MAXIMAS; pagina++) {
        const { conversas } = await leitor.listarConversas({
          inboxId: caixa,
          tipoDeResponsavel: "all",
          status,
          pagina,
        });

        for (const conversa of conversas) {
          // ⚠ Conversa de outra caixa não passa, nem se a API ignorar o filtro:
          // a 31 e a 34 não têm janela, e marcá-las como fechadas mandaria a
          // equipe ligar para quem ainda pode receber mensagem.
          if (conversa.inboxId !== caixa || vistas.has(conversa.id)) continue;
          vistas.add(conversa.id);
          rodada.conversas++;

          if (
            precisaLer({
              etiquetas: conversa.etiquetas,
              ultimaMensagem: conversa.ultimaMensagem,
              agoraEmSegundos,
              minutosDeAviso: config.minutosDeAviso,
            })
          ) {
            candidatas.push({ conversa, caixa });
          }
        }

        // Página incompleta é o fim da lista.
        if (conversas.length < POR_PAGINA) break;
      }
    }
  }

  // O que saiu das caixas (resolvida, adiada) sai também da memória.
  for (const id of cache.keys()) if (!vistas.has(id)) cache.delete(id);

  const pendentes: Alvo[] = [];
  for (let i = 0; i < candidatas.length; i += LOTE) {
    await Promise.all(
      candidatas.slice(i, i + LOTE).map(async ({ conversa, caixa }) => {
        let leitura: LeituraDaJanela;
        try {
          leitura = await lerComCache(leitor, conversa, agoraEmSegundos, rodada);
        } catch (erro) {
          rodada.falhas++;
          logger.warn({ conversa: conversa.id, erro }, "janela: não consegui ler a conversa");
          return;
        }

        const janela = estadoDaJanela({
          leitura,
          agoraEmSegundos,
          minutosDeAviso: config.minutosDeAviso,
        });
        const acao = decidir(janela, conversa.etiquetas);
        if (acao.avisar || acao.fechar) {
          pendentes.push({ conversa, caixa, ultima: leitura.ultima, janela });
        }
      }),
    );
  }

  // Ordem fixa: com o teto, a leitura em lote terminaria numa ordem diferente a
  // cada rodada, e as que ficam para depois seriam sorteadas.
  pendentes.sort(ordemDeEscrita);

  const escritores = new Map<string, EscritorDoChatwoot>();
  let escritas = 0;
  for (const pendente of pendentes) {
    if (escritas >= TETO_DE_ESCRITAS_POR_RODADA) {
      rodada.adiadas++;
      continue;
    }

    // ⚠ A janela da Meta é do NÚMERO, não da conversa do Chatwoot: o cliente
    // pode ter escrito depois numa outra conversa dele na mesma caixa (a equipe
    // abriu uma nova, ou havia duas abertas). Confere aqui, só para quem vai ser
    // escrito agora — o que ficou para a rodada seguinte confere lá.
    let alvo: Alvo;
    try {
      alvo = await comOutrasConversas(pendente, leitor, agoraEmSegundos, config.minutosDeAviso);
    } catch (erro) {
      // Sem saber das outras conversas, não se age: na dúvida, fica como está.
      rodada.falhas++;
      logger.warn(
        { conversa: pendente.conversa.id, erro },
        "janela: não consegui ler as outras conversas do contato",
      );
      continue;
    }

    const acao = decidir(alvo.janela, alvo.conversa.etiquetas);
    if (acao.avisar) {
      if (await deixarNota(alvo, leitor, config, agora, escritores, rodada)) escritas++;
    } else if (acao.fechar) {
      if (await trocarEtiqueta(alvo, leitor, agora, escritores, rodada)) escritas++;
    }
  }

  return rodada;
}

/**
 * A nota vem primeiro, a mais urgente na frente: ela tem hora para sair, e a
 * etiqueta, não. Entre as vencidas, a que venceu por último vem antes — é a
 * conversa em que alguém ainda pode estar trabalhando.
 */
function ordemDeEscrita(a: Alvo, b: Alvo): number {
  const peso = (x: Alvo) => (x.janela.estado === "fechando" ? 0 : 1);
  if (peso(a) !== peso(b)) return peso(a) - peso(b);

  const fechaA = "fechaEm" in a.janela ? a.janela.fechaEm : null;
  const fechaB = "fechaEm" in b.janela ? b.janela.fechaEm : null;
  if (fechaA !== fechaB) {
    if (fechaA == null) return 1;
    if (fechaB == null) return -1;
    return a.janela.estado === "fechando" ? fechaA - fechaB : fechaB - fechaA;
  }
  return a.conversa.id - b.conversa.id;
}

/** O alvo com a janela recalculada, se o cliente escreveu mais tarde noutra conversa dele. */
async function comOutrasConversas(
  alvo: Alvo,
  leitor: LeitorDoChatwoot,
  agoraEmSegundos: number,
  minutosDeAviso: number,
): Promise<Alvo> {
  const outra = await ultimaEmOutraConversa(leitor, alvo.conversa, alvo.caixa, agoraEmSegundos);
  if (!outra || maisRecente(alvo.ultima, outra) !== outra) return alvo;

  return {
    ...alvo,
    ultima: outra,
    janela: estadoDaJanela({
      leitura: { ultima: outra, leuAteOComeco: false, maisAntigaEm: null },
      agoraEmSegundos,
      minutosDeAviso,
    }),
  };
}

async function lerComCache(
  leitor: ChatwootClient,
  conversa: ConversaListada,
  agoraEmSegundos: number,
  rodada: { lidas: number },
): Promise<LeituraDaJanela> {
  const idVisto = conversa.ultimaMensagem?.id ?? null;
  const guardada = cache.get(conversa.id);
  if (idVisto != null && guardada?.ultimoIdVisto === idVisto) return guardada.leitura;

  const leitura = await lerJanela(leitor, conversa.id, agoraEmSegundos);
  rodada.lidas++;
  if (idVisto != null) cache.set(conversa.id, { ultimoIdVisto: idVisto, leitura });
  return leitura;
}

/**
 * Anda para trás pelas mensagens até achar a última do cliente.
 *
 * Para cedo quando a resposta já é certa: chegou ao começo da conversa, ou já
 * leu mais de 24 h para trás sem achar nada — nos dois casos a janela está
 * fechada, e ler além disso não mudaria nada.
 */
async function lerJanela(
  leitor: LeitorDoChatwoot,
  conversaId: number,
  agoraEmSegundos: number,
): Promise<LeituraDaJanela> {
  let antesDe: number | undefined;
  let maisAntigaEm: number | null = null;

  for (let pagina = 1; pagina <= PAGINAS_DE_MENSAGENS; pagina++) {
    const mensagens = await leitor.listarMensagensAntes(conversaId, antesDe);
    if (mensagens.length === 0) return { ultima: null, leuAteOComeco: true, maisAntigaEm };

    const ultima = ultimaDoCliente(mensagens);
    if (ultima) return { ultima, leuAteOComeco: false, maisAntigaEm };

    for (const m of mensagens) {
      if (typeof m.created_at === "number" && (maisAntigaEm == null || m.created_at < maisAntigaEm)) {
        maisAntigaEm = m.created_at;
      }
    }
    antesDe = Math.min(...mensagens.map((m) => m.id));

    if (mensagens.length < POR_PAGINA_DE_MENSAGENS) {
      return { ultima: null, leuAteOComeco: true, maisAntigaEm };
    }
    if (maisAntigaEm != null && maisAntigaEm <= agoraEmSegundos - HORAS_DA_JANELA * 3600) {
      return { ultima: null, leuAteOComeco: false, maisAntigaEm };
    }
  }
  return { ultima: null, leuAteOComeco: false, maisAntigaEm };
}

/**
 * A mensagem do cliente mais recente nas OUTRAS conversas dele nesta caixa.
 *
 * Só lê as que tiveram atividade nas últimas 24 h: numa conversa parada há mais
 * tempo que isso, nenhuma mensagem do cliente pode reabrir a janela.
 */
async function ultimaEmOutraConversa(
  leitor: LeitorDoChatwoot,
  conversa: ConversaListada,
  caixa: number,
  agoraEmSegundos: number,
): Promise<EntradaDoCliente | null> {
  if (conversa.contatoId == null) return null;

  const corte = agoraEmSegundos - HORAS_DA_JANELA * 3600;
  const outras = (await leitor.conversasDoContato(conversa.contatoId)).filter(
    (c) =>
      c.caixaId === caixa &&
      c.id !== conversa.id &&
      c.ultimaAtividadeEm != null &&
      c.ultimaAtividadeEm > corte,
  );

  let melhor: EntradaDoCliente | null = null;
  for (const outra of outras) {
    melhor = maisRecente(melhor, (await lerJanela(leitor, outra.id, agoraEmSegundos)).ultima);
  }
  return melhor;
}

/**
 * O cliente escreveu depois da leitura? Relê só a página mais recente desta
 * conversa: se a última mensagem dele não estiver nela, ela é mais antiga do
 * que a página, e então não mudou. Compara por instante, não por id — a última
 * conhecida pode ser de outra conversa do mesmo contato.
 */
async function mudouAoVivo(
  leitor: LeitorDoChatwoot,
  conversaId: number,
  ultima: EntradaDoCliente | null,
): Promise<boolean> {
  const agora = ultimaDoCliente(await leitor.listarMensagens(conversaId));
  return agora != null && maisRecente(ultima, agora) === agora && agora.id !== ultima?.id;
}

type LeitorDoChatwoot = Pick<
  ChatwootClient,
  "listarMensagens" | "listarMensagensAntes" | "conversasDoContato"
>;
type EscritorDoChatwoot = Pick<
  ChatwootClient,
  "enviarMensagem" | "listarLabels" | "definirLabels"
>;

/** O robô da caixa, ou o token de Integrações quando a caixa não tem robô nosso. */
async function escritorDa(
  alvo: Alvo,
  leitor: ChatwootClient,
  escritores: Map<string, EscritorDoChatwoot>,
): Promise<EscritorDoChatwoot> {
  const porta = await portaDaCaixa(alvo.conversa.id, alvo.caixa);
  const chave = porta ?? "";
  const pronto = escritores.get(chave);
  if (pronto) return pronto;

  const escritor = (porta ? await clienteDoAgente(porta) : null) ?? leitor;
  escritores.set(chave, escritor);
  return escritor;
}

async function deixarNota(
  alvo: Alvo,
  leitor: ChatwootClient,
  config: JanelaConfig,
  agora: Date,
  escritores: Map<string, EscritorDoChatwoot>,
  rodada: { avisadas: number; jaAvisadas: number; mudaramAoVivo: number; falhas: number },
): Promise<boolean> {
  if (alvo.janela.estado !== "fechando" || !alvo.ultima) return false;
  const { conversa, ultima } = alvo;
  const fechaEm = alvo.janela.fechaEm;

  const externalId = `aviso:${conversa.id}:${ultima.id}`;

  // A conversa continua "fechando" por uma hora depois da nota, e é conferida
  // de novo a cada rodada. Perguntar antes evita que a trava de baixo — que é a
  // garantia de verdade, contra duas conferências ao mesmo tempo — escreva um
  // erro do Prisma no log a cada 5 minutos.
  const jaExiste = await db.webhookEvent.findUnique({
    where: { provider_externalId: { provider: PROVIDER_DA_JANELA, externalId } },
    select: { id: true },
  });
  if (jaExiste) {
    rodada.jaAvisadas++;
    return false;
  }

  let reservaId: string;
  try {
    const reserva = await db.webhookEvent.create({
      data: {
        provider: PROVIDER_DA_JANELA,
        externalId,
        eventType: `janela da conversa #${conversa.id} fechando`,
        resultado: "reservado",
        // Sem nome nem telefone: é o mesmo cuidado de Entregas.
        payload: {
          conversationId: conversa.id,
          inboxId: alvo.caixa,
          ultimaMensagemDoCliente: ultima.id,
          fechaEm,
        } as Prisma.InputJsonValue,
      },
    });
    reservaId = reserva.id;
  } catch (erro) {
    if (ehConflitoDeUnique(erro)) {
      rodada.jaAvisadas++;
      return false;
    }
    throw erro;
  }

  try {
    if (await mudouAoVivo(leitor, conversa.id, ultima)) {
      rodada.mudaramAoVivo++;
      await db.webhookEvent.delete({ where: { id: reservaId } });
      cache.delete(conversa.id);
      return false;
    }

    const escritor = await escritorDa(alvo, leitor, escritores);
    await escritor.enviarMensagem(conversa.id, textoDaNota(fechaEm, config.instrucao), {
      privado: true,
    });
    await db.webhookEvent.update({
      where: { id: reservaId },
      data: { resultado: "nota deixada", processedAt: agora },
    });
    rodada.avisadas++;
    return true;
  } catch (erro) {
    // Aviso que não saiu não conta como dado: a conferência seguinte tenta de
    // novo, enquanto a janela ainda não tiver fechado.
    await db.webhookEvent.delete({ where: { id: reservaId } }).catch(() => undefined);
    rodada.falhas++;
    logger.warn({ conversa: conversa.id, erro }, "janela: a nota não saiu");
    return false;
  }
}

async function trocarEtiqueta(
  alvo: Alvo,
  leitor: ChatwootClient,
  agora: Date,
  escritores: Map<string, EscritorDoChatwoot>,
  rodada: { fechadas: number; mudaramAoVivo: number; falhas: number },
): Promise<boolean> {
  const { conversa, ultima } = alvo;
  try {
    if (await mudouAoVivo(leitor, conversa.id, ultima)) {
      rodada.mudaramAoVivo++;
      cache.delete(conversa.id);
      return false;
    }

    // Ler e mesclar logo antes de gravar: o endpoint substitui a lista inteira.
    const escritor = await escritorDa(alvo, leitor, escritores);
    const atuais = await leitor.listarLabels(conversa.id);
    if (temEtiquetaDeFechada(atuais)) return false;
    await escritor.definirLabels(conversa.id, etiquetasDepoisDeFechar(atuais));
    rodada.fechadas++;
  } catch (erro) {
    rodada.falhas++;
    logger.warn({ conversa: conversa.id, erro }, "janela: não consegui trocar a etiqueta");
    return false;
  }

  // O rastro é do que JÁ aconteceu: falhar aqui não desfaz a etiqueta. Upsert
  // porque a mesma janela pode ser fechada de novo, se alguém devolver a
  // etiqueta de aberta à mão — e aí vale a hora da troca mais recente.
  const externalId = `fechada:${conversa.id}:${ultima?.id ?? "sem-mensagem-do-cliente"}`;
  try {
    await db.webhookEvent.upsert({
      where: { provider_externalId: { provider: PROVIDER_DA_JANELA, externalId } },
      update: { processedAt: agora },
      create: {
        provider: PROVIDER_DA_JANELA,
        externalId,
        eventType: `janela da conversa #${conversa.id} fechada`,
        resultado: "etiqueta trocada",
        detalhe: ultima ? null : "o cliente não escreveu nas mensagens lidas",
        processedAt: agora,
        payload: {
          conversationId: conversa.id,
          inboxId: alvo.caixa,
          ultimaMensagemDoCliente: ultima?.id ?? null,
          fechouEm: alvo.janela.estado === "fechada" ? alvo.janela.fechaEm : null,
        } as Prisma.InputJsonValue,
      },
    });
  } catch (erro) {
    logger.warn({ conversa: conversa.id, erro }, "janela: não consegui gravar o rastro");
  }
  return true;
}

async function registrarRodada(agora: Date, erro: string | null) {
  await db.integration.update({
    where: { provider: IntegrationProvider.JANELA },
    data: {
      lastCheckedAt: agora,
      status: erro ? IntegrationStatus.ERROR : IntegrationStatus.OK,
      lastError: erro,
    },
  });
}

function ehConflitoDeUnique(erro: unknown) {
  return (
    typeof erro === "object" &&
    erro !== null &&
    "code" in erro &&
    (erro as { code?: string }).code === "P2002"
  );
}

/** Só para teste: o ritmo e a memória da conferência vivem no processo. */
export function esquecerConferenciaDeJanelas() {
  ultimaConferencia = 0;
  conferindo = false;
  cache.clear();
}
