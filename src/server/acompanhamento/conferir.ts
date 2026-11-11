import { IntegrationProvider } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import { clienteDeLeitura, clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import { portaDaCaixa } from "@/server/integrations/chatwoot/porta";
import { resolverAtendente } from "@/server/integrations/chatwoot/atendentes";
import { opcoesDeAusencia } from "@/server/integrations/chatwoot/ausencias-config";
import { abrirClickUp } from "@/server/integrations/clickup/sistema";
import { abrirConexa } from "@/server/integrations/conexa/sistema";
import type { ClickUpClient } from "@/server/integrations/clickup/client";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";
import {
  abrirZapSignCru,
  anexarContratoAssinado,
  type ZapSignAberta,
} from "./anexo";

import {
  cobrancaDoContratoNoConexa,
  cobrancaPaga,
  type LeitorDeCobrancas,
} from "@/server/integrations/conexa/cobranca-do-contrato";
import {
  faturarPrimeiraCobranca,
  type FaturadorDeContrato,
} from "@/server/integrations/conexa/primeira-cobranca";
import {
  contratacaoDaTask,
  documentoAssinado,
  documentoExcluido,
  type Chamada,
  type Contratacao,
} from "./contratacao";
import {
  CAIXA_DO_CLIENTE,
  escolherConversa,
  ultimaFala,
  ultimoAtendente,
  type FalaDaConversa,
} from "./conversa";
import {
  aindaNoCiclo,
  chaveDaEtapa,
  comentarioDaEtapa,
  CONFERIR_A_CADA_MS,
  etapaAEnviar,
  ETIQUETA_ASSINATURA,
  ETIQUETA_PAGAMENTO,
  LISTA_BASE_DE_CLIENTES,
  mensagemDaEtapa,
  notaParaOVendedor,
  podeFalar,
  PROVIDER_ACOMPANHAMENTO,
  STATUS_ALVO,
  STATUS_FINAL,
  TAREFAS_POR_RODADA,
  type Etapa,
} from "./regras";

/**
 * A rodada do Acompanhamento de Contratos — o "Agente 3" do Diego, feito como
 * rotina do sistema. O porquê e as travas estão em `regras.ts`.
 *
 * ⚠ **Nasce desligada** e só roda com a integração `ACOMPANHAMENTO` ligada:
 * ela manda mensagem a cliente dentro de uma conversa que está com um
 * vendedor, que é a exceção consciente desta capacidade.
 */

/** O `CELULAR` e o `RESPONSÁVEL` da Base de clientes. */
const CAMPO_CELULAR = "3399c6f6-c890-40a6-865e-5a4e810fe8c6";
const CAMPO_RESPONSAVEL = "feaf1d19-755e-4b84-850a-b1ad42ee5957";

/** Até onde a rodada olha para trás nas ferramentas que o Agente 2 usou. */
export const DIAS_PARA_TRAS = 60;

let ultimaConferencia = 0;
let rodando = false;

export type DesfechoDaTask = {
  taskId: string;
  cliente?: string;
  etapa?: Etapa;
  enviado?: boolean;
  motivo?: string;
};

export type RodadaDeAcompanhamento = {
  acao: "cedo" | "em andamento" | "desligada" | "sem clickup" | "conferido";
  motivo?: string;
  tarefas?: number;
  enviadas?: number;
  desfechos?: DesfechoDaTask[];
  erro?: string;
};

function campo(tarefa: ClickUpTarefa, id: string): string | null {
  const c = tarefa.custom_fields?.find((f) => f.id === id);
  return typeof c?.value === "string" && c.value.trim() ? c.value.trim() : null;
}

export async function acompanharContratos(
  opcoes: { forcar?: boolean } = {},
  agora = new Date(),
): Promise<RodadaDeAcompanhamento> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  rodando = true;
  ultimaConferencia = agora.getTime();

  try {
    const integracao = await db.integration.findUnique({
      where: { provider: IntegrationProvider.ACOMPANHAMENTO },
      select: { enabled: true },
    });
    if (!integracao?.enabled) return { acao: "desligada" };

    const clickup = await abrirClickUp("acompanhamento de contratos");
    if ("erro" in clickup) return { acao: "sem clickup", motivo: clickup.erro };

    const { tasks } = await clickup.cliente.listarTarefasDaLista(LISTA_BASE_DE_CLIENTES, {
      statuses: [STATUS_ALVO],
      tags: [ETIQUETA_PAGAMENTO, ETIQUETA_ASSINATURA],
    });

    const naFila = tasks.filter((t) =>
      aindaNoCiclo({
        status: t.status?.status ?? "",
        etiquetas: (t.tags ?? []).map((x) => x.name),
      }),
    );
    if (!naFila.length) {
      return await fechar(agora, { acao: "conferido", tarefas: 0, enviadas: 0, desfechos: [] });
    }

    // O que o Agente 2 gerou, lido de uma vez só para todas as tasks da fila.
    const chamadas = (await db.toolCall.findMany({
      where: {
        toolName: {
          in: [
            "clickup_obter_tarefa",
            "clickup_comentar_tarefa",
            "clickup_adicionar_tag",
            "zapsign_gerar_contrato",
            "zapsign_ver_documento",
            "conexa_criar_contrato",
          ],
        },
        isError: false,
        createdAt: { gte: new Date(agora.getTime() - DIAS_PARA_TRAS * 24 * 60 * 60_000) },
      },
      select: { runId: true, toolName: true, input: true, output: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    })) as Chamada[];

    // Abertos UMA vez por rodada: cada `abrir*` decifra credencial e lê a
    // configuração no banco, e isso não muda entre as tasks.
    const conexa = await abrirConexa("acompanhamento de contratos");
    const verDocumento = await abrirZapSign();
    const leitura: Leituras = {
      conexa: "erro" in conexa ? null : conexa.cliente,
      verDocumento,
      zapsign: await abrirZapSignCru(),
    };

    const desfechos: DesfechoDaTask[] = [];
    let enviadas = 0;

    for (const tarefa of naFila.slice(0, TAREFAS_POR_RODADA)) {
      try {
        const d = await tratarTask(tarefa, chamadas, clickup.cliente, leitura, agora);
        desfechos.push(d);
        if (d.enviado) enviadas++;
      } catch (erro) {
        desfechos.push({ taskId: tarefa.id, motivo: (erro as Error).message });
      }
    }

    return await fechar(agora, {
      acao: "conferido",
      tarefas: naFila.length,
      enviadas,
      desfechos,
    });
  } catch (erro) {
    logger.error({ erro }, "acompanhamento de contratos falhou");
    await registrarRodada(agora, "falhou", { erro: (erro as Error).message });
    throw erro;
  } finally {
    rodando = false;
  }
}

async function fechar(agora: Date, rodada: RodadaDeAcompanhamento) {
  await registrarRodada(agora, rodada.enviadas ? "enviado" : "nada a enviar", rodada);
  return rodada;
}

/** As etapas que já saíram para esta task, lidas das reservas. */
async function etapasJaEnviadas(taskId: string): Promise<Set<Etapa>> {
  const linhas = await db.webhookEvent.findMany({
    where: {
      provider: PROVIDER_ACOMPANHAMENTO,
      externalId: { endsWith: `:${taskId}` },
    },
    select: { externalId: true },
  });
  const etapas = new Set<Etapa>();
  for (const l of linhas) {
    const etapa = l.externalId.split(":")[0] as Etapa;
    if (["inicial", "pagamento", "assinatura", "final"].includes(etapa)) etapas.add(etapa);
  }
  return etapas;
}

/** O que a rodada abriu uma vez e usa em toda task. */
type Leituras = {
  conexa: (LeitorDeCobrancas & FaturadorDeContrato) | null;
  verDocumento: VerDocumento | null;
  /**
   * O cliente CRU da ZapSign, ao lado de `verDocumento`, que passa pela
   * ferramenta. Os dois existem porque a ferramenta não devolve `signed_file`
   * de propósito (a URL expira em 60 min e morreria na mão do modelo) — e é
   * justamente esse arquivo que vai para o campo da task.
   */
  zapsign: ZapSignAberta | null;
};

async function tratarTask(
  tarefa: ClickUpTarefa,
  chamadas: Chamada[],
  clickup: ClickUpClienteMinimo,
  leitura: Leituras,
  agora: Date,
): Promise<DesfechoDaTask> {
  const taskId = tarefa.id;
  const nome = campo(tarefa, CAMPO_RESPONSAVEL);
  const celular = campo(tarefa, CAMPO_CELULAR);

  const contratacao = contratacaoDaTask(chamadas, taskId);
  if (!contratacao.documentoZapSign && !contratacao.contratoConexa) {
    return { taskId, motivo: "não achei o contrato nem o documento gerados para esta task" };
  }

  const { pago, linkPagamento, assinado, assinaturaMorta } = await conferirEstado(
    contratacao,
    leitura,
  );
  const linkAssinatura = assinaturaMorta ? null : contratacao.linkAssinatura;
  const jaEnviadas = await etapasJaEnviadas(taskId);

  const etapa = etapaAEnviar(
    {
      pagamento: linkPagamento,
      assinatura: linkAssinatura,
      documentoZapSign: contratacao.documentoZapSign,
      contratoConexa: contratacao.contratoConexa,
    },
    { pago, assinado },
    jaEnviadas,
  );

  if (!etapa) {
    const falta = !linkPagamento
      ? "aguardando a cobrança do contrato no Conexa"
      : !linkAssinatura
        ? assinaturaMorta
          ? "o documento da ZapSign foi excluído — esperando um novo"
          : "aguardando o link de assinatura"
        : "sem novidade: nada a enviar";
    return { taskId, cliente: nome ?? undefined, motivo: falta };
  }

  if (!celular) {
    return { taskId, cliente: nome ?? undefined, etapa, motivo: "a task está sem CELULAR" };
  }

  return await falarComOCliente({
    taskId,
    tarefa,
    etapa,
    nome,
    celular,
    linkPagamento,
    linkAssinatura,
    clickup,
    documentoZapSign: contratacao.documentoZapSign,
    zapsign: leitura.zapsign,
    agora,
  });
}

/** Pagamento no Conexa e assinatura na ZapSign — as duas leituras da rodada. */
async function conferirEstado(contratacao: Contratacao, leitura: Leituras) {
  let pago = false;
  let linkPagamento: string | null = null;
  let assinado = false;

  if (leitura.conexa && contratacao.contratoConexa && contratacao.clienteConexa) {
    const achado = await cobrancaDoContratoNoConexa(
      leitura.conexa,
      contratacao.clienteConexa,
      contratacao.contratoConexa,
    );
    if (achado) {
      pago = cobrancaPaga(achado.status);
      linkPagamento = achado.faturaUrl;
    } else {
      // ⚠ Rede de segurança do faturamento: o Conexa gera a VENDA do contrato
      // sozinho, mas não a cobrança, e é ela que tem o link que o cliente
      // paga. `conexa_criar_contrato` já tenta no instante da criação; se a
      // venda ainda não tinha aparecido lá, a tentativa é aqui — senão a
      // contratação fica esperando uma cobrança que ninguém vai gerar.
      const faturado = await faturarPrimeiraCobranca(
        leitura.conexa,
        contratacao.clienteConexa,
        contratacao.contratoConexa,
      );
      if (faturado.feito === "criada" || faturado.feito === "jaExistia") {
        linkPagamento = faturado.faturaUrl;
      }
    }
  }

  // ⚠ Documento excluído na ZapSign continua devolvendo `pending` e o link do
  // signatário; mandá-lo ao cliente é mandar um link que não abre.
  let assinaturaMorta = false;
  if (leitura.verDocumento && contratacao.documentoZapSign) {
    const doc = await leitura.verDocumento(contratacao.documentoZapSign);
    if (doc) {
      assinado = documentoAssinado(doc);
      assinaturaMorta = documentoExcluido(doc);
    }
  }

  return { pago, linkPagamento, assinado, assinaturaMorta };
}

/**
 * A cobrança daquele contrato.
 *
 * ⚠ **O vínculo é cobrança → venda → contrato.** Um cliente com dois produtos
 * tem duas cobranças contratuais abertas, e mandar a do outro produto seria
 * cobrar o valor errado. É o mesmo caminho das notas fiscais. O teto de
 * consultas existe porque cada venda é uma ida ao ERP.
 */
type VerDocumento = (
  documentoId: string,
) => Promise<{ status?: string | null; signatarios?: Array<{ situacao?: string | null }> | null } | null>;

/** O cliente da ZapSign, já pronto para detalhar um documento. */
async function abrirZapSign() {
  const { zapsignIntegration } = await import("@/server/integrations/zapsign");
  const integracao = await db.integration.findUnique({
    where: { provider: IntegrationProvider.ZAPSIGN },
    include: { credential: true },
  });
  if (!integracao?.enabled || !integracao.credential) return null;

  const ferramenta = zapsignIntegration.tools.find((t) => t.name === "zapsign_ver_documento");
  if (!ferramenta) return null;

  const { decifrar } = await import("@/lib/crypto");
  let credential: string;
  try {
    credential = decifrar(integracao.credential);
  } catch {
    return null;
  }

  return async (documentoId: string) => {
    try {
      return (await ferramenta.execute(
        { documentoId },
        {
          provider: IntegrationProvider.ZAPSIGN,
          config: integracao.config as Record<string, unknown>,
          credential,
          agentId: "sistema-acompanhamento",
        },
      )) as { status?: string | null; signatarios?: Array<{ situacao?: string | null }> | null };
    } catch {
      return null;
    }
  };
}

/**
 * O passo que fala com o cliente — e as travas antes de falar.
 *
 * A ordem é a mais segura possível: reserva, mensagem, nota para o vendedor,
 * comentário na task e só então etiqueta e status. Se a mensagem não sai, a
 * reserva é desfeita e nada mais acontece; a etiqueta continua lá e a rodada
 * seguinte tenta de novo.
 */
async function falarComOCliente(args: {
  taskId: string;
  tarefa: ClickUpTarefa;
  etapa: Etapa;
  nome: string | null;
  celular: string;
  linkPagamento: string | null;
  linkAssinatura: string | null;
  clickup: ClickUpClienteMinimo;
  /** Só a etapa final usa: é com eles que o contrato assinado vai para o campo. */
  documentoZapSign: string | null;
  zapsign: ZapSignAberta | null;
  agora: Date;
}): Promise<DesfechoDaTask> {
  const { taskId, etapa, nome, celular, agora } = args;

  const leitor = await clienteDeLeitura();
  if (!leitor) return { taskId, etapa, motivo: "o Chatwoot está sem token de leitura" };

  const alvo = await acharConversa(leitor.cliente, celular);
  if ("motivo" in alvo) return { taskId, etapa, cliente: nome ?? undefined, motivo: alvo.motivo };

  const mensagens = (await leitor.cliente.listarMensagens(alvo.conversaId)) as FalaDaConversa[];

  // ⚠ **Reabrir vem ANTES de `podeFalar`**, e a ordem não é detalhe: aquela
  // função recusa conversa resolvida, então pedir permissão primeiro tornaria
  // o caminho de reabertura inalcançável — a conversa fechada nunca voltaria
  // ao vendedor, e o cliente nunca receberia o lembrete.
  let status = alvo.status;
  if (alvo.precisaReabrir) {
    const problema = await reabrirEDevolver(leitor.cliente, alvo.conversaId, mensagens);
    if (problema) return { taskId, etapa, cliente: nome ?? undefined, motivo: problema };
    status = "open";
  }

  const permissao = podeFalar({ status, ultimaMensagem: ultimaFala(mensagens) }, agora);
  if (!permissao.pode) {
    return { taskId, etapa, cliente: nome ?? undefined, motivo: permissao.motivo };
  }

  const porta = await portaDaCaixa(alvo.conversaId, CAIXA_DO_CLIENTE);
  const escritor = (porta ? await clienteDoAgente(porta) : null) ?? leitor.cliente;

  const chave = chaveDaEtapa(taskId, etapa);
  let reservaId: string;
  try {
    const linha = await db.webhookEvent.create({
      data: {
        provider: PROVIDER_ACOMPANHAMENTO,
        externalId: chave,
        eventType: "acompanhamento",
        payload: {},
        resultado: "reservado",
      },
      select: { id: true },
    });
    reservaId = linha.id;
  } catch {
    return { taskId, etapa, motivo: "já reservada por outra rodada" };
  }

  try {
    await escritor.enviarMensagem(
      alvo.conversaId,
      mensagemDaEtapa(etapa, {
        nome: nome ?? "",
        linkPagamento: args.linkPagamento,
        linkAssinatura: args.linkAssinatura,
      }),
    );
  } catch (erro) {
    await db.webhookEvent.delete({ where: { id: reservaId } }).catch(() => {});
    return { taskId, etapa, cliente: nome ?? undefined, motivo: `não consegui enviar: ${(erro as Error).message}` };
  }

  const problemas: string[] = [];

  // A nota é o que torna a exceção honesta: quem está com a conversa vê que o
  // sistema falou, o quê, e que a conversa continua com ele.
  await escritor
    .enviarMensagem(alvo.conversaId, notaParaOVendedor(etapa, args.tarefa.url ?? null), {
      privado: true,
    })
    .catch((e: Error) => problemas.push(`nota ao vendedor: ${e.message}`));

  await args.clickup
    .comentarTarefa(taskId, comentarioDaEtapa(etapa, agora))
    .catch((e: Error) => problemas.push(`comentário: ${e.message}`));

  // A etiqueta sai JUNTO com a mensagem, nunca antes: ela é a fila, e tirá-la
  // sem avisar o cliente tiraria a task do ciclo com a mensagem por mandar.
  for (const etiqueta of etiquetasASair(etapa)) {
    await args.clickup
      .removerTag(taskId, etiqueta)
      .catch((e: Error) => problemas.push(`etiqueta "${etiqueta}": ${e.message}`));
  }

  if (etapa === "final") {
    // ⚠ O anexo vem ANTES do status, e o status só anda se ele entrou. Uma
    // trava do ClickBot devolve a task de `ongoing` para `onboarding` quando o
    // campo "Contrato Assinado" está vazio — mover sem o anexo faria a task
    // quicar e esta entrega dizer "concluído" sobre algo que não concluiu.
    const anexo = await anexarContratoAssinado({
      clickup: args.clickup,
      zapsign: args.zapsign,
      taskId,
      documentoToken: args.documentoZapSign,
      cliente: nome,
    });

    if (anexo.feito === "falhou") {
      problemas.push(`contrato assinado no campo: ${anexo.motivo} — não movi o status`);
    } else {
      await args.clickup
        .atualizarTarefa(taskId, { status: STATUS_FINAL })
        .catch((e: Error) => problemas.push(`status: ${e.message}`));
    }
  }

  await db.webhookEvent
    .update({
      where: { id: reservaId },
      data: {
        resultado: problemas.length ? "enviado com pendência" : "enviado",
        detalhe: JSON.stringify({ conversa: alvo.conversaId, problemas }).slice(0, 2000),
        processedAt: agora,
      },
    })
    .catch(() => {});

  return {
    taskId,
    cliente: nome ?? undefined,
    etapa,
    enviado: true,
    motivo: problemas.length ? problemas.join(" · ") : undefined,
  };
}

type ClickUpClienteMinimo = {
  comentarTarefa: (taskId: string, texto: string) => Promise<unknown>;
  removerTag: (taskId: string, tag: string) => Promise<unknown>;
  atualizarTarefa: (taskId: string, dados: { status?: string }) => Promise<unknown>;
} & Pick<ClickUpClient, "obterTarefa" | "enviarArquivoParaCampo" | "associarAnexoAoCampo">;

function etiquetasASair(etapa: Etapa): string[] {
  if (etapa === "pagamento") return [ETIQUETA_PAGAMENTO];
  if (etapa === "assinatura") return [ETIQUETA_ASSINATURA];
  if (etapa === "final") return [ETIQUETA_PAGAMENTO, ETIQUETA_ASSINATURA];
  return [];
}

/** A conversa do cliente na caixa do WhatsApp oficial. */
async function acharConversa(
  cliente: ChatwootClient,
  celular: string,
): Promise<{ conversaId: number; status: string; precisaReabrir: boolean } | { motivo: string }> {
  const termo = celular.replace(/\D/g, "").slice(-8);
  if (termo.length < 8) return { motivo: "o CELULAR da task não tem número suficiente" };

  const contatos = await cliente.buscarContatos(termo);
  const { escolherContato } = await import("@/server/alerta-de-saldo/conversa");
  const contato = escolherContato(contatos, celular, CAIXA_DO_CLIENTE);
  if (!contato) return { motivo: "não achei o contato desse número no Chatwoot" };

  const escolha = escolherConversa(await cliente.conversasDoContato(contato.id));
  if (!escolha) return { motivo: "o contato não tem conversa na caixa do WhatsApp" };

  return {
    conversaId: escolha.conversa.id,
    status: escolha.conversa.status ?? "open",
    precisaReabrir: escolha.precisaReabrir,
  };
}

/** Reabre a conversa e devolve a quem atendia. Devolve o motivo quando falha. */
async function reabrirEDevolver(
  cliente: ChatwootClient,
  conversaId: number,
  mensagens: FalaDaConversa[],
): Promise<string | null> {
  const nome = ultimoAtendente(mensagens);
  if (!nome) return "a conversa está resolvida e não achei quem atendeu por último";

  try {
    await cliente.alternarStatus(conversaId, "open");
  } catch (erro) {
    return `não consegui reabrir a conversa: ${(erro as Error).message}`;
  }

  try {
    const atendentes = await cliente.listarAtendentes();
    const alvo = resolverAtendente(nome, atendentes, await opcoesDeAusencia());
    if (alvo.tipo !== "achado") return `não achei "${nome}" entre os atendentes do Chatwoot`;
    await cliente.atribuir(conversaId, { assigneeId: alvo.atendente.id });
  } catch (erro) {
    return `não consegui devolver a conversa: ${(erro as Error).message}`;
  }

  return null;
}

async function registrarRodada(agora: Date, resultado: string, detalhe: unknown) {
  try {
    const dia = diaEmSaoPaulo(agora);
    await db.webhookEvent.upsert({
      where: {
        provider_externalId: {
          provider: PROVIDER_ACOMPANHAMENTO,
          externalId: `rodada:${dia}`,
        },
      },
      create: {
        provider: PROVIDER_ACOMPANHAMENTO,
        externalId: `rodada:${dia}`,
        eventType: "rodada",
        payload: {},
        resultado,
        detalhe: JSON.stringify(detalhe).slice(0, 2000),
        processedAt: agora,
      },
      update: {
        resultado,
        detalhe: JSON.stringify(detalhe).slice(0, 2000),
        processedAt: agora,
      },
    });
  } catch (erro) {
    logger.error({ erro }, "não consegui registrar a rodada do acompanhamento");
  }
}

/** As últimas rodadas, para o MCP e a tela. */
export async function ultimasRodadasDoAcompanhamento(limite = 5) {
  return db.webhookEvent.findMany({
    where: { provider: PROVIDER_ACOMPANHAMENTO, externalId: { startsWith: "rodada:" } },
    select: { externalId: true, resultado: true, detalhe: true, processedAt: true },
    orderBy: { createdAt: "desc" },
    take: limite,
  });
}
