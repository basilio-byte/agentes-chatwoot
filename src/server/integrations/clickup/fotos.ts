import { createHash } from "node:crypto";
import { EXTENSOES_DE_IMAGEM } from "@/server/integrations/openai/classificar";
import type { ClickUpAnexo, ClickUpComentario } from "./tipos";

/**
 * As decisões de `clickup_ler_fotos_da_tarefa`, puras e testadas.
 *
 * Nasceu do agente de jardim (01/10/2026): a equipe fotografa as áreas
 * externas toda semana e publica as fotos como COMENTÁRIOS de uma tarefa do
 * ClickUp, com uma anotação curta ("poldar", "mato da calçada"). O agente
 * precisa ver essas fotos — e o modelo que pensa só lê texto. Quem enxerga é a
 * leitura de mídia da OpenAI, a mesma do atendimento, com a instrução montada
 * aqui a partir do critério que o agente escreve.
 */

/**
 * Teto de fotos lidas numa chamada.
 *
 * Cada foto é uma leitura paga, e a descrição de cada uma volta inteira para o
 * contexto do agente. Vinte cobre o lote semanal que existe hoje (5 a 16 fotos)
 * com folga; acima disso, ficam as MAIS RECENTES, porque o estado de agora é o
 * que se avalia, e o retorno diz quantas ficaram de fora.
 */
export const MAX_FOTOS_POR_LEITURA = 20;

/** A janela padrão é a semana: a rotina do jardim é semanal. */
export const DIAS_PADRAO = 7;

/**
 * Quanto depois do upload o comentário que publica a foto pode chegar.
 *
 * Medido na tarefa real: o arquivo sobe 1 a 45 s antes do comentário. Quinze
 * minutos cobrem quem anexa várias e escreve a anotação com calma, sem ligar a
 * foto de uma semana à anotação de outra.
 */
export const JANELA_DA_ANOTACAO_MS = 15 * 60_000;

/** O que sobra da descrição de cada foto para o agente ler. */
export const TETO_DA_DESCRICAO = 1_500;

const DIA_MS = 86_400_000;

/** Milissegundos de um campo de data do ClickUp, ou `null` se não for data. */
export function instante(valor: string | number | null | undefined): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const ms = Number(valor);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** A extensão do anexo — pelo campo da API, e pelo nome quando ele falta. */
export function extensaoDoAnexo(anexo: ClickUpAnexo): string {
  const declarada = anexo.extension?.trim().toLowerCase().replace(/^\./, "");
  if (declarada) return declarada;
  const titulo = anexo.title ?? "";
  const ponto = titulo.lastIndexOf(".");
  return ponto > 0 ? titulo.slice(ponto + 1).toLowerCase() : "";
}

/**
 * O nome com que o arquivo vai para a leitura de mídia.
 *
 * ⚠ É do nome que a leitura tira a extensão — e com ela, o tipo. Título sem
 * extensão faria uma foto boa ser recusada como "arquivo sem extensão".
 */
export function nomeDoAnexo(anexo: ClickUpAnexo): string {
  const titulo = anexo.title?.trim() || "foto";
  const extensao = extensaoDoAnexo(anexo);
  if (!extensao || titulo.toLowerCase().endsWith(`.${extensao}`)) return titulo;
  return `${titulo}.${extensao}`;
}

export type SelecaoDeFotos = {
  /** Da mais antiga para a mais nova — a ordem em que as coisas aconteceram. */
  fotos: ClickUpAnexo[];
  /** Fotos do período que passaram do teto e NÃO serão lidas. */
  foraDoTeto: number;
  /** O mesmo arquivo publicado duas vezes: lido uma só. */
  repetidas: number;
  /** Anexos do período que não são imagem legível (PDF, vídeo, HEIC…). */
  semSerFoto: number;
};

/**
 * As fotos que entram na leitura: do período, vivas, legíveis, sem repetição.
 *
 * ⚠ Repetição é por nome E tamanho, não pelo id: na tarefa real a mesma foto do
 * WhatsApp aparece duas vezes com ids diferentes (publicada em dois
 * comentários). Lida duas vezes, seria paga duas vezes e contada como dois
 * problemas. Só o nome não serve: o print colado no ClickUp sempre se chama
 * `image.png`.
 */
export function selecionarFotos(
  anexos: ClickUpAnexo[],
  desdeMs: number,
  teto = MAX_FOTOS_POR_LEITURA,
): SelecaoDeFotos {
  const doPeriodo = anexos.filter((a) => {
    if (a.deleted || a.hidden || !a.url) return false;
    const quando = instante(a.date);
    // Estritamente depois: a foto que chegou no instante exato da leitura
    // anterior já foi lida por ela.
    return quando !== null && quando > desdeMs;
  });

  const imagens = doPeriodo.filter(ehFoto);

  const vistas = new Set<string>();
  const unicas: ClickUpAnexo[] = [];
  for (const anexo of [...imagens].sort(porData)) {
    const assinatura = `${anexo.title ?? ""}|${anexo.size ?? ""}`;
    if (vistas.has(assinatura)) continue;
    vistas.add(assinatura);
    unicas.push(anexo);
  }

  const escolhidas = unicas.slice(Math.max(0, unicas.length - teto));

  return {
    fotos: escolhidas,
    foraDoTeto: unicas.length - escolhidas.length,
    repetidas: imagens.length - unicas.length,
    semSerFoto: doPeriodo.length - imagens.length,
  };
}

/** Imagem viva, com endereço, num formato que a visão lê. */
function ehFoto(a: ClickUpAnexo): boolean {
  return (
    !a.deleted &&
    !a.hidden &&
    Boolean(a.url) &&
    EXTENSOES_DE_IMAGEM.includes(extensaoDoAnexo(a))
  );
}

/**
 * Quando a foto mais recente da tarefa chegou, olhando a tarefa INTEIRA — não
 * só a janela. É o que permite dizer "nenhuma foto há 9 dias" num dia em que a
 * janela veio vazia.
 */
export function fotoMaisRecente(anexos: ClickUpAnexo[]): number | null {
  let maior: number | null = null;
  for (const a of anexos) {
    const quando = instante(a.date);
    if (quando !== null && ehFoto(a) && (maior === null || quando > maior)) maior = quando;
  }
  return maior;
}

/**
 * Até quando este agente já leu DESTA tarefa, pelas chamadas gravadas — ou
 * `null`.
 *
 * ⚠ Vale o instante em que a lista de anexos foi LIDA (`lidoAteMs`), não o da
 * gravação da chamada: entre um e outro passam os ~20 s da leitura das fotos,
 * e a foto que chegasse nesse meio ficaria fora das duas janelas, para sempre.
 * Chamada sem o campo conta pela gravação.
 *
 * Só conta a leitura que leu de verdade (`lido: true`): a que parou por leitura
 * de mídia desligada, ou em que todas as fotos falharam, não pode empurrar a
 * janela para frente, senão as fotos dela nunca seriam avaliadas.
 */
export function ultimaLeituraDaTarefa(
  chamadas: { input: unknown; output: unknown; createdAt: Date }[],
  tarefaId: string,
): Date | null {
  let ultima: Date | null = null;
  for (const c of chamadas) {
    const entrada = c.input as Record<string, unknown> | null;
    const saida = c.output as Record<string, unknown> | null;
    if (entrada?.tarefaId !== tarefaId || saida?.lido !== true) continue;
    const ate = typeof saida.lidoAteMs === "number" ? new Date(saida.lidoAteMs) : c.createdAt;
    if (!ultima || ate > ultima) ultima = ate;
  }
  return ultima;
}

/**
 * Onde a janela começa: na última leitura concluída, sem passar de `dias` para
 * trás — que é também a janela da primeira leitura de todas.
 *
 * ⚠ É isto que deixa o agente rodar todo dia sem buraco nem repetição. Janela
 * fixa de 24 h perderia as fotos de um dia em que a rodada falhou, e uma janela
 * maior avaliaria a mesma foto em dias seguidos — um comentário e um WhatsApp
 * repetidos por dia.
 */
export function inicioDaJanela(args: {
  agoraMs: number;
  dias: number;
  ultimaLeitura: Date | null;
}): number {
  const limite = args.agoraMs - args.dias * DIA_MS;
  const ultima = args.ultimaLeitura?.getTime() ?? null;
  return ultima !== null && ultima > limite ? ultima : limite;
}

function porData(a: ClickUpAnexo, b: ClickUpAnexo): number {
  return (instante(a.date) ?? 0) - (instante(b.date) ?? 0);
}

/**
 * Uma linha de `comment_text` como o nome que a pessoa vê.
 *
 * O ClickUp às vezes grava o nome do arquivo codificado
 * (`WhatsApp%20Image%20…jpeg`) e às vezes não — na mesma tarefa.
 */
function linhaLegivel(linha: string): string {
  const limpa = linha.trim();
  try {
    return decodeURIComponent(limpa);
  } catch {
    return limpa;
  }
}

const PARECE_ARQUIVO = /^[^\n]{1,200}\.(jpe?g|png|webp|gif|heic|heif|pdf|mp4|mov|docx?|xlsx?)$/i;

export type Anotacao = { texto: string | null; autor: string | null };

/**
 * A anotação escrita junto da foto, e quem a publicou.
 *
 * ⚠ O anexo não diz de qual comentário veio. O que liga os dois é o
 * `comment_text`, que repete o nome de cada arquivo publicado nele. Casa o
 * comentário que cita o nome e chegou logo depois do upload (até
 * `JANELA_DA_ANOTACAO_MS`); o mais próximo vence, para `image.png` — o nome de
 * todo print — não pegar a anotação de outro.
 *
 * Do texto saem as linhas que são nome de arquivo: o que sobra é o que a
 * pessoa escreveu. Sem nada escrito, `texto` é nulo.
 */
export function anotacaoDaFoto(
  anexo: ClickUpAnexo,
  comentarios: ClickUpComentario[],
): Anotacao {
  const quando = instante(anexo.date);
  const titulo = anexo.title?.trim();
  const autorDoAnexo = anexo.user?.username ?? anexo.user?.email ?? null;

  if (quando === null || !titulo) return { texto: null, autor: autorDoAnexo };

  const candidatos = comentarios
    .map((c) => ({ comentario: c, quando: instante(c.date) }))
    .filter(
      (c): c is { comentario: ClickUpComentario; quando: number } =>
        c.quando !== null &&
        // Um minuto de folga para trás: relógio de servidor não é exato.
        c.quando >= quando - 60_000 &&
        c.quando - quando <= JANELA_DA_ANOTACAO_MS &&
        (c.comentario.comment_text ?? "")
          .split("\n")
          .some((linha) => linhaLegivel(linha) === titulo),
    )
    .sort((a, b) => a.quando - b.quando);

  const escolhido = candidatos[0]?.comentario;
  if (!escolhido) return { texto: null, autor: autorDoAnexo };

  const escrito = (escolhido.comment_text ?? "")
    .split("\n")
    .map(linhaLegivel)
    .filter((linha) => linha && !PARECE_ARQUIVO.test(linha))
    .join("\n")
    .trim();

  return {
    texto: escrito || null,
    autor: escolhido.user?.username ?? escolhido.user?.email ?? autorDoAnexo,
  };
}

/**
 * Só se baixa anexo de servidor do próprio ClickUp.
 *
 * O `url` vem da resposta da API, mas é um endereço qualquer até prova em
 * contrário — e o token do ClickUp só pode ir para o ClickUp (mesma doutrina do
 * token do Chatwoot na leitura de mídia).
 */
export function hostDeAnexoPermitido(url: string): boolean {
  let endereco: URL;
  try {
    endereco = new URL(url);
  } catch {
    return false;
  }
  if (endereco.protocol !== "https:") return false;
  const host = endereco.hostname.toLowerCase();
  return host === "attachments.clickup.com" || host.endsWith(".clickup-attachments.com");
}

/**
 * A instrução que vai para a visão, com o critério de quem chamou.
 *
 * ⚠ NÃO é a instrução global de imagem da leitura de mídia, e não pode ser: lá
 * o texto manda transcrever comprovante e documento, porque é o que o cliente
 * manda no WhatsApp. Trocar a global para servir a vistoria mudaria a leitura
 * de todo atendimento. O enquadramento aqui é fixo; o critério é do agente.
 */
export function instrucaoDaFoto(foco: string): string {
  return [
    "Você está olhando UMA foto de vistoria, tirada por alguém da equipe.",
    "Descreva só o que dá para ver nela, em português, em no máximo 8 linhas curtas.",
    "Na primeira linha, diga onde parece ser e o que aparece.",
    "Depois, para cada item do critério abaixo que a foto permite avaliar, diga o que se vê.",
    "Item que a foto não mostra fica de fora. Se algo estiver longe, escuro ou cortado,",
    "diga que não dá para ver em vez de adivinhar. Não invente problema nem elogio.",
    "",
    "Critério:",
    foco.trim(),
  ].join("\n");
}

/**
 * Chave de cache da leitura: o ARQUIVO e o CRITÉRIO.
 *
 * O arquivo sozinho devolveria a descrição feita com o critério antigo depois
 * de alguém mudar o prompt — a avaliação nova sairia velha, sem erro nenhum. Com
 * o critério na chave, mudar o critério relê (e paga) uma vez; repetir a mesma
 * leitura na mesma semana não paga de novo.
 */
export function chaveDaLeitura(anexoId: string, instrucao: string): string {
  const resumo = createHash("sha256").update(instrucao).digest("hex").slice(0, 16);
  return `clickup:${anexoId}:${resumo}`;
}

/** Corta a descrição longa, dizendo que cortou. */
export function cortarDescricao(texto: string, teto = TETO_DA_DESCRICAO): string {
  const limpo = texto.trim();
  if (limpo.length <= teto) return limpo;
  return `${limpo.slice(0, teto).trimEnd()} … [descrição cortada]`;
}
