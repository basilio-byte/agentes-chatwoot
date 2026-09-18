import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { lerSaldo } from "@/server/consumo/saldo";
import { DIAS_DA_MEDIA, gastoMedioPorDia } from "@/server/consumo/consulta";
import { clienteComTokenDeUsuario } from "@/server/integrations/chatwoot/credenciais";
import { entregarAviso, type ClienteDeAviso, type Entrega } from "./conversa";
import {
  CONFERIR_A_CADA_MS,
  decidirAviso,
  destinatariosSalvos,
  INTERVALO_ENTRE_TESTES_MS,
  LIMITE_PADRAO_USD,
  textoDoAviso,
  type Destinatario,
  type TipoDeAviso,
} from "./regras";

/**
 * Alerta de saldo da OpenRouter por WhatsApp: a parte que fala com banco,
 * OpenRouter e Chatwoot. As decisões estão em `regras.ts`.
 *
 * Quem chama a conferência é o vigia do worker, de minuto em minuto, e ela
 * mesma segura o ritmo (`CONFERIR_A_CADA_MS`). O estado mora no banco, não na
 * memória: um deploy no meio do episódio não pode mandar o aviso de novo.
 */

const ID = "unico";

export type AlertaLido = {
  ligado: boolean;
  limiteUsd: number;
  caixaId: number;
  destinatarios: Destinatario[];
  abaixoDesde: Date | null;
  avisadoEm: Date | null;
  avisadoTipo: TipoDeAviso | null;
  conferidoEm: Date | null;
  ultimaFalha: string | null;
};

/** A linha, ou os padrões quando ninguém salvou nada ainda. */
export async function lerAlerta(): Promise<AlertaLido> {
  const linha = await db.alertaDeSaldo.findUnique({ where: { id: ID } });
  return {
    ligado: linha?.ligado ?? false,
    limiteUsd: linha?.limiteUsd ?? LIMITE_PADRAO_USD,
    caixaId: linha?.caixaId ?? 31,
    destinatarios: destinatariosSalvos(linha?.destinatarios),
    abaixoDesde: linha?.abaixoDesde ?? null,
    avisadoEm: linha?.avisadoEm ?? null,
    avisadoTipo: linha?.avisadoTipo ?? null,
    conferidoEm: linha?.conferidoEm ?? null,
    ultimaFalha: linha?.ultimaFalha ?? null,
  };
}

/** Só a configuração. Não toca no estado do episódio, que é do vigia. */
export async function salvarAlerta(
  dados: { ligado: boolean; limiteUsd: number; caixaId: number; destinatarios: Destinatario[] },
  autorId: string,
) {
  const config = {
    ligado: dados.ligado,
    limiteUsd: dados.limiteUsd,
    caixaId: dados.caixaId,
    destinatarios: dados.destinatarios as unknown as Prisma.InputJsonValue,
    atualizadoPorId: autorId,
  };
  await db.alertaDeSaldo.upsert({
    where: { id: ID },
    update: config,
    create: { id: ID, ...config },
  });
}

export async function ultimosAvisos(quantos = 5) {
  return db.avisoDeSaldo.findMany({ orderBy: { criadoEm: "desc" }, take: quantos });
}

async function registrar(args: {
  tipo: TipoDeAviso;
  saldoUsd: number | null;
  limiteUsd: number;
  entregas: Entrega[];
  autorId?: string | null;
}) {
  const entregues = args.entregas.filter((e) => e.ok).length;
  await db.avisoDeSaldo.create({
    data: {
      tipo: args.tipo,
      saldoUsd: args.saldoUsd,
      limiteUsd: args.limiteUsd,
      entregas: args.entregas as unknown as Prisma.InputJsonValue,
      entregues,
      falhas: args.entregas.length - entregues,
      autorId: args.autorId ?? null,
    },
  });
  return entregues;
}

const resumoDasFalhas = (entregas: Entrega[]) =>
  entregas
    .filter((e) => !e.ok)
    .map((e) => `${e.nome}: ${e.detalhe}`)
    .join(" · ");

let ultimaConferencia = 0;
let conferindo = false;

/**
 * Chamada pelo vigia a cada minuto; confere de fato a cada `CONFERIR_A_CADA_MS`.
 *
 * ⚠ **Reserva antes de mandar.** O aviso só sai depois de gravar `avisadoEm`
 * com a condição de que ele ainda seja o que foi lido: duas conferências ao
 * mesmo tempo (duas réplicas, ou um deploy no meio) não mandam dois avisos.
 * Se NENHUMA mensagem sair, a reserva é desfeita e a próxima conferência tenta
 * de novo — um aviso que falhou não pode contar como dado.
 */
export async function conferirSaldoEAvisar(
  opcoes: { agora?: Date; cliente?: ClienteDeAviso | null; forcar?: boolean } = {},
) {
  const agora = opcoes.agora ?? new Date();
  if (conferindo) return { acao: "em andamento" as const };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" as const };
  }

  conferindo = true;
  ultimaConferencia = agora.getTime();
  try {
    const alerta = await lerAlerta();
    // Desligado não lê o saldo: não há por que perguntar à OpenRouter.
    if (!alerta.ligado) return { acao: "desligado" as const };

    const leitura = await lerSaldo();
    const decisao = decidirAviso({
      leitura,
      ligado: alerta.ligado,
      limiteUsd: alerta.limiteUsd,
      temDestinatarios: alerta.destinatarios.length > 0,
      estado: alerta,
      agora,
    });

    if (decisao.acao === "ignorar") {
      await db.alertaDeSaldo.update({
        where: { id: ID },
        data: { conferidoEm: agora, ultimaFalha: decisao.falha ? decisao.motivo : null },
      });
      return decisao;
    }

    if (decisao.acao === "normalizar") {
      await db.alertaDeSaldo.update({
        where: { id: ID },
        data: {
          conferidoEm: agora,
          ultimaFalha: null,
          abaixoDesde: null,
          avisadoEm: null,
          avisadoTipo: null,
        },
      });
      return decisao;
    }

    if (decisao.acao === "aguardar") {
      await db.alertaDeSaldo.update({
        where: { id: ID },
        data: { conferidoEm: agora, ultimaFalha: null, abaixoDesde: alerta.abaixoDesde ?? agora },
      });
      return decisao;
    }

    const reservado = await db.alertaDeSaldo.updateMany({
      where: { id: ID, avisadoEm: alerta.avisadoEm },
      data: {
        avisadoEm: agora,
        avisadoTipo: decisao.tipo,
        abaixoDesde: alerta.abaixoDesde ?? agora,
        conferidoEm: agora,
      },
    });
    if (reservado.count === 0) return { acao: "outro já avisou" as const };

    const desfazer = (motivo: string) =>
      db.alertaDeSaldo.update({
        where: { id: ID },
        data: { avisadoEm: alerta.avisadoEm, avisadoTipo: alerta.avisadoTipo, ultimaFalha: motivo },
      });

    const cliente =
      opcoes.cliente !== undefined ? opcoes.cliente : await clienteComTokenDeUsuario();
    if (!cliente) {
      await desfazer(
        "sem o token de usuário do Chatwoot (Integrações → Chatwoot): não há como mandar a mensagem",
      );
      return { acao: "sem cliente" as const };
    }

    const texto = textoDoAviso({
      tipo: decisao.tipo,
      saldoUsd: decisao.saldoUsd,
      limiteUsd: alerta.limiteUsd,
      origem: decisao.origem,
      gastoDiarioUsd: await gastoMedioPorDia(),
      diasDaMedia: DIAS_DA_MEDIA,
    });
    const entregas = await entregarAviso(cliente, alerta.caixaId, alerta.destinatarios, texto);
    const entregues = await registrar({
      tipo: decisao.tipo,
      saldoUsd: decisao.saldoUsd,
      limiteUsd: alerta.limiteUsd,
      entregas,
    });

    if (entregues === 0) {
      await desfazer(`nenhuma mensagem saiu — ${resumoDasFalhas(entregas)}`);
      logger.error({ entregas }, "alerta de saldo: nenhuma mensagem saiu");
    } else {
      const falhas = resumoDasFalhas(entregas);
      await db.alertaDeSaldo.update({
        where: { id: ID },
        data: { ultimaFalha: falhas ? `parte não saiu — ${falhas}` : null },
      });
      logger.warn(
        { tipo: decisao.tipo, saldoUsd: decisao.saldoUsd, entregues },
        "alerta de saldo enviado",
      );
    }

    return { ...decisao, entregas };
  } finally {
    conferindo = false;
  }
}

/** Só para teste: o ritmo da conferência vive na memória do processo. */
export function esquecerUltimaConferencia() {
  ultimaConferencia = 0;
  conferindo = false;
}

export type ResultadoDoTeste = { erro: string } | { entregas: Entrega[] };

/**
 * O botão "Enviar teste": manda aos números SALVOS, agora, sem olhar o saldo
 * nem o episódio. É o que prova o caminho inteiro — Chatwoot, WAHA e o número
 * no formato certo — antes de o primeiro alerta de verdade precisar dele.
 */
export async function enviarTeste(
  autor: { id: string; nome: string | null },
  opcoes: { cliente?: ClienteDeAviso | null } = {},
): Promise<ResultadoDoTeste> {
  const alerta = await lerAlerta();
  if (alerta.destinatarios.length === 0) {
    return { erro: "Cadastre e salve pelo menos um telefone antes de testar." };
  }

  const ultimo = await db.avisoDeSaldo.findFirst({
    where: { tipo: "TESTE" },
    orderBy: { criadoEm: "desc" },
    select: { criadoEm: true },
  });
  if (ultimo && Date.now() - ultimo.criadoEm.getTime() < INTERVALO_ENTRE_TESTES_MS) {
    return { erro: "Um teste acabou de sair. Espere um minuto antes de mandar outro." };
  }

  const cliente =
    opcoes.cliente !== undefined ? opcoes.cliente : await clienteComTokenDeUsuario();
  if (!cliente) {
    return {
      erro: "Falta o token de usuário do Chatwoot (Integrações → Chatwoot). Sem ele não há como mandar a mensagem.",
    };
  }

  const leitura = await lerSaldo();
  const texto = textoDoAviso({
    tipo: "TESTE",
    saldoUsd: leitura.estado === "lido" ? leitura.saldoUsd : null,
    motivoSemSaldo: leitura.estado === "lido" || leitura.estado === "sem_chave" ? null : leitura.motivo,
    limiteUsd: alerta.limiteUsd,
    autor: autor.nome,
  });

  const entregas = await entregarAviso(cliente, alerta.caixaId, alerta.destinatarios, texto);
  await registrar({
    tipo: "TESTE",
    saldoUsd: leitura.estado === "lido" ? leitura.saldoUsd : null,
    limiteUsd: alerta.limiteUsd,
    entregas,
    autorId: autor.id,
  });
  return { entregas };
}
