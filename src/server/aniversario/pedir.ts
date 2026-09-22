import { PresenteStatus, RunSource } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { formatarData } from "@/lib/utils";
import { entregarAviso } from "@/server/alerta-de-saldo/conversa";
import { clienteComTokenDeUsuario, clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import { juntarPaginas } from "@/server/integrations/conexa/client";
import { conferirHorario, instanteEmSaoPaulo } from "@/server/integrations/conexa/agenda";
import { salaOuErro } from "@/server/integrations/conexa/config";
import { periodoDaAgenda } from "@/server/integrations/conexa/entrada";
import { formatarReserva } from "@/server/integrations/conexa/formatacao";
import { conferirIdentidade } from "@/server/integrations/conexa";
import { abrirConexa } from "@/server/integrations/conexa/sistema";
import { pessoaDaApi } from "@/server/integrations/conexa/solicitante";
import type { ToolContext } from "@/server/integrations/types";
import {
  ANTECEDENCIA_MINIMA_MS,
  aniversarioNaJanela,
  avisoDePedido,
  DIAS_ENTRE_PRESENTES,
  lerConfigAniversario,
  notaDePedido,
  vencimentoDoPedido,
} from "./regras";

/**
 * O que `aniversario_pedir_presente` faz: confere tudo o que dá para conferir
 * sem a equipe, registra o pedido e avisa quem lança o pacote.
 *
 * A ordem é a do custo de errar: identidade antes de ler aniversário (o
 * aniversário é dado do cadastro, e só quem provou ser o cliente pode saber se
 * bate), aniversário antes da agenda, e a agenda antes de avisar a equipe — um
 * pedido para um horário ocupado faria o Diego lançar um pacote para nada.
 */

export type EntradaDoPedido = {
  clienteId: number;
  sala: string;
  nomeDaSala?: string;
  data: string;
  inicio: string;
  fim: string;
};

const PASSE_PARA_A_EQUIPE =
  "Passe a conversa para uma pessoa da equipe, explicando que o cliente pediu o presente de aniversário.";

/** Onde o pedido pode nascer: num atendimento do Chatwoot, simulado no playground. */
function forma(ctx: ToolContext): "registrar" | "simular" | "fora" {
  if (ctx.source === RunSource.PLAYGROUND) return "simular";
  if (ctx.source === RunSource.CHATWOOT && ctx.chatwootConversationId) return "registrar";
  return "fora";
}

export async function pedirPresente(
  entrada: EntradaDoPedido,
  ctx: ToolContext,
  agora = new Date(),
): Promise<Record<string, unknown>> {
  const onde = forma(ctx);
  if (onde === "fora") {
    return {
      registrado: false,
      erro: "O presente de aniversário só é pedido num atendimento do Chatwoot, com o cliente do outro lado — nada foi registrado.",
    };
  }

  const config = lerConfigAniversario(ctx.config);
  if (!config.avisar.length) {
    return {
      registrado: false,
      erro: "Falta configurar quem recebe o aviso do presente (Integrações → Aniversário) — nada foi registrado.",
      comoSeguir: PASSE_PARA_A_EQUIPE,
    };
  }

  const conexa = await abrirConexa("aniversario");
  if ("erro" in conexa) {
    return { registrado: false, erro: `Não dá para conferir o presente: ${conexa.erro}.`, comoSeguir: PASSE_PARA_A_EQUIPE };
  }
  const { cliente } = conexa;

  const sala = salaOuErro(entrada.sala, conexa.config);
  if ("erro" in sala) return { registrado: false, ...sala };
  if (!sala.roomId) return { registrado: false, erro: "Informe a sala (o salaId da agenda)." };

  const inicioMs = instanteEmSaoPaulo(entrada.data, entrada.inicio);
  const fimMs = instanteEmSaoPaulo(entrada.data, entrada.fim);
  if (inicioMs === null || fimMs === null) {
    return {
      registrado: false,
      erro: `Data ou horário fora do formato: data "${entrada.data}" (AAAA-MM-DD), início "${entrada.inicio}" e fim "${entrada.fim}" (HH:MM).`,
    };
  }
  if (fimMs <= inicioMs) {
    return { registrado: false, erro: `O fim (${entrada.fim}) não é depois do início (${entrada.inicio}).` };
  }
  if (fimMs - inicioMs > config.horas * 3_600_000) {
    return {
      registrado: false,
      erro: `O presente é de ${config.horas} h de sala, e o pedido tem mais que isso.`,
      comoSeguir: `Combine com o cliente um horário de até ${config.horas} h.`,
    };
  }
  if (inicioMs - agora.getTime() < ANTECEDENCIA_MINIMA_MS) {
    return {
      registrado: false,
      erro: "O horário começa cedo demais: a equipe precisa de pelo menos 1 hora para liberar o presente.",
      comoSeguir: "Ofereça um horário que comece daqui a mais de 1 hora (ou outro dia).",
    };
  }

  // ⚠ Quem pede provou ser o cliente? O presente é uma reserva de graça na
  // conta dele — a mesma trava de toda reserva (`conexa/identidade.ts`).
  const identidade = await conferirIdentidade(cliente, entrada.clienteId, ctx);
  if (!identidade.ok) return { registrado: false, ...identidade.recusa };

  // O aniversário: o do cliente pessoa física e o das pessoas vinculadas. Quem
  // provou com o PRÓPRIO CPF de pessoa vinculada conta só por si.
  let nascimentos: unknown[];
  let clienteNome: string | null;
  try {
    const bruto = await cliente.obterCliente(entrada.clienteId);
    const pf = (bruto.naturalPerson ?? {}) as Record<string, unknown>;
    const estrangeiro = (bruto.foreign ?? {}) as Record<string, unknown>;
    clienteNome = typeof bruto.name === "string" ? bruto.name : null;

    const pessoas = (await cliente.listarPessoas({ customerId: entrada.clienteId, limit: 25 })).itens;
    const quemConta = pessoas.filter((p) => {
      const pessoa = pessoaDaApi(p);
      return identidade.pessoaId ? pessoa.id === identidade.pessoaId : pessoa.ativa !== false;
    });
    nascimentos = [
      ...(identidade.pessoaId ? [] : [pf.birthDate, estrangeiro.birthDate]),
      ...quemConta.map((p) => p.birthDate),
    ];
  } catch {
    return {
      registrado: false,
      erro: "Não consegui ler o cadastro no Conexa para conferir o aniversário.",
      comoSeguir: "Tente de novo em instantes. Se persistir, " + PASSE_PARA_A_EQUIPE.toLowerCase(),
    };
  }

  const hoje = diaEmSaoPaulo(agora);
  const janela = aniversarioNaJanela(nascimentos, hoje, config.diasDepois);
  if (janela.tipo === "semData") {
    return {
      registrado: false,
      erro: "O cadastro no Conexa não tem data de nascimento, então não dá para conferir o presente por aqui.",
      comoSeguir: PASSE_PARA_A_EQUIPE,
    };
  }
  if (janela.tipo === "fora") {
    return {
      registrado: false,
      erro: `Pelo cadastro, o aniversário não foi nos últimos ${config.diasDepois} dias — o presente vale até ${config.diasDepois} dias depois do aniversário.`,
      comoSeguir:
        "Explique com gentileza, SEM dizer a data que está no cadastro. Se o cliente insistir que recebeu o e-mail agora, " +
        PASSE_PARA_A_EQUIPE.toLowerCase(),
    };
  }

  const conversa = ctx.chatwootConversationId;
  const jaUsou = await db.presenteDeAniversario.findFirst({
    where: {
      clienteId: entrada.clienteId,
      status: PresenteStatus.RESERVADO,
      criadoEm: { gte: new Date(agora.getTime() - DIAS_ENTRE_PRESENTES * 86_400_000) },
    },
    orderBy: { criadoEm: "desc" },
    select: { data: true },
  });
  if (jaUsou) {
    return {
      registrado: false,
      erro: `Este cliente já usou o presente de aniversário deste ano (reserva do dia ${jaUsou.data.split("-").reverse().join("/")}).`,
      comoSeguir: "Explique com gentileza. Se o cliente discordar, " + PASSE_PARA_A_EQUIPE.toLowerCase(),
    };
  }
  const emOutraConversa = await db.presenteDeAniversario.findFirst({
    where: {
      clienteId: entrada.clienteId,
      status: { in: [PresenteStatus.AGUARDANDO, PresenteStatus.PROCESSANDO] },
      ...(conversa ? { chatwootConversationId: { not: conversa } } : {}),
    },
    select: { id: true },
  });
  if (emOutraConversa) {
    return {
      registrado: false,
      erro: "Já existe um pedido de presente deste cliente em andamento, em outra conversa.",
      comoSeguir: "Diga que o pedido já está com a equipe. Não registre outro.",
    };
  }
  if (conversa) {
    const processando = await db.presenteDeAniversario.findFirst({
      where: { chatwootConversationId: conversa, status: PresenteStatus.PROCESSANDO },
      select: { id: true },
    });
    if (processando) {
      return {
        registrado: false,
        erro: "O pedido anterior desta conversa está sendo reservado agora — não dá para trocar o horário neste momento.",
        comoSeguir: "Diga ao cliente que a confirmação chega em instantes. Não chame de novo.",
      };
    }
  }

  // A agenda antes de avisar a equipe: pedido para horário ocupado faria lançar
  // um pacote para nada. Na reserva, `conexa_criar_reserva` confere de novo.
  const dia = periodoDaAgenda(entrada.data, entrada.data);
  if ("erro" in dia) return { registrado: false, ...dia };
  try {
    const agenda = await juntarPaginas(
      ({ offset, limit }) =>
        cliente.listarReservas({
          roomId: sala.roomId,
          bookingDateTimeFrom: dia.de,
          bookingDateTimeTo: dia.ate,
          limit,
          offset,
        }),
      { porPagina: 50, teto: 100 },
    );
    if (!agenda.completo) {
      return {
        registrado: false,
        erro: "A agenda da sala neste dia não veio inteira, então não dá para afirmar que o horário está livre.",
        comoSeguir: PASSE_PARA_A_EQUIPE,
      };
    }
    const conferencia = conferirHorario(
      agenda.itens.map((r) => formatarReserva(r)),
      { inicioMs, fimMs },
    );
    if (!conferencia.livre) {
      return {
        registrado: false,
        erro: `O horário pedido não está livre nesta sala em ${entrada.data}.`,
        ocupado: conferencia.conflitam.map((r) => ({ inicio: r.inicio, fim: r.fim })),
        comoSeguir: "Ofereça outro horário livre ao cliente e chame de novo com ele.",
      };
    }
  } catch {
    return {
      registrado: false,
      erro: "Não consegui ler a agenda da sala para conferir o horário.",
      comoSeguir: "Tente de novo em instantes. Se persistir, " + PASSE_PARA_A_EQUIPE.toLowerCase(),
    };
  }

  const venceEm = vencimentoDoPedido({
    agoraMs: agora.getTime(),
    prazoHoras: config.prazoHoras,
    inicioDaReservaMs: inicioMs,
  });
  const resumo = {
    salaNome: entrada.nomeDaSala?.trim() || null,
    salaId: sala.roomId,
    data: entrada.data,
    inicio: entrada.inicio,
    fim: entrada.fim,
  };

  if (onde === "simular" || !conversa) {
    return {
      registrado: false,
      simulacao: true,
      aniversario: "na janela do presente",
      observacao: `No playground nada é registrado. Num atendimento, o pedido seria registrado, ${config.avisar
        .map((d) => d.nome)
        .join(", ")} receberia(m) o aviso por WhatsApp, e a reserva sairia sozinha quando o pacote aparecesse pago.`,
    };
  }

  const porta = ctx.canalAgentId ?? ctx.agentId;
  const robo = await clienteDoAgente(porta);
  if (!robo) throw new Error("Bot do Chatwoot não configurado para o canal desta conversa.");

  // Um só em andamento por conversa: o pedido novo substitui o anterior (o
  // cliente mudou de horário). Quem impede dois numa corrida é o índice parcial.
  const pedido = await db.$transaction(async (tx) => {
    await tx.presenteDeAniversario.updateMany({
      where: { chatwootConversationId: conversa, status: PresenteStatus.AGUARDANDO },
      data: {
        status: PresenteStatus.CANCELADO,
        resultado: "substituído por um pedido novo na mesma conversa",
        finalizadoEm: agora,
      },
    });
    return tx.presenteDeAniversario.create({
      data: {
        chatwootConversationId: conversa,
        agentId: ctx.agentId,
        portaAgentId: porta,
        clienteId: entrada.clienteId,
        pessoaId: identidade.pessoaId ?? null,
        salaId: sala.roomId!,
        salaNome: resumo.salaNome,
        data: entrada.data,
        inicio: entrada.inicio,
        fim: entrada.fim,
        aniversario: janela.aniversario,
        venceEm,
      },
    });
  });

  const prazo = formatarData(venceEm);
  const linkDaConversa = `${robo.baseUrl}/app/accounts/${robo.contaId}/conversations/${conversa}`;
  const usuario = await clienteComTokenDeUsuario();
  const entregas = usuario
    ? await entregarAviso(
        usuario,
        config.caixaDoAviso,
        config.avisar,
        avisoDePedido({
          pedido: resumo,
          clienteId: entrada.clienteId,
          clienteNome,
          aniversario: janela.aniversario,
          venceEm: prazo,
          linkDaConversa,
        }),
      )
    : config.avisar.map((d) => ({
        nome: d.nome,
        ok: false,
        detalhe: "sem o token de leitura do Chatwoot (Integrações → Chatwoot)",
        conversaId: null,
      }));
  const avisados = entregas.filter((e) => e.ok).map((e) => e.nome);
  const rastro = entregas.map((e) => `${e.nome}: ${e.ok ? "avisado" : `aviso não saiu (${e.detalhe})`}`);

  // Sem ninguém avisado, o pedido não anda: ninguém vai lançar o pacote.
  if (!avisados.length) {
    await db.presenteDeAniversario.update({
      where: { id: pedido.id },
      data: {
        status: PresenteStatus.FALHOU,
        resultado: ["ninguém recebeu o aviso por WhatsApp", ...rastro].join(" · ").slice(0, 2000),
        finalizadoEm: new Date(),
      },
    });
    logger.warn({ conversa, pedido: pedido.id }, "presente de aniversário: aviso à equipe não saiu");
    return {
      registrado: false,
      erro: "Não consegui avisar a equipe por WhatsApp, então o pedido não foi registrado.",
      comoSeguir: PASSE_PARA_A_EQUIPE,
    };
  }

  try {
    await robo.enviarMensagem(
      conversa,
      notaDePedido({ pedido: resumo, aniversario: janela.aniversario, avisados, venceEm: prazo }),
      { privado: true },
    );
  } catch (erro) {
    rastro.push("nota interna não foi gravada");
    logger.warn({ conversa, erro }, "presente de aniversário: nota interna não foi gravada");
  }

  await db.presenteDeAniversario.update({
    where: { id: pedido.id },
    data: { resultado: rastro.join(" · ").slice(0, 2000) },
  });

  return {
    registrado: true,
    reservaPedida: {
      sala: resumo.salaNome ?? String(resumo.salaId),
      data: entrada.data,
      inicio: entrada.inicio,
      fim: entrada.fim,
    },
    observacao:
      "NÃO reserve nem fature: a equipe libera o pacote, e o sistema faz a reserva e manda a confirmação ao cliente nesta conversa. Diga ao cliente que o presente está sendo liberado e que a confirmação da reserva chega por aqui — sem prometer em quanto tempo.",
  };
}
