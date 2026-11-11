/**
 * Os links da documentação do endereço, que vão ao cliente no fim da
 * contratação.
 *
 * **Por que isto existe.** Até 11/11/2026 o cliente recebia só "confirmamos
 * tudo". A documentação (AVCB, Habite-se, Ficha do Imóvel, Licença Ambiental,
 * ART, Laudo de Acessibilidade, Alvará de Funcionamento) saía por e-mail, pela
 * automação do ClickBot, e quem mandava os links no WhatsApp era o Felipe, à
 * mão. Ele está saindo. Pedido do Diego.
 *
 * ⚠ **Por que não se lê do comentário do ClickBot**, que seria a fonte sem
 * cópia: (1) ele só nasce quando a task entra em `ongoing`, que é DEPOIS de a
 * gente falar com o cliente — no instante da mensagem os links ainda não
 * existem; e (2) a API devolve `comment_text`, a versão plana, em que as URLs
 * dos hyperlinks somem; o array `comment` poderia tê-las em `attributes.link`,
 * mas esse campo **não está documentado** pela ClickUp. Duas incertezas para
 * evitar uma cópia não compensa.
 *
 * ⚠ **O preço da cópia é real e está aceito:** os links passam a existir em
 * DOIS lugares, a automação do ClickBot e esta configuração, e dois lugares
 * divergem. Por isso eles ficam em CONFIGURAÇÃO e não no código — a equipe
 * corrige sem deploy — e a tela diz que o original é a automação.
 *
 * ⚠ **Por produto.** O texto do ClickBot traz o endereço e a área construída
 * do prédio, e Litoral, Batial, Abissal e Comércio são endereços diferentes.
 * Mandar a documentação do prédio errado é pior do que não mandar nenhuma:
 * produto sem seção configurada sai SEM links, e a mensagem fica como era.
 */

export type DocumentoDoEndereco = { nome: string; url: string };

/** Nome de documento com mais de 60 caracteres não é nome, é parágrafo. */
const MAX_NOME = 60;

/**
 * O formato do campo: seções por produto, um documento por linha.
 *
 * ```
 * [Endereço Fiscal Litoral]
 * AVCB: https://drive.google.com/...
 * Habite-se: https://drive.google.com/...
 *
 * [Endereço Fiscal Batial]
 * AVCB: https://...
 * ```
 *
 * Um campo só, e não um por produto: são seis produtos, e seis caixas de texto
 * numa tela que já é longa é pior de manter do que uma com seções.
 */
export function lerDocumentos(texto: string | null | undefined): Record<string, DocumentoDoEndereco[]> {
  const porProduto: Record<string, DocumentoDoEndereco[]> = {};
  let atual: string | null = null;

  for (const bruta of (texto ?? "").split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha) continue;

    const secao = /^\[(.+)\]$/.exec(linha);
    if (secao) {
      atual = secao[1].trim();
      porProduto[atual] ??= [];
      continue;
    }
    if (!atual) continue;

    // O nome vai até o PRIMEIRO dois-pontos; o resto é o endereço, que tem
    // dois-pontos dentro (`https:`). Partir pelo último quebraria tudo.
    const corte = linha.indexOf(":");
    if (corte <= 0) continue;

    const nome = linha.slice(0, corte).trim().replace(/\s+/g, " ").slice(0, MAX_NOME);
    const url = linha.slice(corte + 1).trim();
    if (!nome || !urlValida(url)) continue;

    porProduto[atual].push({ nome, url });
  }

  return porProduto;
}

/**
 * ⚠ Só `http` e `https`. O endereço vai para o WhatsApp de um cliente, e um
 * `javascript:` ou `data:` colado por engano numa caixa de texto não pode
 * chegar lá. Mesma régua do link na planilha do Google.
 */
export function urlValida(url: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Compara nome de produto sem depender de acento nem de caixa. */
function chave(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Os documentos daquele produto. Produto desconhecido, vazio ou sem seção
 * devolve lista vazia — nunca a de outro produto.
 */
export function documentosDoProduto(
  configurado: Record<string, DocumentoDoEndereco[]>,
  produto: string | null | undefined,
): DocumentoDoEndereco[] {
  if (!produto) return [];
  const alvo = chave(produto);
  for (const [nome, docs] of Object.entries(configurado)) {
    if (chave(nome) === alvo) return docs;
  }
  return [];
}

/**
 * O trecho da mensagem com a documentação.
 *
 * ⚠ **Documentos que apontam para o MESMO endereço viram um link só.** Hoje
 * são sete arquivos distintos no Drive; se a equipe um dia os puser numa pasta
 * única, basta configurar uma linha e a mensagem fica com um link — sem mexer
 * em código.
 */
export function blocoDaDocumentacao(docs: DocumentoDoEndereco[]): string[] {
  if (docs.length === 0) return [];

  const unicos = new Set(docs.map((d) => d.url));
  if (unicos.size === 1) {
    return ["", "📑 A documentação do endereço, para a alteração do domicílio:", docs[0].url];
  }

  return [
    "",
    "📑 A documentação do endereço, para a alteração do domicílio:",
    ...docs.map((d) => `${d.nome}: ${d.url}`),
  ];
}
