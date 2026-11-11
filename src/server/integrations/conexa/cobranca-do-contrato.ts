/**
 * Qual cobrança é a daquele contrato — e, com ela, o link que o CLIENTE abre.
 *
 * ⚠⚠ **Existe porque `conexa_criar_contrato` devolvia um campo chamado `link`
 * que é tela interna do ERP**, e o prompt dos agentes de contrato manda publicar
 * "o link devolvido pela ferramenta". Em 10/11/2026 saiu exatamente isso no
 * comentário da task da primeira contratação real —
 * `…r=vendaRecorrente/gerenciarContratos&idCliente=6049` — e o Diego leu como
 * link de pagamento. O modelo não desobedeceu: obedeceu. A ferramenta oferecia
 * a isca, então o conserto é na ferramenta.
 *
 * O link do cliente é o da COBRANÇA (`chargeUrl`,
 * `…r=cobranca/fatura&id=<hash>`), conferido na cobrança real 19733, que o
 * próprio Conexa registra com "visualizações pelo cliente: 2".
 *
 * ⚠ **O vínculo é cobrança → venda → contrato**, nunca "a cobrança mais recente
 * do cliente": quem contrata um segundo produto tem duas cobranças contratuais
 * abertas ao mesmo tempo, e mandar a do outro produto é cobrar o valor errado.
 * É o mesmo caminho que as notas fiscais percorrem.
 *
 * Mora aqui, no módulo do Conexa, e não dentro do acompanhamento de contratos,
 * porque passou a ter dois donos: a rodada do acompanhamento e a própria
 * criação do contrato. Capacidade duplicada é a que diverge.
 */

import { linkDoClienteNoConexa } from "./duplicidade";
import {
  faturarPrimeiraCobranca,
  type FaturadorDeContrato,
  type ResultadoDaPrimeiraCobranca,
} from "./primeira-cobranca";

/** Uma cobrança, no mínimo que este caminho precisa. */
export type CobrancaResumida = {
  id: number | null;
  status: string | null;
  faturaUrl: string | null;
  vendas: number[];
};

/**
 * Teto de vendas consultadas para amarrar a cobrança ao contrato.
 *
 * Cada venda é uma ida ao Conexa, que limita a 60 requisições por minuto — o
 * mesmo limite que os agentes usam durante o atendimento.
 */
export const VENDAS_CONSULTADAS = 8;

/** O que o resolvedor precisa do cliente do Conexa. */
export type FiltrosDeCobranca = {
  customerId?: number;
  status?: string;
  limit?: number;
  offset?: number;
};

export type LeitorDeCobrancas = {
  listarCobrancas: (
    filtros: FiltrosDeCobranca,
  ) => Promise<{ itens: Record<string, unknown>[]; temMais: boolean }>;
  obterVenda: (id: number) => Promise<unknown>;
};

/**
 * A cobrança daquele contrato, entre as do cliente.
 *
 * A mais antiga é a primeira do contrato — é a que o cliente precisa pagar para
 * a contratação começar.
 */
export function cobrancaDoContrato(
  cobrancas: CobrancaResumida[],
  vendasDoContrato: ReadonlySet<number>,
) {
  const daqui = cobrancas.filter((c) => c.vendas.some((v) => vendasDoContrato.has(v)));
  return daqui.sort((a, b) => (a.id ?? 0) - (b.id ?? 0))[0] ?? null;
}

/** O Conexa chama de `paid` a cobrança quitada. Pago em parte não é pago. */
export function cobrancaPaga(status: string | null | undefined) {
  return (status ?? "").trim().toLowerCase() === "paid";
}

/** A forma crua da listagem de cobranças, normalizada. */
export function lerCobrancas(itens: unknown[]): CobrancaResumida[] {
  return (itens as Array<Record<string, unknown>>).map((c) => ({
    id: Number(c.chargeId ?? c.id) || null,
    status: typeof c.status === "string" ? c.status : null,
    faturaUrl: typeof c.chargeUrl === "string" ? c.chargeUrl : null,
    vendas: Array.isArray(c.salesIds) ? c.salesIds.map(Number).filter(Number.isFinite) : [],
  }));
}

/**
 * Acha, ao vivo, a cobrança daquele contrato.
 *
 * ⚠ Venda que não abre não amarra nada e não derruba a busca: quem chama tenta
 * de novo mais tarde, e no pior caso o link de pagamento simplesmente não vem.
 */
export async function cobrancaDoContratoNoConexa(
  cliente: LeitorDeCobrancas,
  clienteId: number,
  contratoId: number,
): Promise<CobrancaResumida | null> {
  const { itens } = await cliente.listarCobrancas({ customerId: clienteId, limit: 25 });
  const cobrancas = lerCobrancas(itens);

  const doContrato = new Set<number>();
  let consultadas = 0;
  for (const c of cobrancas) {
    for (const venda of c.vendas) {
      if (consultadas >= VENDAS_CONSULTADAS) break;
      consultadas++;
      try {
        const bruta = (await cliente.obterVenda(venda)) as Record<string, unknown>;
        if (Number(bruta.contractId) === contratoId) doContrato.add(venda);
      } catch {
        // Venda que não abre não amarra nada.
      }
    }
  }

  return cobrancaDoContrato(cobrancas, doContrato);
}

/**
 * Os dois links daquele contrato, nomeados de um jeito que não engana.
 *
 * ⚠⚠ **É o retorno da ferramenta que conserta isto, não o prompt.** Retorno de
 * tool vence o prompt, e um campo chamado `link` ao lado de um contrato é lido
 * como "o link do contrato" por qualquer modelo — foi o que aconteceu. Agora
 * cada endereço diz de quem é, e o aviso diz o que NÃO fazer com o interno.
 *
 * ⚠ **Nunca lança.** O contrato já foi criado quando isto roda: deixar a
 * exceção subir transformaria uma venda registrada em erro, e o agente tentaria
 * de novo — criando o segundo contrato que `duplicidade.ts` existe para evitar.
 * Sem o link, o aviso diz que ele não veio.
 */
export async function linksDoContrato(
  cliente: LeitorDeCobrancas & FaturadorDeContrato,
  baseUrl: string,
  clienteId: number,
  contratoId: number,
  agora = new Date(),
) {
  const telaDoContratoNoErp = linkDoClienteNoConexa(baseUrl, clienteId);

  let cobranca: CobrancaResumida | null = null;
  try {
    cobranca = await cobrancaDoContratoNoConexa(cliente, clienteId, contratoId);
  } catch {
    // Leitura que falha não vira "não existe cobrança": vira link que não veio.
  }

  // ⚠ O Conexa gera a VENDA do contrato sozinho, mas NÃO a cobrança — e é a
  // cobrança que tem o link que o cliente paga. Sem este passo o contrato
  // nasce sem como ser pago. Ver `primeira-cobranca.ts`.
  let faturamento: ResultadoDaPrimeiraCobranca | null = null;
  if (!cobranca?.faturaUrl) {
    faturamento = await faturarPrimeiraCobranca(cliente, clienteId, contratoId, agora);
    if (faturamento.feito === "criada" || faturamento.feito === "jaExistia") {
      cobranca = {
        id: faturamento.cobrancaId,
        status: null,
        faturaUrl: faturamento.faturaUrl,
        vendas: [],
      };
    }
  }

  return {
    linkDePagamentoDoCliente: cobranca?.faturaUrl ?? null,
    telaDoContratoNoErp,
    primeiraCobranca: faturamento?.feito,
    avisoSobreOsLinks: cobranca?.faturaUrl
      ? "linkDePagamentoDoCliente é o endereço que o CLIENTE abre para pagar — é esse que vai para ele e para o comentário como link de pagamento. telaDoContratoNoErp é painel interno da equipe: nunca mande ao cliente e nunca o chame de link de pagamento."
      : "Não consegui gerar a cobrança deste contrato agora, então NÃO existe link de pagamento para dar ao cliente. ⚠ Não use telaDoContratoNoErp no lugar dele: é painel interno, e o cliente não entra lá. Registre no comentário que o link de pagamento ainda não saiu — o sistema tenta de novo sozinho e manda ao cliente quando a cobrança existir.",
  };
}
