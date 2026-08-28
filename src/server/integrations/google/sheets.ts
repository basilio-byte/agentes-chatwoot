import { normalizarNome } from "./config";

/**
 * As contas da planilha, puras e testadas.
 *
 * Este arquivo é onde mora o risco real da integração. Toda escrita passa por
 * `casarComCabecalho`, e um erro de índice aqui não dá exceção: grava o CPF na
 * coluna do telefone, devolve `200`, e ninguém descobre até alguém abrir a
 * planilha semanas depois. Por isso nada aqui toca a rede.
 */

/**
 * Monta a notação A1 de um intervalo dentro de uma aba.
 *
 * ⚠ **As aspas simples não são opcionais.** Aba com espaço, acento ou hífen sem
 * aspas é erro de sintaxe; pior, uma aba chamada `2026` ou `A1` sem aspas é
 * interpretada como CÉLULA — `A1` é a célula A1, `'A1'` é a aba A1. E aspas
 * simples dentro do nome da aba dobram, como em SQL.
 */
export function a1(aba: string, intervalo?: string): string {
  const nome = `'${aba.replace(/'/g, "''")}'`;
  const faixa = (intervalo ?? "").trim();
  return faixa ? `${nome}!${faixa}` : nome;
}

/**
 * Índice de coluna (0) para letra (`A`), incluindo além de `Z`.
 *
 * É base 26 **bijetiva**, não base 26 comum: não existe o dígito zero, então
 * `AA` é 26 e não 0. A conta ingênua com `% 26` erra a partir da coluna 26 —
 * exatamente onde ninguém testa.
 */
export function colunaParaLetra(indice: number): string {
  let n = indice + 1;
  let letra = "";
  while (n > 0) {
    const resto = (n - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    n = Math.floor((n - 1) / 26);
  }
  return letra;
}

export type ParDeColuna = { coluna: string; valor: string };

export type ResultadoDoCasamento =
  | { ok: true; linha: string[]; gravadas: string[] }
  | {
      ok: false;
      motivo:
        | "desconhecidas"
        | "duplicadas"
        | "cabecalhoVazio"
        | "cabecalhoAmbiguo";
      problematicas: string[];
    };

/**
 * Mapa nome-normalizado → posição, ou os nomes que colidem.
 *
 * ⚠ **Cabeçalho com dois nomes que normalizam igual é recusado**, e não
 * resolvido pelo primeiro. `"CPF"` na coluna B e `"CPF "` (com espaço, que
 * ninguém enxerga) na D é o caso real: a escrita resolveria para B, mas
 * `paraRegistros` monta o registro por nome e a chave `CPF` seria reatribuída
 * pela coluna D — vazia. O agente leria "falta o CPF", mandaria atualizar, e a
 * escrita sobrescreveria o CPF correto na B. `atualizado: true`, e a leitura
 * seguinte continuaria mostrando vazio. Leitura e escrita discordando sobre a
 * mesma coluna é o pior estado possível numa planilha sem desfazer.
 */
function indexarCabecalho(
  cabecalho: string[],
): { ok: true; posicoes: Map<string, number> } | { ok: false; ambiguas: string[] } {
  const posicoes = new Map<string, number>();
  const ambiguas: string[] = [];

  cabecalho.forEach((nome, indice) => {
    const chave = normalizarNome(nome);
    if (!chave) return;
    if (posicoes.has(chave)) {
      ambiguas.push(nome);
      return;
    }
    posicoes.set(chave, indice);
  });

  return ambiguas.length > 0 ? { ok: false, ambiguas } : { ok: true, posicoes };
}

/**
 * Nomes de coluna que colidem depois de normalizados.
 *
 * Exposto para o caminho de LEITURA poder recusar pelo mesmo motivo que o de
 * escrita. `paraRegistros` monta o registro por nome de coluna, e com duas
 * colunas que normalizam igual a última sobrescreve a chave da primeira: a
 * leitura mostraria vazio uma coluna que a escrita preencheu. Recusar dos dois
 * lados é o que mantém as duas contando a mesma história.
 */
export function nomesAmbiguos(cabecalho: string[]): string[] {
  const indice = indexarCabecalho(cabecalho);
  return indice.ok ? [] : indice.ambiguas;
}

/**
 * Põe cada valor na posição que a coluna ocupa no cabeçalho da aba.
 *
 * ⚠ **Coluna que não existe no cabeçalho ABORTA a gravação inteira**, e é
 * decisão, não rigor gratuito. É a mesma lição de `clickup/campos.ts`: "campo
 * errado aborta o lote inteiro, e a resposta devolve os nomes que existem;
 * tarefa criada com metade dos dados é pior do que pedir correção". Aqui é pior
 * ainda que no ClickUp — lá dá para editar a tarefa depois, e aqui **não existe
 * desfazer** e não há tool de exclusão. Gravar a linha faltando o CPF e
 * devolver sucesso faria o agente dizer ao cliente que registrou o documento,
 * o que é verdade pela metade e mentira na parte que importa.
 *
 * Coluna do cabeçalho que o agente NÃO informou é outra história: fica em
 * branco, sem reclamar. Ninguém preenche todas as colunas de uma planilha de
 * controle a cada linha.
 */
export function casarComCabecalho(
  cabecalho: string[],
  dados: ParDeColuna[],
): ResultadoDoCasamento {
  const colunasUteis = cabecalho.filter((c) => c.trim());
  if (colunasUteis.length === 0) {
    return { ok: false, motivo: "cabecalhoVazio", problematicas: [] };
  }

  const indice = indexarCabecalho(cabecalho);
  if (!indice.ok) {
    return {
      ok: false,
      motivo: "cabecalhoAmbiguo",
      problematicas: indice.ambiguas,
    };
  }
  const posicaoPorNome = indice.posicoes;

  const vistas = new Set<string>();
  const duplicadas: string[] = [];
  const desconhecidas: string[] = [];

  for (const par of dados) {
    const chave = normalizarNome(par.coluna);
    if (!posicaoPorNome.has(chave)) {
      desconhecidas.push(par.coluna);
      continue;
    }
    if (vistas.has(chave)) duplicadas.push(par.coluna);
    vistas.add(chave);
  }

  // Duplicada primeiro: "última vence" gravaria um valor que o agente não
  // escolheu conscientemente, e o silêncio esconderia a contradição.
  if (duplicadas.length > 0) {
    return { ok: false, motivo: "duplicadas", problematicas: duplicadas };
  }
  if (desconhecidas.length > 0) {
    return { ok: false, motivo: "desconhecidas", problematicas: desconhecidas };
  }

  const linha: string[] = new Array(cabecalho.length).fill("");
  const gravadas: string[] = [];

  for (const par of dados) {
    const posicao = posicaoPorNome.get(normalizarNome(par.coluna));
    if (posicao === undefined) continue;
    linha[posicao] = par.valor;
    gravadas.push(cabecalho[posicao]);
  }

  return { ok: true, linha, gravadas };
}

/**
 * Posição de cada coluna informada, para escrever célula a célula.
 *
 * Usado pela atualização, que **não** pode mandar a linha inteira: um
 * `values.update` da faixa toda apagaria as colunas que o agente não informou.
 */
export function posicoesDasColunas(
  cabecalho: string[],
  dados: ParDeColuna[],
):
  | { ok: true; alvos: { letra: string; valor: string; coluna: string }[] }
  | {
      ok: false;
      motivo: "desconhecidas" | "duplicadas" | "cabecalhoAmbiguo";
      problematicas: string[];
    } {
  const indice = indexarCabecalho(cabecalho);
  if (!indice.ok) {
    return {
      ok: false,
      motivo: "cabecalhoAmbiguo",
      problematicas: indice.ambiguas,
    };
  }
  const posicaoPorNome = indice.posicoes;

  const desconhecidas = dados
    .filter((d) => !posicaoPorNome.has(normalizarNome(d.coluna)))
    .map((d) => d.coluna);

  if (desconhecidas.length > 0) {
    return { ok: false, motivo: "desconhecidas", problematicas: desconhecidas };
  }

  // A mesma trava do caminho de inserção. Sem ela, dois pares para a mesma
  // coluna viram duas entradas de `data` apontando para a MESMA célula no
  // `values:batchUpdate` — fica um dos dois valores, sem ninguém ter decidido
  // qual, e `atualizado: true`.
  const vistas = new Set<string>();
  const duplicadas: string[] = [];
  for (const d of dados) {
    const chave = normalizarNome(d.coluna);
    if (vistas.has(chave)) duplicadas.push(d.coluna);
    vistas.add(chave);
  }
  if (duplicadas.length > 0) {
    return { ok: false, motivo: "duplicadas", problematicas: duplicadas };
  }

  return {
    ok: true,
    alvos: dados.map((d) => {
      const posicao = posicaoPorNome.get(normalizarNome(d.coluna))!;
      return {
        letra: colunaParaLetra(posicao),
        valor: d.valor,
        coluna: cabecalho[posicao],
      };
    }),
  };
}

/**
 * Iguala o comprimento das linhas que voltam da API.
 *
 * ⚠ A Sheets **não devolve o rabo vazio**: "empty trailing rows and columns
 * will not be included". As linhas voltam com comprimentos diferentes, e
 * `linha[4]` é `undefined`, não `""` — quem itera pelo cabeçalho e lê direto
 * põe `undefined` dentro do registro e o `JSON.stringify` do retorno some com
 * a chave, fazendo o modelo concluir que a coluna não existe.
 *
 * ⚠ E `values` **some inteiro** quando a faixa está vazia: não vem `[]`, vem
 * ausente. Planilha recém-criada é exatamente esse caso.
 */
export function normalizarLinhas(
  values: unknown,
  largura: number,
): string[][] {
  if (!Array.isArray(values)) return [];

  return values.map((linha) => {
    const bruta = Array.isArray(linha) ? linha : [];
    const saida: string[] = new Array(largura).fill("");
    for (let i = 0; i < largura; i++) {
      const valor = bruta[i];
      saida[i] = valor === null || valor === undefined ? "" : String(valor);
    }
    return saida;
  });
}

/** Linhas cruas viram registros com o nome da coluna como chave. */
export function paraRegistros(
  cabecalho: string[],
  linhas: string[][],
): Record<string, string>[] {
  return linhas.map((linha) => {
    const registro: Record<string, string> = {};
    cabecalho.forEach((nome, indice) => {
      const chave = nome.trim();
      if (chave) registro[chave] = linha[indice] ?? "";
    });
    return registro;
  });
}

/**
 * Compara valores de busca ignorando o que a planilha costuma estragar.
 *
 * Tira pontuação e acento, e — quando os dois lados são só dígitos — compara
 * pelos dígitos com zeros à esquerda restaurados. ⚠ O motivo é concreto: uma
 * gravação anterior feita com `USER_ENTERED` transforma o CPF `01234567890` no
 * NÚMERO `1234567890`, e o zero some. Procurar pelo CPF com zero à esquerda
 * numa planilha que já sofreu isso não acharia nada, e o agente cadastraria o
 * mesmo cliente duas vezes.
 */
export function mesmoValor(a: string, b: string): boolean {
  // ⚠ Vazio nunca casa com vazio. `normalizarNome(" ") === ""`, então um
  // `valorChave` só com espaço casaria com a primeira célula VAZIA da coluna —
  // e a atualização gravaria na linha de outra pessoa, com `atualizado: true`.
  // O `.min(1)` do schema não pega isso: espaço é um caractere.
  if (!a.trim() || !b.trim()) return false;

  const digitosA = a.replace(/\D/g, "");
  const digitosB = b.replace(/\D/g, "");

  if (digitosA && digitosB && /^[\d.,\-/\s]+$/.test(a) && /^[\d.,\-/\s]+$/.test(b)) {
    const largura = Math.max(digitosA.length, digitosB.length);
    return digitosA.padStart(largura, "0") === digitosB.padStart(largura, "0");
  }

  return normalizarNome(a) === normalizarNome(b);
}

/**
 * Acha as linhas cujo valor da coluna bate com o procurado.
 *
 * `primeiraLinha` é o número da linha na planilha correspondente a
 * `valores[0]`. ⚠ Não tem padrão de propósito: quem chama decide se leu a
 * coluna a partir de `B1` ou de `B2`, e errar em um faz a atualização seguinte
 * gravar na linha do vizinho. Um argumento obrigatório força a conta a ser
 * feita onde ela é visível.
 */
export function procurarNaColuna(
  valores: string[],
  alvo: string,
  primeiraLinha: number,
): number[] {
  const achados: number[] = [];
  valores.forEach((valor, indice) => {
    if (mesmoValor(valor, alvo)) achados.push(primeiraLinha + indice);
  });
  return achados;
}

/**
 * Teto de caracteres por célula.
 *
 * O limite real da Sheets é ~50.000 por célula e não está documentado na
 * referência da API — passar dele devolve `400` sem explicar qual célula.
 * Cortar antes, com marca visível, é melhor que uma gravação recusada inteira
 * por causa de um campo de observação comprido.
 */
export const TETO_POR_CELULA = 45_000;

export function cortarCelula(valor: string): string {
  if (valor.length <= TETO_POR_CELULA) return valor;
  return `${valor.slice(0, TETO_POR_CELULA)} […cortado]`;
}
