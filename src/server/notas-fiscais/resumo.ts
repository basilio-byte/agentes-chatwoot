import type { SituacaoCobrancaFiscal, SituacaoDaNota } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { configuracaoDeEmail } from "@/server/integrations/resend/client";
import { chaveDaSpedy } from "@/server/integrations/spedy/client";
import { EMPRESAS_DA_SPEDY, type EmpresaDaSpedy, type NotasFiscaisConfig } from "./config";
import { cobrancasRetidas } from "./emissao/emitir";

/**
 * Quantas cobranças estão retidas AGORA por um código em espera: as que a emissão
 * emitiria (corte, lista, empresa, janela) se o código não as segurasse. Conta mesmo
 * com a emissão desligada, porque é o tamanho da fila que vai sair quando o código
 * sair. ⚠ É a MESMA leitura da rodada (`cobrancasRetidas`): antes eram as 200 mais
 * antigas, e o número da tela ficava em zero quando a cobrança retida era nova.
 */
export async function contarRetidas(config: NotasFiscaisConfig): Promise<number> {
  return (await cobrancasRetidas(config)).length;
}

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
  /** A cobrança de onde a nota veio — só nas RESERVADAS, para a tela dizer o que ainda a segura (corte, lista). */
  cobranca?: { cobrancaId: number; empresaId: number; situacao: string; referencia: string | null };
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
  // ⚠ Duas consultas, e a segunda só para o FALHOU: cadastro ruim de cliente é FALHOU e se repete a cada
  // rodada — uma pilha delas, numa consulta só, empurrava a nota REJEITADA pela prefeitura para fora da lista.
  const [pedemPessoa, falharam, recentes] = await Promise.all([
    db.notaFiscalEmitida.findMany({
      where: { situacao: { in: ["REJEITADA", "INCERTA"] } },
      orderBy: { atualizadaEm: "desc" },
      take: 15,
      select,
    }),
    db.notaFiscalEmitida.findMany({ where: { situacao: "FALHOU" }, orderBy: { atualizadaEm: "desc" }, take: 10, select }),
    db.notaFiscalEmitida.findMany({ orderBy: { atualizadaEm: "desc" }, take: 15, select }),
  ]);
  const vistos = new Set<string>();
  const ultimas: NotaDaTela[] = [...pedemPessoa, ...falharam, ...recentes]
    .filter((n) => !vistos.has(n.id) && vistos.add(n.id))
    .slice(0, 25);

  // A cobrança das notas na fila (liberadas por "Tentar de novo"): fora do corte ou da lista a nota não sai,
  // e a tela dizia "sai em 5 minutos" (revisão de 09/10/2026).
  const reservadas = ultimas.filter((n) => n.situacao === "RESERVADA");
  if (reservadas.length) {
    const cobrancas = await db.cobrancaFiscal.findMany({
      where: { cobrancaId: { in: reservadas.map((n) => n.cobrancaId) } },
      select: { cobrancaId: true, empresaId: true, situacao: true, quitadaEm: true, cobranca: true },
    });
    for (const n of reservadas) {
      const c = cobrancas.find((x) => x.cobrancaId === n.cobrancaId);
      if (c) {
        n.cobranca = {
          cobrancaId: c.cobrancaId,
          empresaId: c.empresaId,
          situacao: c.situacao,
          referencia: c.quitadaEm ?? (c.cobranca as { criadaEm?: string | null } | null)?.criadaEm ?? null,
        };
      }
    }
  }
  return { contagem, ultimas };
}

/** Só SE a Resend (chave e remetente) está no servidor. O valor nunca sai daqui. */
export function emailNoServidor(): boolean {
  return configuracaoDeEmail() !== null;
}

/** Só SE a chave de cada empresa está no servidor. O valor nunca sai daqui. */
export function chavesDaSpedyNoServidor(): Record<EmpresaDaSpedy, boolean> {
  return Object.fromEntries(EMPRESAS_DA_SPEDY.map((e) => [e, chaveDaSpedy(e) !== null])) as Record<
    EmpresaDaSpedy,
    boolean
  >;
}
