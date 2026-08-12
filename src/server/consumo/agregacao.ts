import { diaEmSaoPaulo } from "@/lib/tempo";

/**
 * Agregação da apuração de consumo — **pura**, sem Prisma.
 *
 * A conta fica aqui, e não em SQL, por dois motivos. Primeiro, é a parte que
 * precisa estar certa: dinheiro. Função pura tem teste de mesa, `GROUP BY`
 * espalhado por cinco queries não tem. Segundo, uma varredura só do período
 * alimenta todas as quebras ao mesmo tempo — por modelo, por agente, por
 * fonte, por dia — sem cinco idas ao banco que podem discordar entre si.
 *
 * O custo é carregar as linhas do período na memória. Ver o teto em
 * `consulta.ts`: acima dele a tela pede um período menor em vez de mentir.
 */

export type LinhaDeConsumo = {
  createdAt: Date;
  /** Nulo nas execuções anteriores ao registro do modelo. Ver AgentRun.model. */
  model: string | null;
  agentId: string;
  source: string;
  status: string;
  /** Já convertido de Decimal para número por quem lê do banco. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number | null;
  conversationId: string | null;
};

export type Totais = {
  custoUsd: number;
  execucoes: number;
  erros: number;
  tokensEntrada: number;
  tokensSaida: number;
  tokensCache: number;
  tokens: number;
  /** Conversas distintas tocadas no período. Execução sem conversa não conta. */
  conversas: number;
  /** Média só das execuções que registraram latência. */
  latenciaMediaMs: number | null;
  custoMedioPorExecucao: number;
  custoPorConversa: number | null;
};

export type Fatia = {
  chave: string;
  custoUsd: number;
  execucoes: number;
  erros: number;
  tokens: number;
  tokensEntrada: number;
  tokensSaida: number;
  tokensCache: number;
  /** Fração do custo total do período — 0 a 1. */
  parcela: number;
  custoMedioPorExecucao: number;
};

export type PontoDoDia = {
  dia: string;
  custoUsd: number;
  execucoes: number;
  tokens: number;
};

export type Apuracao = {
  totais: Totais;
  porModelo: Fatia[];
  porAgente: Fatia[];
  porFonte: Fatia[];
  porDia: PontoDoDia[];
};

/** Chave usada quando a execução é anterior ao registro do modelo. */
export const SEM_MODELO = "__sem-modelo__";

function zerada(chave: string): Fatia {
  return {
    chave,
    custoUsd: 0,
    execucoes: 0,
    erros: 0,
    tokens: 0,
    tokensEntrada: 0,
    tokensSaida: 0,
    tokensCache: 0,
    parcela: 0,
    custoMedioPorExecucao: 0,
  };
}

function acumular(fatia: Fatia, linha: LinhaDeConsumo) {
  fatia.custoUsd += linha.costUsd;
  fatia.execucoes += 1;
  if (linha.status === "ERROR") fatia.erros += 1;
  fatia.tokensEntrada += linha.inputTokens;
  fatia.tokensSaida += linha.outputTokens;
  fatia.tokensCache += linha.cacheReadTokens;
  fatia.tokens += linha.inputTokens + linha.outputTokens;
}

/**
 * Ordena por custo, do maior para o menor — a pergunta da tela é "onde está o
 * dinheiro". Empate (típico de modelo grátis) desempata pelo número de
 * execuções e depois pela chave, para a ordem não dançar entre recargas.
 */
function fechar(mapa: Map<string, Fatia>, custoTotal: number): Fatia[] {
  return [...mapa.values()]
    .map((f) => ({
      ...f,
      parcela: custoTotal > 0 ? f.custoUsd / custoTotal : 0,
      custoMedioPorExecucao: f.execucoes > 0 ? f.custoUsd / f.execucoes : 0,
    }))
    .sort(
      (a, b) =>
        b.custoUsd - a.custoUsd ||
        b.execucoes - a.execucoes ||
        a.chave.localeCompare(b.chave),
    );
}

export function agregar(
  linhas: LinhaDeConsumo[],
  /** Dias que o gráfico precisa mostrar, inclusive os sem gasto nenhum. */
  dias: string[] = [],
): Apuracao {
  const porModelo = new Map<string, Fatia>();
  const porAgente = new Map<string, Fatia>();
  const porFonte = new Map<string, Fatia>();
  const porDia = new Map<string, PontoDoDia>();

  // Dia sem execução tem de aparecer como zero, e não sumir: um buraco no meio
  // da série leria como "não houve dado", e o que houve foi gasto nenhum.
  for (const dia of dias) {
    porDia.set(dia, { dia, custoUsd: 0, execucoes: 0, tokens: 0 });
  }

  const conversas = new Set<string>();
  let custoTotal = 0;
  let erros = 0;
  let tokensEntrada = 0;
  let tokensSaida = 0;
  let tokensCache = 0;
  let latenciaSoma = 0;
  let latenciaContagem = 0;

  for (const linha of linhas) {
    custoTotal += linha.costUsd;
    if (linha.status === "ERROR") erros += 1;
    tokensEntrada += linha.inputTokens;
    tokensSaida += linha.outputTokens;
    tokensCache += linha.cacheReadTokens;
    if (linha.conversationId) conversas.add(linha.conversationId);
    if (linha.latencyMs != null) {
      latenciaSoma += linha.latencyMs;
      latenciaContagem += 1;
    }

    for (const [mapa, chave] of [
      [porModelo, linha.model ?? SEM_MODELO],
      [porAgente, linha.agentId],
      [porFonte, linha.source],
    ] as const) {
      const atual = mapa.get(chave) ?? zerada(chave);
      acumular(atual, linha);
      mapa.set(chave, atual);
    }

    const dia = diaEmSaoPaulo(linha.createdAt);
    const ponto = porDia.get(dia) ?? {
      dia,
      custoUsd: 0,
      execucoes: 0,
      tokens: 0,
    };
    ponto.custoUsd += linha.costUsd;
    ponto.execucoes += 1;
    ponto.tokens += linha.inputTokens + linha.outputTokens;
    porDia.set(dia, ponto);
  }

  const execucoes = linhas.length;

  return {
    totais: {
      custoUsd: custoTotal,
      execucoes,
      erros,
      tokensEntrada,
      tokensSaida,
      tokensCache,
      tokens: tokensEntrada + tokensSaida,
      conversas: conversas.size,
      latenciaMediaMs:
        latenciaContagem > 0
          ? Math.round(latenciaSoma / latenciaContagem)
          : null,
      custoMedioPorExecucao: execucoes > 0 ? custoTotal / execucoes : 0,
      custoPorConversa: conversas.size > 0 ? custoTotal / conversas.size : null,
    },
    porModelo: fechar(porModelo, custoTotal),
    porAgente: fechar(porAgente, custoTotal),
    porFonte: fechar(porFonte, custoTotal),
    porDia: [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
  };
}

export type SerieCondensada = {
  pontos: PontoDoDia[];
  /** Quantos dias cabem em cada coluna. 1 = série diária, sem condensar. */
  diasPorColuna: number;
};

/**
 * Junta dias em blocos quando o período é longo demais para uma coluna por dia.
 *
 * Sem isto, um intervalo de dois anos vira 732 colunas: o espaço entre elas
 * come a largura inteira do cartão e as barras somem. Condensar diz a verdade
 * (o bloco soma o que aconteceu nele) e continua legível; a tela avisa o
 * agrupamento, e a tabela ao lado continua dia a dia.
 */
export function condensarSerie(
  pontos: PontoDoDia[],
  maximoDeColunas = 92,
): SerieCondensada {
  if (pontos.length <= maximoDeColunas) return { pontos, diasPorColuna: 1 };

  const diasPorColuna = Math.ceil(pontos.length / maximoDeColunas);
  const blocos: PontoDoDia[] = [];

  for (let i = 0; i < pontos.length; i += diasPorColuna) {
    const bloco = pontos.slice(i, i + diasPorColuna);
    blocos.push({
      // Rotulado pelo primeiro dia do bloco — é o começo do que ele soma.
      dia: bloco[0].dia,
      custoUsd: bloco.reduce((s, p) => s + p.custoUsd, 0),
      execucoes: bloco.reduce((s, p) => s + p.execucoes, 0),
      tokens: bloco.reduce((s, p) => s + p.tokens, 0),
    });
  }

  return { pontos: blocos, diasPorColuna };
}

/** `12.345` → `12,3 mil`. Para eixo e ladrilho, onde o dígito exato não importa. */
export function compactar(valor: number): string {
  const abs = Math.abs(valor);
  if (abs >= 1_000_000) {
    return `${(valor / 1_000_000).toLocaleString("pt-BR", {
      maximumFractionDigits: 1,
    })} mi`;
  }
  if (abs >= 1_000) {
    return `${(valor / 1_000).toLocaleString("pt-BR", {
      maximumFractionDigits: 1,
    })} mil`;
  }
  return valor.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}
