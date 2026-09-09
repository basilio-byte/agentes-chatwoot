import { getRedis } from "@/server/queue/conexao";
import { logger } from "@/lib/logger";

/**
 * O freio de gasto da mesa.
 *
 * ⚠ **Não existia rate limit em lugar nenhum deste projeto** antes disto, e a
 * ausência fazia sentido: toda outra porta é acionada por um sistema (Chatwoot,
 * ClickUp, relógio), e o gatilho HTTP já tem a sua trava anti-laço. A mesa é
 * outra coisa — é a porta mais barata de todas: arrastar um arquivo e clicar.
 * Um envio custa uma chamada paga à OpenAI por arquivo MAIS até doze idas ao
 * modelo na OpenRouter (`maxToolIterations`, padrão 12). Sem freio, uma tarde
 * distraída com o dedo no botão é uma fatura.
 *
 * Mesma mecânica do anti-laço do gatilho (`INCR` + `EXPIRE`, janela fixa), por
 * dois motivos: é a que o projeto já usa, e janela fixa se explica em uma frase
 * para quem lê a mensagem de recusa ("tente de novo em X minutos").
 *
 * ⚠ **Duas diferenças deliberadas em relação ao anti-laço do gatilho:**
 *
 * 1. **Falha FECHADO.** Redis fora do ar aqui recusa; lá, a trava de
 *    sobreposição do agendamento libera. Não é incoerência: lá o pior caso de
 *    barrar é um agendamento que não roda — perda de trabalho por um soluço de
 *    infraestrutura. Aqui o pior caso de liberar é gasto sem teto, e o pior caso
 *    de barrar é uma pessoa esperando o Redis voltar para conferir um documento.
 *    Dinheiro não volta; o documento espera.
 * 2. **Não desliga nada sozinho.** O gatilho estourado se auto-desliga porque do
 *    outro lado há um sistema que vai continuar chamando para sempre. Aqui do
 *    outro lado há uma pessoa lendo a tela: ela entende "espere sete minutos".
 *    Desligar a mesa por excesso puniria a próxima pessoa por causa da anterior.
 */

/**
 * Tetos por hora. Números escolhidos pelo usuário em 09/09/2026, com a
 * referência do anti-laço do gatilho (40 execuções em 10 minutos) na mesa.
 *
 * Apertado o bastante para um acidente não virar fatura, largo o bastante para
 * uma tarde inteira de conferências. São constantes exportadas de propósito:
 * mudar é uma linha, e o teste trava a relação entre elas.
 */
export const TETOS = {
  /** Executar o agente: o caro. Uma execução encadeia até 12 idas ao modelo. */
  execucao: { porPessoa: 20, global: 60 },
  /**
   * Ler um arquivo: mais barato, e é pré-requisito de executar — a mesma pessoa
   * relê quando a foto sai tremida. Por isso o teto é o triplo; segurá-lo no
   * mesmo número do de execução transformaria "tirei a foto de novo" em recusa.
   */
  leitura: { porPessoa: 60, global: 180 },
} as const;

export const JANELA_S = 60 * 60;

export type AcaoDaMesa = keyof typeof TETOS;

export type VereditoDoFreio =
  | { pode: true }
  | {
      pode: false;
      motivo: "teto_da_pessoa" | "teto_global" | "sem_redis";
      esperaSegundos: number;
    };

const CHAVE_PESSOA = (acao: AcaoDaMesa, userId: string) =>
  `mesa:freio:${acao}:pessoa:${userId}`;

const CHAVE_GLOBAL = (acao: AcaoDaMesa) => `mesa:freio:${acao}:global`;

/**
 * Consome uma unidade dos dois tetos e diz se pode seguir.
 *
 * ⚠ Consome ANTES de gastar, e não depois: contar só o que deu certo deixaria a
 * falha cara (o turno que roda doze iterações e morre no fim) de fora da conta
 * justamente por ter falhado.
 *
 * ⚠ O teto da PESSOA é conferido primeiro. Quando os dois estouram junto, quem
 * está exagerando precisa ler "você já fez 20 envios nesta hora", não "o sistema
 * está ocupado" — a segunda frase manda a pessoa errada esperar e some com a
 * informação de que o limite é dela.
 */
export async function consumirFreio(
  acao: AcaoDaMesa,
  userId: string,
): Promise<VereditoDoFreio> {
  const teto = TETOS[acao];

  try {
    const redis = getRedis();

    const daPessoa = await contar(redis, CHAVE_PESSOA(acao, userId));
    if (daPessoa.usos > teto.porPessoa) {
      return {
        pode: false,
        motivo: "teto_da_pessoa",
        esperaSegundos: daPessoa.esperaSegundos,
      };
    }

    const doSistema = await contar(redis, CHAVE_GLOBAL(acao));
    if (doSistema.usos > teto.global) {
      return {
        pode: false,
        motivo: "teto_global",
        esperaSegundos: doSistema.esperaSegundos,
      };
    }

    return { pode: true };
  } catch (erro) {
    // Falha fechado — ver o ⚠ no topo. Deixa rastro, senão a mesa recusar por
    // Redis fora do ar seria indistinguível de a mesa estar quebrada.
    logger.error({ erro, acao, userId }, "freio da mesa não conseguiu contar — recusando");
    return { pode: false, motivo: "sem_redis", esperaSegundos: 60 };
  }
}

async function contar(redis: ReturnType<typeof getRedis>, chave: string) {
  const usos = await redis.incr(chave);

  // Só o primeiro uso define a validade: renovar a cada chamada faria a janela
  // nunca fechar para quem continua tentando — o limite viraria permanente
  // para justamente quem já foi barrado.
  if (usos === 1) await redis.expire(chave, JANELA_S);

  const ttl = await redis.ttl(chave);

  return {
    usos,
    // TTL negativo é chave sem validade (-1) ou que sumiu entre o INCR e o TTL
    // (-2). Nos dois casos a janela inteira é a resposta honesta.
    esperaSegundos: ttl > 0 ? ttl : JANELA_S,
  };
}

/**
 * A frase que a pessoa lê. Fica aqui, e não na rota, porque é ela que conhece
 * os números — e porque as duas rotas precisam da mesma redação.
 */
export function motivoEmPortugues(
  veredito: Extract<VereditoDoFreio, { pode: false }>,
  acao: AcaoDaMesa,
): string {
  const espera = emMinutos(veredito.esperaSegundos);
  const oQue = acao === "execucao" ? "execuções" : "leituras de arquivo";

  switch (veredito.motivo) {
    case "teto_da_pessoa":
      return `Você atingiu o limite de ${TETOS[acao].porPessoa} ${oQue} por hora. Tente de novo ${espera}.`;
    case "teto_global":
      return `O limite de ${oQue} por hora do sistema inteiro foi atingido — alguém mais pode estar usando a mesa agora. Tente de novo ${espera}.`;
    case "sem_redis":
      return "Não consegui conferir o limite de uso agora, então não vou executar — isto gasta crédito e prefiro errar para o lado seguro. Tente de novo em um minuto; se continuar, avise quem cuida do sistema.";
  }
}

function emMinutos(segundos: number): string {
  if (segundos <= 90) return "em instantes";
  return `em ${Math.ceil(segundos / 60)} minutos`;
}
