import type { ConexaClient } from "@/server/integrations/conexa/client";

import type { ContratoDaLeva } from "./regras";

/**
 * A leitura dos contratos no Conexa para a renovação.
 *
 * ⚠ **`GET /contracts` não filtra por fidelidade**, então a leva do mês só
 * aparece depois de ler os ativos e recortar no nosso código. São ~1.300
 * contratos; a 100 por página dá ~14 idas, dentro do limite de 60 por minuto
 * que a Conexa impõe e que os agentes também usam.
 *
 * ⚠ **Leitura cortada não vira conclusão.** A mesma doutrina da agenda: ali o
 * risco era concluir que um horário está livre a partir de uma lista
 * incompleta; aqui seria dizer que a leva do mês tem 60 contratos quando tem
 * 80 — e os 20 que faltam são os que ninguém vai renovar. Por isso
 * `completa: false` sobe junto e quem usa precisa decidir o que fazer.
 */

/**
 * ⚠ **50, e não 100.** Com 100 por página, `GET /contracts` passou dos 20 s de
 * prazo do cliente em 10/11/2026 e a leitura inteira morreu. O registro do
 * contrato é grande (serviços complementares, cotas); meia página volta bem
 * dentro do prazo, e o dobro de idas continua folgado nos 60 pedidos por
 * minuto que a Conexa permite.
 */
export const CONTRATOS_POR_PAGINA = 50;

/** Respiro entre páginas, para a leitura inteira não encostar no limite da API. */
export const PAUSA_ENTRE_PAGINAS_MS = 300;

/**
 * Teto de páginas. Com ~1.360 ativos e 50 por página são ~28 idas; 60 dão
 * folga de mais do que o dobro — e impedem laço infinito se o `hasNext` vier
 * errado.
 */
export const PAGINAS_MAXIMAS = 60;

type Bruto = Record<string, unknown>;

function numero(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function dia(valor: unknown): string | null {
  if (typeof valor !== "string" || !valor) return null;
  // O Conexa devolve `2026-12-04` e, em alguns campos, com hora junto.
  const texto = valor.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : null;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

/**
 * O contrato cru do Conexa no formato da renovação.
 *
 * ⚠ Separado de `formatarContrato` (`conexa/formatacao.ts`) de propósito: aquele
 * é o que vai para o MODELO nas ferramentas dos agentes, e cada campo a mais
 * ali é token em toda mensagem. Este é para tela e rodada, e precisa
 * justamente do que aquele descarta — fidelidade e último reajuste.
 *
 * ⚠ A listagem devolve `contractId` e o detalhe devolve `id`.
 */
export function contratoDaLeva(bruto: Bruto): ContratoDaLeva | null {
  const id = numero(bruto.contractId ?? bruto.id);
  const clienteId = numero(bruto.customerId);
  if (id === null || clienteId === null) return null;

  const reajuste = (bruto.lastContractualReadjustment ?? null) as Bruto | null;

  return {
    id,
    clienteId,
    fidelidade: dia(bruto.fidelityDate),
    valor: numero(bruto.amount),
    periodicidade: texto(bruto.paymentFrequency),
    inicio: dia(bruto.startDate),
    fim: dia(bruto.endDate),
    // `isActive` vem booleano; a listagem já é filtrada, mas um contrato sem o
    // campo não pode ser tratado como encerrado — perderíamos a leva dele.
    ativo: bruto.isActive !== false,
    reajusteEm: reajuste ? dia(reajuste.date) : null,
    reajustePct: reajuste ? numero(reajuste.percentage) : null,
    reajusteIndice: reajuste ? texto(reajuste.index) : null,
    plano: numero(bruto.planId),
    resumo: texto(bruto.contractSummary),
    diaDeVencimento: numero(bruto.dueDay),
  };
}

export type LeituraDosContratos = {
  contratos: ContratoDaLeva[];
  /** `false` = faltou contrato: o teto de páginas, ou uma página que não veio. */
  completa: boolean;
  paginas: number;
  /** Por que a leitura parou antes do fim, quando parou. */
  erro?: string;
};

/**
 * Lê todos os contratos ATIVOS, percorrendo as páginas.
 *
 * ⚠ **Uma página que falha NÃO derruba a leitura inteira.** A primeira versão
 * deixava o erro subir, e bastou uma página passar dos 20 s de prazo (com 100
 * por página, em 10/11/2026) para a rodada do dia não gravar nada — e, sem
 * log à mão, para o sintoma ser uma tela vazia sem explicação. Agora a página
 * é tentada mais uma vez e, se ainda assim não vier, a leitura devolve o que
 * já tem com `completa: false` e o motivo. Meia leva gravada e dita vale mais
 * que nenhuma.
 *
 * Recebe o cliente já aberto (`abrirConexa`) para a rodada e a tela usarem o
 * mesmo caminho, e para o teste poder passar um cliente de mentira.
 */
export async function lerContratosAtivos(
  cliente: Pick<ConexaClient, "listarContratos">,
  pausar: ((ms: number) => Promise<void>) | null = (ms) =>
    new Promise((pronto) => setTimeout(pronto, ms)),
): Promise<LeituraDosContratos> {
  const contratos: ContratoDaLeva[] = [];
  let paginas = 0;

  for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
    const offset = pagina * CONTRATOS_POR_PAGINA;
    let resposta;

    try {
      resposta = await cliente.listarContratos({
        isActive: 1,
        limit: CONTRATOS_POR_PAGINA,
        offset,
      });
    } catch (erro) {
      // Uma segunda tentativa cobre o soluço; a terceira seria insistir num
      // ERP que está lento, e a rodada volta amanhã.
      if (pausar) await pausar(PAUSA_ENTRE_PAGINAS_MS * 10);
      try {
        resposta = await cliente.listarContratos({
          isActive: 1,
          limit: CONTRATOS_POR_PAGINA,
          offset,
        });
      } catch (deNovo) {
        return {
          contratos,
          completa: false,
          paginas,
          erro: `a página ${pagina + 1} não veio: ${(deNovo as Error).message}`,
        };
      }
    }

    paginas++;
    for (const bruto of resposta.itens) {
      const contrato = contratoDaLeva(bruto);
      if (contrato) contratos.push(contrato);
    }

    if (!resposta.temMais) return { contratos, completa: true, paginas };
    if (pausar) await pausar(PAUSA_ENTRE_PAGINAS_MS);
  }

  return {
    contratos,
    completa: false,
    paginas,
    erro: `o teto de ${PAGINAS_MAXIMAS} páginas foi atingido`,
  };
}
