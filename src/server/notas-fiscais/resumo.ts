import type { SituacaoCobrancaFiscal } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

/** Quantas cobranças em cada situação nos últimos `dias` — para a tela. */
export async function resumoDasCobrancas(
  dias = 7,
  agora = new Date(),
): Promise<Record<SituacaoCobrancaFiscal, number>> {
  const grupos = await db.cobrancaFiscal.groupBy({
    by: ["situacao"],
    where: { criadaEm: { gte: new Date(agora.getTime() - dias * 86_400_000) } },
    _count: { _all: true },
  });
  const contar = (s: SituacaoCobrancaFiscal) =>
    grupos.find((g) => g.situacao === s)?._count._all ?? 0;
  return {
    PRONTA: contar("PRONTA"),
    AGUARDANDO_CLASSIFICACAO: contar("AGUARDANDO_CLASSIFICACAO"),
    CONFERIR: contar("CONFERIR"),
    FORA_DA_REGRA: contar("FORA_DA_REGRA"),
  };
}
