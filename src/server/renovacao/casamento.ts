/**
 * Casar CADA contrato do Conexa com a SUA tarefa na Base de clientes.
 *
 * ## Por que isto existe
 *
 * Até 13/11/2026 a regra era "cliente com mais de uma tarefa no fluxo não é
 * escrito": escolher uma deixaria as outras com o valor velho, e o cadastro
 * duplicado era tratado como erro da equipe. A Duda corrigiu o raciocínio:
 * **cada tarefa é o contrato de UM produto**. Quem tem duas ou quatro tarefas
 * tem dois ou quatro contratos, cada um com a sua data de reajuste, e todos
 * precisam ser reajustados. Medido na Base:
 *
 * - `(5051)`: quatro tarefas idênticas (mesmo valor, mesma data), só o BOX muda
 *   — e a tarefa diz "SERÃO 4 CONTRATOS PARA O MESMO CLIENTE". No Conexa são
 *   quatro contratos iguais (plano 169, R$ 104,48) e um quinto, mais novo.
 * - `(1858)`: duas tarefas de produtos diferentes (EV R$ 89 e sala privativa
 *   R$ 5.800), duas datas de reajuste a dois dias uma da outra, e três
 *   contratos no Conexa (um de R$ 0,00).
 *
 * ## O que liga um contrato a uma tarefa
 *
 * Não existe id de contrato na tarefa (o `CONEXA LINK` aponta para o CLIENTE).
 * O que existe, e o que este módulo usa, são dois campos que as duas pontas
 * têm:
 *
 * 1. **`VALOR CONTRATO`** — vale a evidência mais forte: se o valor da tarefa
 *    é o de ANTES do lote ou o de AGORA, é o contrato daquele valor. É o que
 *    separa o EV de R$ 89 da sala privativa de R$ 5.800.
 * 2. **`DATA DE REAJUSTE`** — tem de estar a até `TOLERANCIA_DE_DIAS` da
 *    fidelidade do contrato (as duas automações do n8n derivam um dia por ciclo:
 *    +365 contra +364). Mais longe que isso é outro ciclo ou outro contrato.
 *
 * ## O que NUNCA se faz
 *
 * - **Não se chuta.** Se dois pareamentos diferentes têm a MESMA pontuação e
 *   mudam o que vai para uma tarefa, o par fica pendente com o motivo escrito.
 *   Escrever o reajuste na tarefa errada põe o valor de um produto na ficha de
 *   outro, em silêncio.
 * - **Equivalente não é ambíguo.** Quatro contratos de mesmo valor e mesma data
 *   casados com quatro tarefas de mesmo valor e mesma data: qualquer
 *   pareamento escreve exatamente a mesma coisa em cada tarefa, então o
 *   módulo escolhe um e segue. É o caso do `(5051)`.
 * - **Sem evidência, não casa.** Num cliente com vários contratos ou tarefas,
 *   um par sem valor nem data em comum não conta.
 *
 * É puro e testado: aqui mora a decisão de em qual tarefa se escreve.
 */

/** Dias de diferença aceitos entre a `DATA DE REAJUSTE` da tarefa e a fidelidade. */
export const TOLERANCIA_DE_DIAS = 3;

/**
 * Acima disso o módulo não separa: a busca é exaustiva (cresce rápido) e um
 * cliente com tantos contratos pede olho humano de qualquer jeito.
 */
export const LIMITE_DE_CONTRATOS = 6;
export const LIMITE_DE_TAREFAS = 8;

export type ContratoParaCasar = {
  id: number;
  /** `AAAA-MM-DD`, a `fidelityDate` do Conexa. */
  fidelidade: string | null;
  /** O valor de antes do lote, em reais. Nulo quando não se sabe. */
  antes: number | null;
  /** O valor de agora, em reais. */
  atual: number | null;
  /**
   * Tudo que faz o EFEITO da propagação ser diferente de um contrato para
   * outro (percentual, data do lote…). Sem ela, vale antes|atual|fidelidade.
   */
  assinatura?: string;
};

export type TarefaParaCasar = {
  id: string;
  /** `VALOR CONTRATO`, em reais. */
  valor: number | null;
  /** `DATA DE REAJUSTE`, `AAAA-MM-DD` (dia de São Paulo). */
  dataDeReajuste: string | null;
  status: string;
};

export type Par<C, T> = { contrato: C; tarefa: T; pontos: number };

export type ResultadoDoCasamento<C, T> = {
  /** Pares que valem em TODA melhor combinação — pode escrever. */
  pares: Array<Par<C, T>>;
  /** Contratos para os quais nenhuma tarefa serve (ou as que servem já têm dono). */
  semTarefa: Array<{ contrato: C; motivo: string }>;
  /** Contratos com mais de uma tarefa igualmente boa, sem como distinguir. */
  ambiguos: Array<{ contrato: C; motivo: string }>;
  /** Tarefas que não ficaram com contrato nenhum. */
  sobram: T[];
};

function centavos(valor: number) {
  return Math.round(valor * 100);
}

function diasEntre(a: string, b: string) {
  const [aa, am, ad] = a.split("-").map(Number);
  const [ba, bm, bd] = b.split("-").map(Number);
  return Math.abs(Date.UTC(aa, am - 1, ad) - Date.UTC(ba, bm - 1, bd)) / 86_400_000;
}

/** O valor da tarefa é o de antes ou o de agora do contrato? */
function valorBate(
  contrato: Pick<ContratoParaCasar, "antes" | "atual">,
  tarefa: Pick<TarefaParaCasar, "valor">,
) {
  if (tarefa.valor == null) return false;
  const v = centavos(tarefa.valor);
  return [contrato.antes, contrato.atual].some((x) => x != null && centavos(x) === v);
}

/**
 * Quanto a tarefa parece ser deste contrato.
 *
 * `null` = incompatível (a data está longe e o valor não explica). `0` =
 * compatível mas sem nenhuma evidência a favor.
 */
export function pontosDoPar(
  contrato: Pick<ContratoParaCasar, "antes" | "atual" | "fidelidade">,
  tarefa: Pick<TarefaParaCasar, "valor" | "dataDeReajuste">,
): number | null {
  const bateValor = valorBate(contrato, tarefa);
  let pontos = bateValor ? 4 : 0;

  if (contrato.fidelidade && tarefa.dataDeReajuste) {
    const d = diasEntre(contrato.fidelidade, tarefa.dataDeReajuste);
    if (d > TOLERANCIA_DE_DIAS) {
      // Data de outro ciclo. Só o valor ainda explica a tarefa.
      return bateValor ? pontos : null;
    }
    pontos += d === 0 ? 2 : 1;
  }

  return pontos;
}

function assinaturaDoContrato(c: ContratoParaCasar) {
  return c.assinatura ?? `${c.antes ?? "?"}|${c.atual ?? "?"}|${c.fidelidade ?? "?"}`;
}

type Atribuicao = Array<number | null>; // por contrato: índice da tarefa ou nulo

/**
 * Todas as combinações de MAIOR pontuação total. Cada contrato escolhe uma
 * tarefa livre com evidência (ou nenhuma). Exaustivo: o limite de contratos
 * e de tarefas existe por causa disto.
 */
function melhoresAtribuicoes(tabela: Array<Array<number | null>>, minimo: number): Atribuicao[] {
  const n = tabela.length;
  const m = n ? tabela[0].length : 0;
  let melhor = -1;
  let achadas: Atribuicao[] = [];
  const atual: Atribuicao = new Array(n).fill(null);
  const usada = new Array(m).fill(false);

  function ir(i: number, total: number) {
    if (i === n) {
      if (total > melhor) {
        melhor = total;
        achadas = [atual.slice()];
      } else if (total === melhor) {
        achadas.push(atual.slice());
      }
      return;
    }
    atual[i] = null;
    ir(i + 1, total);
    for (let j = 0; j < m; j++) {
      const p = tabela[i][j];
      if (usada[j] || p == null || p < minimo) continue;
      usada[j] = true;
      atual[i] = j;
      // `+ 1` por par: com a mesma soma de pontos, casar mais vence casar menos.
      ir(i + 1, total + p + 1);
      atual[i] = null;
      usada[j] = false;
    }
  }

  ir(0, 0);
  return achadas;
}

/**
 * Casa os contratos de UM cliente com as tarefas dele.
 *
 * Só chame com contratos e tarefas do MESMO cliente.
 */
export function casarContratosComTarefas<
  C extends ContratoParaCasar,
  T extends TarefaParaCasar,
>(contratos: C[], tarefas: T[]): ResultadoDoCasamento<C, T> {
  const vazio: ResultadoDoCasamento<C, T> = {
    pares: [],
    semTarefa: [],
    ambiguos: [],
    sobram: [...tarefas],
  };
  if (!contratos.length) return vazio;

  if (!tarefas.length) {
    return {
      ...vazio,
      semTarefa: contratos.map((contrato) => ({
        contrato,
        motivo: "sem tarefa nos status de renovação",
      })),
    };
  }

  if (contratos.length > LIMITE_DE_CONTRATOS || tarefas.length > LIMITE_DE_TAREFAS) {
    return {
      ...vazio,
      ambiguos: contratos.map((contrato) => ({
        contrato,
        motivo: `cliente com ${contratos.length} contratos e ${tarefas.length} tarefas no fluxo — mais do que o sistema separa com segurança; precisa de olho humano`,
      })),
    };
  }

  // O caso comum: um contrato, uma tarefa. Sem exigir evidência (a tarefa
  // antiga pode não ter valor nem data), só que não haja contradição.
  const simples = contratos.length === 1 && tarefas.length === 1;
  const minimo = simples ? 0 : 1;

  const tabela = contratos.map((c) => tarefas.map((t) => pontosDoPar(c, t)));
  const atribuicoes = melhoresAtribuicoes(tabela, minimo);

  const assinaturas = contratos.map(assinaturaDoContrato);
  const chaveDe = (a: Atribuicao) => {
    const contagem = new Map<string, number>();
    a.forEach((j, i) => {
      const chave = `${assinaturas[i]}→${j == null ? "∅" : tarefas[j].id}`;
      contagem.set(chave, (contagem.get(chave) ?? 0) + 1);
    });
    return contagem;
  };

  const [primeira] = atribuicoes;
  const contagens = atribuicoes.map(chaveDe);

  // Todas as melhores combinações escrevem o MESMO em cada tarefa? Então não
  // há ambiguidade, só equivalência (quatro contratos iguais, quatro tarefas
  // iguais): qualquer uma serve e o módulo fica com a primeira.
  const mesmaContagem = (a: Map<string, number>, b: Map<string, number>) =>
    a.size === b.size && [...a].every(([chave, qtd]) => b.get(chave) === qtd);
  const todasIguais = contagens.every((c) => mesmaContagem(c, contagens[0]));

  // Quanto de cada par (assinatura → tarefa) aparece em TODAS as combinações.
  const firmes = new Map<string, number>();
  for (const [chave, qtd] of contagens[0]) {
    if (chave.endsWith("→∅")) continue;
    const minimoEmTodas = Math.min(...contagens.map((c) => c.get(chave) ?? 0));
    if (minimoEmTodas > 0) firmes.set(chave, Math.min(qtd, minimoEmTodas));
  }

  const pares: Array<Par<C, T>> = [];
  const pareados = new Set<number>();
  primeira.forEach((j, i) => {
    if (j == null) return;
    const chave = `${assinaturas[i]}→${tarefas[j].id}`;
    const resta = firmes.get(chave) ?? 0;
    if (resta <= 0) return;
    firmes.set(chave, resta - 1);
    pares.push({ contrato: contratos[i], tarefa: tarefas[j], pontos: tabela[i][j] ?? 0 });
    pareados.add(i);
  });

  const semTarefa: ResultadoDoCasamento<C, T>["semTarefa"] = [];
  const ambiguos: ResultadoDoCasamento<C, T>["ambiguos"] = [];
  const tarefasDeCada = (i: number) =>
    tarefas.filter((_, j) => {
      const p = tabela[i][j];
      return p != null && p >= minimo;
    });

  contratos.forEach((contrato, i) => {
    if (pareados.has(i)) return;
    const possiveis = tarefasDeCada(i);
    if (!possiveis.length) {
      semTarefa.push({
        contrato,
        motivo: simples
          ? "a única tarefa do cliente tem outra data e outro valor — parece ser de outro contrato"
          : "nenhuma tarefa do cliente tem o valor nem a data de reajuste deste contrato",
      });
      return;
    }
    // Há tarefa que serve. Se todas as melhores combinações escrevem o mesmo,
    // este contrato só SOBROU (as tarefas boas ficaram com contratos iguais a
    // ele); se o que vai para uma tarefa muda de uma combinação para outra, é
    // ambiguidade e nada é escrito.
    if (!todasIguais) {
      ambiguos.push({
        contrato,
        motivo: `${possiveis.length} tarefa${possiveis.length > 1 ? "s" : ""} do cliente servem a este contrato (mesmo valor e data) e não há como saber qual é a dele — a equipe precisa indicar`,
      });
    } else {
      semTarefa.push({
        contrato,
        motivo: "as tarefas do cliente que servem a este contrato já pertencem a outros contratos iguais a ele",
      });
    }
  });

  const usadas = new Set(pares.map((p) => p.tarefa.id));
  return { pares, semTarefa, ambiguos, sobram: tarefas.filter((t) => !usadas.has(t.id)) };
}
