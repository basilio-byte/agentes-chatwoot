import { RunSource } from "@/generated/prisma/enums";

/**
 * Como cada origem de execução se chama na tela.
 *
 * Módulo puro, e é isso que justifica ele existir separado: `consumo/consulta.ts`
 * importa `@/lib/db`, então um componente de cliente não pode ler o rótulo de
 * lá sem arrastar o Prisma para o bundle do navegador. Era por isso que
 * `execucao.tsx` mantinha uma cópia — e a cópia **divergiu**: até 09/09/2026 a
 * tela de Execuções dizia "Gatilho" e a de Consumo dizia "Gatilho HTTP" para a
 * mesma linha. Capacidade duplicada é a que diverge; esta divergiu em silêncio,
 * porque nada comparava as duas.
 *
 * É `Record<RunSource, string>`: origem nova sem rótulo quebra o typecheck aqui,
 * de uma vez, em vez de aparecer crua num canto da interface.
 *
 * ⚠ Também são as OPÇÕES do filtro de fonte em /consumo e /execuções — as duas
 * telas montam o seletor por `Object.entries` deste mapa. Origem sem entrada não
 * perde só a legenda: some do filtro, e aquele recorte deixa de existir.
 */
export const ROTULO_DA_FONTE: Record<RunSource, string> = {
  [RunSource.CHATWOOT]: "Chatwoot",
  [RunSource.TRIGGER]: "Gatilho HTTP",
  [RunSource.PLAYGROUND]: "Playground",
  [RunSource.SCHEDULE]: "Agendamento",
  [RunSource.MESA]: "Mesa do agente",
};

/** O que veio na URL, quando é uma origem de verdade. Senão, sem filtro. */
export function normalizarFonte(valor: string | undefined | null) {
  return valor && valor in ROTULO_DA_FONTE ? (valor as RunSource) : null;
}
