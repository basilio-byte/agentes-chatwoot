import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import { lerAtendimento } from "@/server/conversa-encerrada/leitura";
import { recortarAtendimentoAtual } from "@/server/conversa-marcada/recorte";
import { agendarConversaParada } from "@/server/queue/conversa-parada";
import {
  passaNoPreFiltro,
  ultimaMensagemPublica,
  vereditoDaConversa,
  type ConversaDaVarredura,
} from "./elegibilidade";

export const PROVIDER_DA_VARREDURA = "CONVERSA_PARADA";

/** Quantas conversas a listagem devolve por página. Não é configurável. */
export const POR_PAGINA = 25;

/**
 * Teto de páginas da listagem.
 *
 * Quarenta páginas são mil conversas abertas numa caixa — muito acima das 107
 * medidas em 17/09/2026. O teto existe para o caso patológico (filtro errado,
 * caixa que nunca resolve nada) não virar uma varredura infinita.
 */
export const PAGINAS_MAXIMAS = 40;

/** Quantas conversas são lidas ao mesmo tempo. Gentil com o Chatwoot. */
const LOTE = 5;

export type ResumoDaRodada = {
  listadas: number;
  candidatas: number;
  analisadas: number;
  semNovidade: number;
  recusadas: Record<string, number>;
  paginasLidas: number;
  cortadaPeloTeto: boolean;
  falhasDeLeitura: number;
};

/**
 * Varre as conversas abertas de uma caixa e enfileira as que estão paradas.
 *
 * Não chama modelo nenhum: tudo aqui é HTTP e decisão pura. É o que permite
 * olhar as 107 conversas em vez das 25 que cabiam no fluxo do n8n — e o que faz
 * o gasto com modelo ser proporcional ao que precisa de análise, não ao tamanho
 * da caixa.
 */
export async function varrerConversasParadas(args: {
  gatilho: {
    id: string;
    agentId: string;
    horasParadas: number;
    tetoPorRodada: number;
    contasDeAutomacao: string[];
  };
  cliente: ChatwootClient;
  /** As caixas do agente. Vazio = a conta inteira. */
  caixas: number[];
  agoraEmSegundos?: number;
}): Promise<ResumoDaRodada> {
  const agora = args.agoraEmSegundos ?? Math.floor(Date.now() / 1000);
  const resumo: ResumoDaRodada = {
    listadas: 0,
    candidatas: 0,
    analisadas: 0,
    semNovidade: 0,
    recusadas: {},
    paginasLidas: 0,
    cortadaPeloTeto: false,
    falhasDeLeitura: 0,
  };

  // Sem caixa configurada, o `inboxId` vai nulo e o Chatwoot devolve a conta
  // inteira — o escopo do agente é quem restringe, e ele pode ser "todas".
  const caixas: (number | null)[] = args.caixas.length > 0 ? args.caixas : [null];
  const candidatas: { conversa: ConversaDaVarredura; inboxId: number | null }[] = [];

  for (const caixa of caixas) {
    for (let pagina = 1; pagina <= PAGINAS_MAXIMAS; pagina++) {
      const { conversas } = await args.cliente.listarConversas({
        inboxId: caixa,
        tipoDeResponsavel: "assigned",
        status: "open",
        pagina,
      });
      resumo.paginasLidas++;
      resumo.listadas += conversas.length;

      for (const conversa of conversas) {
        if (passaNoPreFiltro(conversa, args.gatilho.horasParadas, agora)) {
          candidatas.push({ conversa, inboxId: conversa.inboxId ?? caixa });
        } else {
          conta(resumo, "ainda ativa");
        }
      }

      // ⚠ Página incompleta é o fim da lista. Não dá para parar pelo `total`:
      // ele conta o filtro inteiro, e uma conversa que muda de estado durante a
      // varredura mexe naquele número.
      if (conversas.length < POR_PAGINA) break;
      if (pagina === PAGINAS_MAXIMAS) resumo.cortadaPeloTeto = true;
    }
  }

  resumo.candidatas = candidatas.length;

  for (let i = 0; i < candidatas.length; i += LOTE) {
    await Promise.all(
      candidatas.slice(i, i + LOTE).map((c) => avaliar(c, args, agora, resumo)),
    );

    // O teto é de execuções PAGAS. Atingido, o que sobrou fica para a rodada
    // seguinte: continua parado, e a de amanhã encontra.
    if (resumo.analisadas >= args.gatilho.tetoPorRodada) break;
  }

  return resumo;
}

async function avaliar(
  candidata: { conversa: ConversaDaVarredura; inboxId: number | null },
  args: Parameters<typeof varrerConversasParadas>[0],
  agora: number,
  resumo: ResumoDaRodada,
) {
  const { conversa, inboxId } = candidata;

  let atendimento: Awaited<ReturnType<typeof lerAtendimento>>;
  try {
    atendimento = await lerAtendimento(args.cliente, conversa.id, (mensagens) =>
      recortarAtendimentoAtual(mensagens, agora),
    );
  } catch (erro) {
    // Uma conversa ilegível não pode derrubar a rodada. Fica para amanhã, e o
    // resumo diz quantas foram.
    resumo.falhasDeLeitura++;
    logger.warn({ conversa: conversa.id, erro }, "não consegui ler a conversa na varredura");
    return;
  }

  const veredito = vereditoDaConversa({
    conversa,
    mensagens: atendimento.mensagens,
    horasParadas: args.gatilho.horasParadas,
    agoraEmSegundos: agora,
    contasDeAutomacao: args.gatilho.contasDeAutomacao,
  });

  if (!veredito.entra) {
    conta(resumo, veredito.motivo);
    return;
  }

  const ultima = ultimaMensagemPublica(atendimento.mensagens);
  if (!ultima || typeof ultima.created_at !== "number") return;

  // ⚠ A chave é o id da última mensagem PÚBLICA, e é ela que faz "só comenta de
  // novo quando houver mensagem nova" (decisão do usuário, 17/09/2026). Pelo
  // instante da rodada, a mesma conversa parada ganharia uma nota por dia até
  // alguém responder — o ruído que faz o vendedor parar de ler as notas.
  let webhookEventId: string;
  try {
    const entrega = await db.webhookEvent.create({
      data: {
        provider: PROVIDER_DA_VARREDURA,
        externalId: `${args.gatilho.agentId}:${conversa.id}:${ultima.id}`,
        eventType: `conversa #${conversa.id} parada`,
        agentId: args.gatilho.agentId,
        resultado: "agendado",
        // Sem nome nem telefone: Entregas é lido pela equipe inteira.
        payload: {
          conversationId: conversa.id,
          inboxId,
          ultimaMensagemId: ultima.id,
        } as Prisma.InputJsonValue,
      },
    });
    webhookEventId = entrega.id;
  } catch (erro) {
    if (ehConflitoDeUnique(erro)) {
      // Já analisada, e nada mudou desde então.
      resumo.semNovidade++;
      return;
    }
    throw erro;
  }

  await agendarConversaParada({
    gatilhoId: args.gatilho.id,
    agentId: args.gatilho.agentId,
    webhookEventId,
    chatwootConversationId: conversa.id,
    inboxId,
    contatoNome: conversa.contatoNome ?? null,
    telefone: conversa.telefone ?? null,
    dono: conversa.assigneeNome ?? null,
    ultimaMensagemEm: ultima.created_at,
    ultimoFalante: ultima.message_type === 0 ? "cliente" : "equipe",
  });

  resumo.analisadas++;
}

function conta(resumo: ResumoDaRodada, motivo: string) {
  // O motivo do tempo traz as horas ("parada há 3.2h..."), o que viraria uma
  // chave por conversa. Aqui interessa o grupo.
  const chave = motivo.startsWith("parada há") ? "ainda ativa" : motivo;
  resumo.recusadas[chave] = (resumo.recusadas[chave] ?? 0) + 1;
}

function ehConflitoDeUnique(erro: unknown) {
  return (
    typeof erro === "object" &&
    erro !== null &&
    "code" in erro &&
    (erro as { code?: string }).code === "P2002"
  );
}

/**
 * O resumo da rodada em uma linha — o que a tela do gatilho mostra.
 *
 * Quem abre a tela pergunta "rodou, e o que aconteceu com as conversas todas?".
 * O desfecho da última conversa a terminar não responde isso, e era o que a
 * linha mostraria se este gatilho reusasse o padrão dos outros dois.
 */
export function resumirRodada(r: ResumoDaRodada): string {
  const partes = [
    `${r.listadas} conversa(s) abertas`,
    `${r.candidatas} candidata(s)`,
    `${r.analisadas} analisada(s)`,
  ];
  if (r.semNovidade > 0) partes.push(`${r.semNovidade} sem mensagem nova`);
  if (r.falhasDeLeitura > 0) partes.push(`${r.falhasDeLeitura} não deu para ler`);
  if (r.cortadaPeloTeto) {
    partes.push(`⚠ a listagem bateu o teto de ${PAGINAS_MAXIMAS} páginas`);
  }

  const motivos = Object.entries(r.recusadas)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([motivo, n]) => `${n} ${motivo}`);
  if (motivos.length > 0) partes.push(`fora: ${motivos.join(", ")}`);

  return partes.join(" · ");
}
