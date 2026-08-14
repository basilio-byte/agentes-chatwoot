import { logger } from "@/lib/logger";
import { MediaKind } from "@/generated/prisma/enums";
import type { MensagemChatwoot } from "@/server/integrations/chatwoot/client";
import { classificarAnexos, type Anexo } from "./classificar";
import { avisoDeLeituraDesligada, juntarComAnexos } from "./formato";
import { analisarAnexo, type ContextoDaAnalise } from "./analise";

/**
 * Troca os anexos das mensagens do Chatwoot pelo texto que o modelo consegue
 * ler.
 *
 * É um passo de PREPARO do contexto, não uma tool: o agente não escolhe se vai
 * ouvir o áudio do cliente. Sistema garante, prompt decora — se dependesse do
 * modelo pedir, um turno em que ele esquecesse deixaria a pessoa sem resposta
 * sobre o que ela acabou de mandar.
 */

/**
 * Quantas mensagens do fim da lista podem ter anexo lido.
 *
 * Só interessa o que vai chegar ao modelo: `montarContexto` manda os últimos
 * `LIMITE_HISTORICO` turnos mais o bloco de mensagens novas do cliente. Ler
 * anexo de mensagem que vai ser descartada é dinheiro jogado fora.
 */
export const JANELA_DE_ANEXOS = 40;

export type ResumoDaLeitura = {
  /** Anexos que viraram texto neste turno (inclusive vindos do cache). */
  lidos: number;
  /** Anexos que precisaram de chamada paga agora. */
  processados: number;
  falhas: number;
  /** Ficaram de fora pelo teto por turno. O próximo turno pega. */
  adiados: number;
};

/**
 * Preenche o `content` das mensagens que têm anexo.
 *
 * Não altera mensagem sem anexo, e nunca lança: qualquer falha aqui vira texto
 * dentro da própria mensagem. O turno tem de continuar — o cliente está
 * esperando.
 */
export async function enriquecerComMidia(
  mensagens: MensagemChatwoot[],
  ctx: ContextoDaAnalise,
): Promise<{ mensagens: MensagemChatwoot[]; resumo: ResumoDaLeitura }> {
  const resumo: ResumoDaLeitura = {
    lidos: 0,
    processados: 0,
    falhas: 0,
    adiados: 0,
  };

  const inicioDaJanela = Math.max(0, mensagens.length - JANELA_DE_ANEXOS);
  const pendentes = new Map<string, Anexo>();

  // Primeiro passo: descobrir o que há para ler, sem repetir arquivo. O mesmo
  // anexo pode aparecer duas vezes (reencaminhado), e processar em paralelo
  // duas vezes a mesma chave brigaria no upsert.
  const porMensagem = mensagens.map((mensagem, indice) => {
    if (indice < inicioDaJanela) return [];
    // Só anexo de ENTRADA. O que sai da conversa é a equipe mandando arquivo, e
    // descrever o PDF que nós mesmos enviamos seria pagar para ler o que já
    // sabemos. Continua fora do contexto como sempre esteve.
    if (mensagem.message_type !== 0) return [];
    const anexos = classificarAnexos(mensagem.attachments);
    for (const anexo of anexos) {
      if (!pendentes.has(anexo.chave)) pendentes.set(anexo.chave, anexo);
    }
    return anexos;
  });

  if (pendentes.size === 0) return { mensagens, resumo };

  // Teto por turno: o que passar dele entra como "não lido" e a próxima
  // mensagem do cliente processa o restante — o que já foi lido volta do cache
  // e não ocupa vaga.
  const fila = [...pendentes.values()];
  const dentroDoTeto = fila.slice(0, ctx.config.maxAnexosPorTurno);
  const adiados = new Set(
    fila.slice(ctx.config.maxAnexosPorTurno).map((a) => a.chave),
  );
  resumo.adiados = adiados.size;

  const analisados = new Map<string, { texto: string | null; falha: string | null }>();

  const resultados = await Promise.all(
    dentroDoTeto.map(async (anexo) => {
      try {
        return { anexo, analise: await analisarAnexo(anexo, ctx) };
      } catch (erro) {
        // `analisarAnexo` já engole tudo; este catch é a garantia de que um
        // caminho novo lá dentro nunca derrube o turno inteiro.
        logger.error({ chave: anexo.chave, erro }, "leitura de anexo explodiu");
        return { anexo, analise: null };
      }
    }),
  );

  for (const { anexo, analise } of resultados) {
    if (!analise) {
      resumo.falhas++;
      analisados.set(anexo.chave, {
        texto: null,
        falha: "não consegui ler este anexo.",
      });
      continue;
    }

    if (!analise.doCache && anexo.kind !== MediaKind.UNSUPPORTED) {
      resumo.processados++;
    }
    if (analise.erro) resumo.falhas++;
    if (analise.texto) resumo.lidos++;

    analisados.set(anexo.chave, {
      texto: analise.texto,
      falha: analise.texto ? null : (analise.erro ?? "não consegui ler este anexo."),
    });
  }

  const enriquecidas = mensagens.map((mensagem, indice) => {
    const anexos = porMensagem[indice];
    if (!anexos || anexos.length === 0) return mensagem;

    const lidos = anexos.map((anexo) => {
      if (adiados.has(anexo.chave)) {
        return {
          kind: anexo.kind,
          nome: anexo.nome,
          falha:
            "anexo ainda não lido — muitos arquivos de uma vez; peça um por vez ou aguarde.",
        };
      }

      const analise = analisados.get(anexo.chave);
      return {
        kind: anexo.kind,
        nome: anexo.nome,
        texto: analise?.texto ?? null,
        falha: analise?.falha ?? null,
      };
    });

    return { ...mensagem, content: juntarComAnexos(mensagem.content, lidos) };
  });

  return { mensagens: enriquecidas, resumo };
}

/**
 * O que fazer com os anexos quando a leitura de mídia está desligada.
 *
 * A mensagem NÃO pode continuar vazia: o agente responderia "não entendi" sem
 * jamais dizer que chegou um áudio, e o cliente repetiria o mesmo áudio para
 * sempre. Este caminho não chama a OpenAI e não custa nada.
 */
export function marcarAnexosSemLeitura(
  mensagens: MensagemChatwoot[],
): MensagemChatwoot[] {
  return mensagens.map((mensagem) => {
    if (mensagem.message_type !== 0) return mensagem;
    const anexos = classificarAnexos(mensagem.attachments);
    if (anexos.length === 0) return mensagem;

    const texto = (mensagem.content ?? "").trim();
    const aviso = avisoDeLeituraDesligada(anexos.length);

    return { ...mensagem, content: texto ? `${texto}\n${aviso}` : aviso };
  });
}

/** A mensagem tem anexo? Usado pelo webhook, antes de qualquer leitura. */
export function temAnexo(brutos: unknown): boolean {
  return classificarAnexos(brutos as never).length > 0;
}
