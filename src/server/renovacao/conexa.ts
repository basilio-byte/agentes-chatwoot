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

export const CONTRATOS_POR_PAGINA = 100;

/**
 * Teto de páginas. Com 1.358 ativos em 09/11/2026, 30 páginas dão folga de
 * mais do que o dobro — e impedem laço infinito se o `hasNext` vier errado.
 */
export const PAGINAS_MAXIMAS = 30;

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
  /** `false` = o teto de páginas foi atingido e falta contrato na lista. */
  completa: boolean;
  paginas: number;
};

/**
 * Lê todos os contratos ATIVOS, percorrendo as páginas.
 *
 * Recebe o cliente já aberto (`abrirConexa`) para a rodada e a tela usarem o
 * mesmo caminho, e para o teste poder passar um cliente de mentira.
 */
export async function lerContratosAtivos(
  cliente: Pick<ConexaClient, "listarContratos">,
): Promise<LeituraDosContratos> {
  const contratos: ContratoDaLeva[] = [];
  let paginas = 0;

  for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
    const { itens, temMais } = await cliente.listarContratos({
      isActive: 1,
      limit: CONTRATOS_POR_PAGINA,
      offset: pagina * CONTRATOS_POR_PAGINA,
    });
    paginas++;

    for (const bruto of itens) {
      const contrato = contratoDaLeva(bruto);
      if (contrato) contratos.push(contrato);
    }

    if (!temMais) return { contratos, completa: true, paginas };
  }

  return { contratos, completa: false, paginas };
}
