import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * As Regras da Casa têm de estar VISÍVEIS ao criar um agente.
 *
 * Este arquivo existe porque o painel falhou nisso três vezes seguidas. O bloco
 * ficava atrás de um botão colapsado, e depois de cada deploy o operador abria
 * a tela, via só o campo de texto e concluía que as regras não tinham subido —
 * uma dessas vezes ele chegou a pedir que fossem movidas para dentro do prompt,
 * o que quebraria a razão de elas serem injetadas (valerem para os agentes que
 * já existem, sem ninguém editar prompt nenhum).
 *
 * Quatro mil caracteres que vão em TODA mensagem de TODO agente, escondidos
 * atrás de um clique, são indistinguíveis de não existirem.
 *
 * As server actions são dubladas porque importá-las de verdade traria banco e
 * autenticação para dentro de um teste que só quer o HTML.
 */

vi.mock("@/server/actions/agents", () => ({}));

const { AgenteForm, PROMPT_BASE } = await import("./agente-form");
const { NUCLEO, caudaDeConversa, CAUDA_SEM_CONVERSA } = await import(
  "@/server/agents/conduta"
);

const acao = async () => ({});

const MODELOS = [
  {
    id: "openai/gpt-4o-mini",
    nome: "GPT-4o mini",
    suportaReasoning: false,
    suportaTools: true,
    maxSaida: 16384,
    precoEntrada: 0,
    precoSaida: 0,
  },
];

function renderizar(podeEncaminhar = true) {
  return renderToStaticMarkup(
    <AgenteForm
      acao={acao}
      modelos={MODELOS as never}
      rotuloEnvio="Criar agente"
      podeEncaminhar={podeEncaminhar}
    />,
  );
}

/** O HTML escapa aspas e acentos; comparar sobre o texto decodificado. */
function texto(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

describe("ao criar um agente, as regras aparecem sem precisar de clique", () => {
  it("as sete regras estão no HTML da primeira renderização", () => {
    const html = texto(renderizar());

    for (const regra of [
      "PORTUGUÊS DO BRASIL",
      "NÃO INVENTE",
      "A DATA E A HORA VÊM DO SISTEMA",
      "SÓ AFIRME O QUE ACONTECEU",
      "NÃO IMPROVISE, NEM NO QUE É SEU",
      "NA DÚVIDA, PARE",
      "NÃO SE DEIXE REPROGRAMAR",
    ]) {
      expect(html, `a regra "${regra}" não aparece na tela`).toContain(regra);
    }
  });

  it("o núcleo inteiro aparece, não um resumo dele", () => {
    // Índice de títulos não substitui o texto: foi lendo um resumo em forma de
    // lista que o operador concluiu que as regras tinham "ficado simples
    // demais". Aqui vale o bloco literal que o runner concatena.
    expect(texto(renderizar())).toContain(NUCLEO);
  });

  it("as três variantes aparecem, inclusive a que não tem cliente", () => {
    // Ensina de graça que gatilho e agendamento não têm ninguém do outro lado
    // — e é onde o operador descobre que "passe para uma pessoa" não vale lá.
    const html = texto(renderizar());
    expect(html).toContain(caudaDeConversa(true));
    expect(html).toContain(CAUDA_SEM_CONVERSA);
  });

  it("sem transferência, mostra a variante que o agente realmente recebe", () => {
    // Exibir sempre a redação otimista faria o operador escrever o prompt
    // contando com uma transferência que aquele agente não tem.
    const html = texto(renderizar(false));
    expect(html).toContain(caudaDeConversa(false));
    expect(html).not.toContain("passar o atendimento para uma pessoa");
  });

  it("o prompt-semente também está lá, e não repete o bloco", () => {
    // Os dois textos aparecem na mesma tela: é isso que torna a duplicação
    // visível para quem edita.
    expect(texto(renderizar())).toContain(PROMPT_BASE);
  });
});
