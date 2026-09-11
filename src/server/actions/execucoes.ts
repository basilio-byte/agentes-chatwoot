"use server";

import { exigirPapel, exigirSessao } from "@/server/auth-guard";
import { comFalhaVisivel } from "@/server/actions/falha-visivel";
import { UserRole } from "@/generated/prisma/enums";
import { autorDaSessao } from "@/server/gestao/autor";
import {
  lerDetalheDaExecucao,
  type DetalheDaExecucao,
} from "@/server/execucoes/detalhe";
import { pedirParadaDaExecucao } from "@/server/execucoes/parada";

// A leitura e a parada moram em `server/execucoes/`, que o MCP também chama.
// Os tipos continuam saindo daqui para a tela não precisar mudar de endereço.
export type {
  DetalheDaExecucao,
  ToolCallDetalhada,
} from "@/server/execucoes/detalhe";

/**
 * Falha nomeada, em vez de exceção que o Next mascara.
 *
 * ⚠ Em produção o Next entrega ao cliente só o `digest` de um erro de server
 * action — a mensagem real fica no servidor. Se esta ação apenas LANÇASSE, a
 * tela mostraria "não foi possível carregar" para qualquer causa e o log não
 * teria nada. Foi assim que uma falha ao expandir execução passou dias sem
 * diagnóstico, em 09/2026.
 */
export type FalhaAoDetalhar = { erro: string };

// ⚠ NADA além de função assíncrona pode ser exportado deste arquivo — nem
// constante, nem type guard. Exportar um número derruba a avaliação do módulo
// INTEIRO em runtime, e com ela TODAS as ações daqui; o build só pega parte dos
// casos. Os tetos moram em `execucoes/limites.ts`, o reconhecedor de falha no
// componente que o consome, e `use-server.test.ts` é quem cobra.

// ⚠ O reconhecedor NÃO mora aqui. Num arquivo "use server" toda exportação
// precisa ser função assíncrona, e um type guard é síncrono — o `tsc` aceita e
// só o build do Next reprova. Ele vive no componente que consome.

/**
 * Detalhe completo de uma execução, buscado sob demanda quando alguém expande
 * o cartão. Ver `lerDetalheDaExecucao`.
 */
export async function detalharExecucao(
  id: string,
): Promise<DetalheDaExecucao | FalhaAoDetalhar | null> {
  return comFalhaVisivel<DetalheDaExecucao | FalhaAoDetalhar | null>(
    "execucao.detalhar",
    async () => {
      // Mesmo tier da tela que lista: quem enxerga a lista pode abrir o item dela.
      await exigirSessao();
      return lerDetalheDaExecucao(id);
    },
    (falha) => ({ erro: falha.erro }),
  );
}

export type EstadoDaParada = { ok?: string; erro?: string };

/**
 * Pede para uma execução em andamento parar — ver `pedirParadaDaExecucao`.
 *
 * Exige ADMIN: parar um turno interrompe um atendimento com cliente do outro
 * lado, e "Leitura" não muda produção.
 */
export async function pararExecucao(id: string): Promise<EstadoDaParada> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  return pedirParadaDaExecucao(id, autorDaSessao(sessao));
}
