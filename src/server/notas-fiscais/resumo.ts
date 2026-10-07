import type { SituacaoCobrancaFiscal, SituacaoDaNota } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { chaveDaSpedy } from "@/server/integrations/spedy/client";
import { EMPRESAS_DA_SPEDY, type EmpresaDaSpedy } from "./config";

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

export type NotaDaTela = {
  id: string;
  chave: string;
  cobrancaId: number;
  empresa: string;
  codigo: string;
  valorCentavos: number;
  situacao: SituacaoDaNota;
  numero: number | null;
  motivo: string | null;
  tentativas: number;
  atualizadaEm: Date;
};

/**
 * As notas que a Spedy recebeu (ou tentou receber). Rejeitadas e com falha vêm
 * primeiro: são as que pedem uma pessoa, e não podem sumir no meio das
 * autorizadas.
 */
export async function resumoDasNotas(): Promise<{
  contagem: Record<SituacaoDaNota, number>;
  ultimas: NotaDaTela[];
}> {
  const grupos = await db.notaFiscalEmitida.groupBy({ by: ["situacao"], _count: { _all: true } });
  const contar = (s: SituacaoDaNota) => grupos.find((g) => g.situacao === s)?._count._all ?? 0;
  const contagem = {
    RESERVADA: contar("RESERVADA"),
    ENVIADA: contar("ENVIADA"),
    AUTORIZADA: contar("AUTORIZADA"),
    REJEITADA: contar("REJEITADA"),
    FALHOU: contar("FALHOU"),
    INCERTA: contar("INCERTA"),
    CANCELADA: contar("CANCELADA"),
  };
  const select = {
    id: true,
    chave: true,
    cobrancaId: true,
    empresa: true,
    codigo: true,
    valorCentavos: true,
    situacao: true,
    numero: true,
    motivo: true,
    tentativas: true,
    atualizadaEm: true,
  } as const;
  const [pedemPessoa, recentes] = await Promise.all([
    db.notaFiscalEmitida.findMany({
      where: { situacao: { in: ["REJEITADA", "FALHOU", "INCERTA"] } },
      orderBy: { atualizadaEm: "desc" },
      take: 15,
      select,
    }),
    db.notaFiscalEmitida.findMany({ orderBy: { atualizadaEm: "desc" }, take: 15, select }),
  ]);
  const vistos = new Set<string>();
  const ultimas = [...pedemPessoa, ...recentes].filter((n) => !vistos.has(n.id) && vistos.add(n.id));
  return { contagem, ultimas: ultimas.slice(0, 20) };
}

/** Só SE a chave de cada empresa está no servidor. O valor nunca sai daqui. */
export function chavesDaSpedyNoServidor(): Record<EmpresaDaSpedy, boolean> {
  return Object.fromEntries(EMPRESAS_DA_SPEDY.map((e) => [e, chaveDaSpedy(e) !== null])) as Record<
    EmpresaDaSpedy,
    boolean
  >;
}
