import { describe, expect, it } from "vitest";
import {
  TETO_POR_CELULA,
  a1,
  casarComCabecalho,
  colunaParaLetra,
  cortarCelula,
  mesmoValor,
  nomesAmbiguos,
  normalizarLinhas,
  paraRegistros,
  posicoesDasColunas,
  procurarNaColuna,
} from "./sheets";

/**
 * Estes testes existem porque errar aqui **não dá exceção**.
 *
 * Uma coluna deslocada por um índice grava o CPF no campo do telefone, a API
 * responde `200` com `updatedCells` correto, o agente diz ao cliente que
 * registrou, e ninguém descobre até alguém abrir a planilha semanas depois. E
 * não existe desfazer: não há tool de exclusão, nem histórico que o agente
 * possa reverter. Por isso a régua aqui é mais dura que a de um módulo que
 * quebra alto.
 */

describe("a1", () => {
  it("põe aspas simples sempre, inclusive no nome que não precisaria", () => {
    // Sempre, e não "quando precisa": a regra condicional é a que alguém
    // simplifica depois sem saber quais nomes eram o caso perigoso.
    expect(a1("Clientes")).toBe("'Clientes'");
    expect(a1("Clientes", "A1:E10")).toBe("'Clientes'!A1:E10");
  });

  it("cobre aba com espaço e com acento", () => {
    expect(a1("Contratos de 2026", "A:C")).toBe("'Contratos de 2026'!A:C");
    expect(a1("Endereço Fiscal", "A2")).toBe("'Endereço Fiscal'!A2");
  });

  it("⚠ aba chamada 2026 ou A1 continua sendo ABA, não célula", () => {
    // Sem aspas, `A1!...` é sintaxe inválida e `A1` sozinho é a CÉLULA A1: a
    // leitura volta 200 com uma célula em vez da aba inteira, e a gravação vai
    // para o canto de cima da primeira aba. É o pior tipo de erro — o certo e
    // o errado têm a mesma cara na resposta.
    expect(a1("2026", "A1:B2")).toBe("'2026'!A1:B2");
    expect(a1("A1")).toBe("'A1'");
  });

  it("aspas simples dentro do nome dobram, como em SQL", () => {
    expect(a1("O'Brien", "A1")).toBe("'O''Brien'!A1");
    expect(a1("D'Água & Cia")).toBe("'D''Água & Cia'");
  });

  it("sem intervalo devolve só a aba entre aspas", () => {
    // O append manda a aba sozinha: é ela que a API usa para achar a tabela.
    // Espaço em branco conta como ausente, senão sobraria um `!` solto.
    expect(a1("Clientes")).toBe("'Clientes'");
    expect(a1("Clientes", "   ")).toBe("'Clientes'");
    expect(a1("Clientes", "")).toBe("'Clientes'");
  });
});

describe("colunaParaLetra", () => {
  it("cobre o primeiro alfabeto", () => {
    expect(colunaParaLetra(0)).toBe("A");
    expect(colunaParaLetra(25)).toBe("Z");
  });

  it("⚠ pega quem implementou com resto de 26 comum", () => {
    // É base 26 BIJETIVA: não existe o dígito zero, então 26 é "AA" e não
    // "BA". Uma planilha de controle costuma ter menos de 26 colunas, então o
    // defeito só aparece na planilha grande de outra equipe — e aparece como
    // gravação na coluna vizinha, não como erro.
    expect(colunaParaLetra(26)).toBe("AA");
    expect(colunaParaLetra(51)).toBe("AZ");
    expect(colunaParaLetra(52)).toBe("BA");
  });

  it("vira três letras na virada de ZZ", () => {
    expect(colunaParaLetra(701)).toBe("ZZ");
    expect(colunaParaLetra(702)).toBe("AAA");
  });
});

describe("casarComCabecalho", () => {
  const CABECALHO = ["Nome", "Nº do CPF", "Telefone", "Plano", "Observação"];

  it("põe cada valor na posição do cabeçalho, não na ordem em que veio", () => {
    // O modelo escreve os pares na ordem em que a conversa aconteceu, que
    // nunca é a ordem das colunas. Se a ordem de chegada mandasse, cada
    // atendimento gravaria a linha embaralhada de um jeito diferente.
    const r = casarComCabecalho(CABECALHO, [
      { coluna: "Plano", valor: "Mensal" },
      { coluna: "Nome", valor: "Maria" },
      { coluna: "Telefone", valor: "11999990000" },
    ]);

    expect(r.ok).toBe(true);
    expect(r.ok === true && r.linha).toEqual([
      "Maria",
      "",
      "11999990000",
      "Mensal",
      "",
    ]);
  });

  it("casa ignorando caixa, espaço repetido e acento", () => {
    const r = casarComCabecalho(CABECALHO, [
      { coluna: "nº  do   CPF", valor: "529.982.247-25" },
      { coluna: "observacao", valor: "cliente antigo" },
    ]);

    expect(r.ok).toBe(true);
    expect(r.ok === true && r.linha).toEqual([
      "",
      "529.982.247-25",
      "",
      "",
      "cliente antigo",
    ]);
    // `gravadas` devolve o nome como está NA PLANILHA, não como o modelo
    // escreveu: é esse texto que o operador vai procurar na aba.
    expect(r.ok === true && r.gravadas).toEqual(["Nº do CPF", "Observação"]);
  });

  it("`Nº` no cabeçalho casa com `No` digitado pelo modelo", () => {
    // `normalizarNome` usa NFKD justamente por causa deste caso: `º` (U+00BA)
    // tem decomposição de COMPATIBILIDADE, que o NFD não desfaz. Com NFD, o
    // cabeçalho "Nº do CPF" recusava a coluna "No do CPF" e a gravação inteira
    // abortava — desfecho seguro, mas uma iteração perdida por um caractere.
    const r = casarComCabecalho(CABECALHO, [
      { coluna: "no do cpf", valor: "529.982.247-25" },
    ]);

    expect(r.ok).toBe(true);
    // O que volta é o nome DO CABEÇALHO, não o que o modelo digitou: é esse
    // texto que o operador vai procurar na aba.
    expect(r.ok === true && r.gravadas).toEqual(["Nº do CPF"]);
  });

  it("coluna do cabeçalho não informada fica em branco e não desloca as seguintes", () => {
    // Ninguém preenche todas as colunas de uma planilha de controle a cada
    // linha. O que não pode acontecer é o buraco encolher a linha e empurrar
    // "Mensal" para cima de "Telefone".
    const r = casarComCabecalho(CABECALHO, [
      { coluna: "Nome", valor: "João" },
      { coluna: "Plano", valor: "Mensal" },
    ]);

    expect(r.ok === true && r.linha).toEqual(["João", "", "", "Mensal", ""]);
  });

  it("a linha devolvida tem exatamente o comprimento do cabeçalho", () => {
    // Linha mais curta faria o append gravar menos células que a tabela tem, e
    // a próxima leitura devolveria uma linha com rabo faltando.
    const r = casarComCabecalho(CABECALHO, [{ coluna: "Nome", valor: "Ana" }]);
    expect(r.ok === true && r.linha).toHaveLength(CABECALHO.length);
  });

  it("⚠ coluna que não existe aborta o lote e NÃO grava nada", () => {
    // Gravar a linha faltando o campo faria o agente dizer ao cliente que
    // registrou o documento — verdade pela metade, mentira na parte que
    // importa. E aqui não há desfazer.
    const r = casarComCabecalho(CABECALHO, [
      { coluna: "Nome", valor: "Ana" },
      { coluna: "Estado civil", valor: "Solteira" },
    ]);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toBe("desconhecidas");
    expect(r.ok === false && r.problematicas).toEqual(["Estado civil"]);
    // Não existe `linha` no resultado recusado: quem chama não tem como
    // gravar meia verdade por engano.
    expect(r).not.toHaveProperty("linha");
  });

  it("mesma coluna informada duas vezes é recusada em vez de a última vencer", () => {
    // "Última vence" gravaria um valor que o agente não escolheu
    // conscientemente, e o silêncio esconderia a contradição entre os dois.
    const r = casarComCabecalho(CABECALHO, [
      { coluna: "Telefone", valor: "11999990000" },
      { coluna: "telefone", valor: "11888887777" },
    ]);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toBe("duplicadas");
    expect(r.ok === false && r.problematicas).toEqual(["telefone"]);
  });

  it("cabeçalho todo vazio tem motivo próprio", () => {
    // Aba nova, ou faixa lida da linha errada. Sem motivo próprio, isso
    // chegaria ao modelo como "coluna desconhecida" e ele tentaria adivinhar
    // outro nome de coluna para sempre.
    const r = casarComCabecalho(["", "   "], [{ coluna: "Nome", valor: "Ana" }]);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toBe("cabecalhoVazio");
    expect(r.ok === false && r.problematicas).toEqual([]);
  });
});

describe("posicoesDasColunas", () => {
  const CABECALHO = ["Nome", "CPF", "Telefone", "Plano"];

  it("devolve a letra da coluna de cada par informado", () => {
    // A atualização escreve célula a célula: mandar a linha inteira apagaria
    // as colunas que o agente não informou.
    const r = posicoesDasColunas(CABECALHO, [
      { coluna: "plano", valor: "Anual" },
      { coluna: "Nome", valor: "Ana" },
    ]);

    expect(r.ok).toBe(true);
    expect(r.ok === true && r.alvos).toEqual([
      { letra: "D", valor: "Anual", coluna: "Plano" },
      { letra: "A", valor: "Ana", coluna: "Nome" },
    ]);
  });

  it("coluna desconhecida devolve a lista em vez de escrever no lugar errado", () => {
    const r = posicoesDasColunas(CABECALHO, [
      { coluna: "Nome", valor: "Ana" },
      { coluna: "E-mail", valor: "a@b.com" },
      { coluna: "Cidade", valor: "Santos" },
    ]);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toBe("desconhecidas");
    expect(r.ok === false && r.problematicas).toEqual(["E-mail", "Cidade"]);
  });
});

describe("normalizarLinhas", () => {
  it("⚠ `values` ausente devolve [] e não lança", () => {
    // A Sheets OMITE `values` quando a faixa está vazia — não vem `[]`, vem
    // ausente. Planilha recém-criada é exatamente esse caso, e um `.map` de
    // undefined derrubaria o turno na primeira leitura da planilha nova.
    expect(normalizarLinhas(undefined, 4)).toEqual([]);
    expect(normalizarLinhas(null, 4)).toEqual([]);
    expect(normalizarLinhas({}, 4)).toEqual([]);
  });

  it("⚠ linha mais curta que o cabeçalho ganha padding com string vazia", () => {
    // "Empty trailing rows and columns will not be included": `linha[3]` é
    // `undefined`, não `""`. Quem lê direto põe undefined no registro, o
    // JSON.stringify some com a chave, e o modelo conclui que a coluna não
    // existe naquela planilha.
    expect(normalizarLinhas([["Ana", "111"]], 4)).toEqual([
      ["Ana", "111", "", ""],
    ]);
  });

  it("buraco no meio e null viram string vazia", () => {
    expect(normalizarLinhas([["Ana", undefined, "Mensal"]], 3)).toEqual([
      ["Ana", "", "Mensal"],
    ]);
    expect(normalizarLinhas([["Ana", null, "Mensal"]], 3)).toEqual([
      ["Ana", "", "Mensal"],
    ]);
  });

  it("número vira string", () => {
    // `UNFORMATTED_VALUE` devolve número de verdade, não texto. Sem a
    // conversão, o retorno da tool mistura tipos e a comparação de busca
    // deixa de bater.
    expect(normalizarLinhas([[2026, 119.5, true]], 3)).toEqual([
      ["2026", "119.5", "true"],
    ]);
  });

  it("linha que não é lista não contamina as outras", () => {
    expect(normalizarLinhas([["Ana"], "lixo", [1]], 2)).toEqual([
      ["Ana", ""],
      ["", ""],
      ["1", ""],
    ]);
  });
});

describe("paraRegistros", () => {
  it("usa o nome da coluna como chave", () => {
    const r = paraRegistros(
      ["Nome", "CPF"],
      [
        ["Ana", "529.982.247-25"],
        ["João", ""],
      ],
    );

    expect(r).toEqual([
      { Nome: "Ana", CPF: "529.982.247-25" },
      { Nome: "João", CPF: "" },
    ]);
  });

  it("coluna de nome vazio é ignorada", () => {
    // Coluna separadora sem título é comum em planilha feita por humano. Como
    // chave ela viraria `""`, que o modelo não tem como referenciar.
    const r = paraRegistros(["Nome", "  ", "Plano"], [["Ana", "x", "Mensal"]]);
    expect(r).toEqual([{ Nome: "Ana", Plano: "Mensal" }]);
  });
});

describe("mesmoValor", () => {
  it("ignora a pontuação do documento", () => {
    // O cliente manda com ponto, a planilha guarda sem — ou o contrário.
    expect(mesmoValor("123.456.789-09", "12345678909")).toBe(true);
    expect(mesmoValor("11.222.333/0001-81", "11222333000181")).toBe(true);
  });

  it("⚠ acha o CPF que perdeu o zero à esquerda — o motivo de a função existir", () => {
    // Uma gravação anterior feita com `USER_ENTERED` (ou por um humano
    // digitando na planilha) transforma o CPF `01234567890` no NÚMERO
    // `1234567890`. Comparação crua não acharia nada, e o agente cadastraria
    // o mesmo cliente de novo — duplicata que ninguém consegue apagar.
    expect(mesmoValor("01234567890", "1234567890")).toBe(true);
    expect(mesmoValor("000.123.456-78", "12345678")).toBe(true);
  });

  it("números diferentes continuam diferentes depois do padding", () => {
    // A restauração do zero não pode virar "qualquer sufixo serve".
    expect(mesmoValor("01234567890", "9234567890")).toBe(false);
    expect(mesmoValor("12345678909", "12345678900")).toBe(false);
  });

  it("texto compara ignorando acento e caixa", () => {
    expect(mesmoValor("João", "joao")).toBe(true);
    expect(mesmoValor("  ANA  MARIA ", "ana maria")).toBe(true);
    expect(mesmoValor("abc", "abd")).toBe(false);
  });
});

describe("procurarNaColuna", () => {
  const COLUNA = ["12345678909", "99988877766", "123.456.789-09", "111"];

  it("o índice vira número de linha pelo `primeiraLinha` informado", () => {
    // ⚠ Não tem padrão de propósito: quem leu a partir de `B2` tem cabeçalho
    // fora da lista, quem leu de `B1` não tem. Errar em um faz a atualização
    // seguinte gravar na linha do vizinho — sem erro nenhum.
    expect(procurarNaColuna(COLUNA, "111", 2)).toEqual([5]);
    expect(procurarNaColuna(COLUNA, "111", 1)).toEqual([4]);
  });

  it("devolve TODAS as ocorrências, não a primeira", () => {
    // Duplicata na planilha é fato comum, e é justamente o que o operador
    // precisa ver. Devolver só a primeira faria a atualização escolher uma
    // linha em silêncio.
    expect(procurarNaColuna(COLUNA, "12345678909", 2)).toEqual([2, 4]);
  });

  it("nenhuma ocorrência devolve lista vazia", () => {
    expect(procurarNaColuna(COLUNA, "52998224725", 2)).toEqual([]);
    expect(procurarNaColuna([], "qualquer", 2)).toEqual([]);
  });
});

describe("cortarCelula", () => {
  it("abaixo do teto passa intacto", () => {
    const texto = "a".repeat(TETO_POR_CELULA);
    expect(cortarCelula(texto)).toBe(texto);
    expect(cortarCelula("observação curta")).toBe("observação curta");
  });

  it("acima do teto corta e a marca de corte aparece", () => {
    // O limite da Sheets não está na referência da API e estourá-lo devolve
    // `400` sem dizer qual célula. Cortar com marca visível é melhor que a
    // gravação inteira recusada por causa de um campo de observação comprido —
    // e a marca é o que impede alguém de ler o texto cortado como completo.
    const cortado = cortarCelula("a".repeat(TETO_POR_CELULA + 1));
    expect(cortado).toContain("[…cortado]");
    expect(cortado.startsWith("a".repeat(TETO_POR_CELULA))).toBe(true);
  });
});

describe("cabeçalho com dois nomes equivalentes", () => {
  // O caso real é invisível na tela: "CPF" na coluna B e "CPF " (com um espaço
  // no fim) na D. Antes disto, a ESCRITA resolvia para B e a LEITURA montava o
  // registro por nome, deixando a chave `CPF` ser reatribuída pela coluna D,
  // vazia. O agente lia "falta o CPF", mandava atualizar, e a atualização
  // sobrescrevia o CPF correto na B — `atualizado: true`, e a leitura seguinte
  // continuava mostrando vazio. Recusar dos dois lados é o que mantém leitura e
  // escrita contando a mesma história.
  const AMBIGUO = ["Nome", "CPF", "Status", "CPF "];

  it("nomesAmbiguos aponta o repetido, e não aponta nada num cabeçalho são", () => {
    expect(nomesAmbiguos(AMBIGUO)).toEqual(["CPF "]);
    expect(nomesAmbiguos(["Nome", "CPF", "Status"])).toEqual([]);
    // Coluna sem nome não conta como repetida: buraco no meio é comum.
    expect(nomesAmbiguos(["Nome", "", "", "CPF"])).toEqual([]);
  });

  it("casarComCabecalho recusa em vez de escolher a primeira", () => {
    const r = casarComCabecalho(AMBIGUO, [{ coluna: "Nome", valor: "Ana" }]);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toBe("cabecalhoAmbiguo");
    expect(r.ok === false && r.problematicas).toEqual(["CPF "]);
  });

  it("posicoesDasColunas recusa pelo mesmo motivo", () => {
    const r = posicoesDasColunas(AMBIGUO, [{ coluna: "Nome", valor: "Ana" }]);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toBe("cabecalhoAmbiguo");
  });
});

describe("posicoesDasColunas: coluna repetida no pedido", () => {
  it("recusa, em vez de deixar uma das duas vencer em silêncio", () => {
    // Dois pares para a mesma coluna viram duas entradas de `data` apontando
    // para a MESMA célula no `values:batchUpdate`: fica um dos dois valores sem
    // ninguém ter decidido qual, e o retorno diria `atualizado: true`. A trava
    // já existia na inserção; faltava aqui.
    const r = posicoesDasColunas(["Nome", "CPF"], [
      { coluna: "CPF", valor: "01234567890" },
      { coluna: "cpf", valor: "012.345.678-90" },
    ]);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toBe("duplicadas");
    expect(r.ok === false && r.problematicas).toEqual(["cpf"]);
  });
});

describe("mesmoValor: vazio nunca casa", () => {
  it("valor em branco não casa com célula vazia", () => {
    // `normalizarNome(" ")` é `""`, e o `.min(1)` do schema aceita um espaço.
    // Sem esta guarda, procurar por " " casaria com a primeira célula VAZIA da
    // coluna, e `atualizar_linha` gravaria na linha de outra pessoa com
    // `atualizado: true` — exatamente o desfecho que a tool existe para impedir.
    expect(mesmoValor(" ", "")).toBe(false);
    expect(mesmoValor("", "")).toBe(false);
    expect(mesmoValor("", "Ana")).toBe(false);
    expect(mesmoValor("   ", "\t")).toBe(false);
  });
});
