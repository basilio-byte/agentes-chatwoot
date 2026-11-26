import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { EventoDeConversa, IntegrationProvider, RunSource } from "@/generated/prisma/enums";
import { ehInterrupcao } from "@/server/agents/cancelamento";
import { executarAgente } from "@/server/agents/runner";
import { ehSemCredito, MOTIVO_SEM_CREDITO } from "@/server/agents/sem-credito";
import { montarTranscricao, quandoCompleto, quemAtendeu } from "@/server/conversa-encerrada/ciclo";
import { lerAtendimento } from "@/server/conversa-encerrada/leitura";
import { recortarAtendimentoAtual } from "@/server/conversa-marcada/recorte";
import { clienteDeLeitura } from "@/server/integrations/chatwoot/credenciais";
import { humanidadeDoDono } from "@/server/integrations/chatwoot/regras";
import {
  AGENTE_DO_CRM_DE_SUPORTE,
  chaveDoLead,
  CONFERIR_A_CADA_MS,
  contarTasks,
  decidirRegistro,
  ESPERA_MS,
  lerConfigDoLead,
  mensagemDoLead,
  POR_RODADA,
  PROVIDER_LEAD,
  REGISTROS_POR_RODADA,
  type ConfigDoLead,
} from "./regras";

/**
 * O registro automático do lead no CRM Comercial (regras em `regras.ts`).
 *
 * Duas pontas, como a limpeza do contato:
 * - **Na passagem** (worker do atendimento), `registrarLeadPendente` grava uma
 *   linha `pendente` em `WebhookEvent` (provider `LEAD_CRM`) quando o robô passa a
 *   conversa a um agente comercial. A unique da linha segura uma por atendimento.
 * - **No vigia**, `conferirLeadsNoCrm` olha as pendentes ao vivo e, com uma pessoa
 *   da equipe dona da conversa e nenhuma task, aciona o agente de CRM pelo mesmo
 *   caminho do checkbox. A rodada só é INICIADA pelo vigia: cada registro é uma
 *   execução do modelo de ~40 s, e o vigia não pode esperar por ela.
 *
 * O rastro (`resultado` e `detalhe` da linha) nunca leva nome nem telefone:
 * Entregas e o MCP são lidos pela equipe inteira.
 */

async function configAtual(): Promise<ConfigDoLead> {
  const registro = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CHATWOOT },
    select: { config: true },
  });
  return lerConfigDoLead(registro?.config);
}

/**
 * Na passagem para um agente: marca o lead para conferir em 3 min. Nunca lança —
 * o atendimento do cliente não pode cair por causa de um registro.
 */
export async function registrarLeadPendente(args: {
  chatwootConversationId: number;
  inboxId: number | null | undefined;
  agenteKey: string;
  atendimentoDesde: Date | null | undefined;
}): Promise<boolean> {
  try {
    const config = await configAtual();
    if (config.modo === "desligado" || !config.agentes.includes(args.agenteKey)) return false;
    await db.webhookEvent.create({
      data: {
        provider: PROVIDER_LEAD,
        externalId: chaveDoLead(args.chatwootConversationId, args.atendimentoDesde ?? null),
        eventType: `lead #${args.chatwootConversationId} passou para ${args.agenteKey}`,
        // Sem nome nem telefone.
        payload: {
          conversa: args.chatwootConversationId,
          inbox: args.inboxId ?? null,
          agente: args.agenteKey,
          desde: args.atendimentoDesde?.toISOString() ?? null,
        },
        resultado: "pendente",
      },
    });
    return true;
  } catch (erro) {
    const conflito =
      typeof erro === "object" && erro !== null && (erro as { code?: string }).code === "P2002";
    // Conflito é o segundo agente comercial do mesmo atendimento: já está na fila.
    if (!conflito) {
      logger.warn({ erro, conversa: args.chatwootConversationId }, "lead no CRM: não registrei o pendente");
    }
    return false;
  }
}

let ultimaConferencia = 0;
let rodando = false;

export type RodadaDoLead = {
  acao: "cedo" | "em andamento" | "desligada" | "iniciada";
};

export type ResultadoDaRodada = {
  olhadas: number;
  registradas: number;
  sombra: number;
  encerradas: number;
  esperando: number;
  falhas: number;
};

/**
 * Chamada pelo vigia a cada minuto. Confere de fato a cada `CONFERIR_A_CADA_MS`
 * e só INICIA a rodada, que roda em segundo plano com a trava `rodando`.
 */
export async function conferirLeadsNoCrm(
  agora = new Date(),
  opcoes: { forcar?: boolean } = {},
): Promise<RodadaDoLead> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  ultimaConferencia = agora.getTime();
  // Antes de qualquer `await`: duas chamadas no mesmo instante não começam duas.
  rodando = true;
  try {
    const config = await configAtual();
    if (config.modo === "desligado") {
      rodando = false;
      return { acao: "desligada" };
    }
    void rodar(agora, config)
      .then((r) => {
        if (r.registradas || r.sombra || r.falhas) logger.info(r, "lead no CRM: rodada");
      })
      .catch((erro) => logger.error({ erro }, "lead no CRM: a rodada falhou"))
      .finally(() => {
        rodando = false;
      });
    return { acao: "iniciada" };
  } catch (erro) {
    rodando = false;
    throw erro;
  }
}

/** Só para teste: esquece o relógio e a trava entre um caso e outro. */
export function reiniciarRelogioDoLead() {
  ultimaConferencia = 0;
  rodando = false;
}

type Pendente = { id: string; payload: unknown; createdAt: Date };
type DadosDoPendente = {
  conversa?: number;
  inbox?: number | null;
  agente?: string;
  desde?: string | null;
};

/** A rodada inteira. Exportada para o teste chamá-la sem o relógio do vigia. */
export async function rodar(agora: Date, config: ConfigDoLead): Promise<ResultadoDaRodada> {
  const r: ResultadoDaRodada = {
    olhadas: 0,
    registradas: 0,
    sombra: 0,
    encerradas: 0,
    esperando: 0,
    falhas: 0,
  };

  const pendentes: Pendente[] = await db.webhookEvent.findMany({
    where: {
      provider: PROVIDER_LEAD,
      resultado: "pendente",
      createdAt: { lte: new Date(agora.getTime() - ESPERA_MS) },
    },
    // O que foi olhado há mais tempo primeiro: sem isto, as mesmas 30 que
    // continuam com o robô ocupariam a rodada para sempre.
    orderBy: [{ processedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: POR_RODADA,
    select: { id: true, payload: true, createdAt: true },
  });
  if (!pendentes.length) return r;

  const chatwoot = await clienteDeLeitura();
  if (!chatwoot) {
    logger.warn("lead no CRM: sem token de leitura do Chatwoot — nada conferido");
    return r;
  }

  const crm = await db.agent.findFirst({
    where: { key: config.agenteDoCrm, archivedAt: null },
    select: { id: true, name: true, active: true },
  });
  const gatilhoDoCrm = crm
    ? await db.gatilhoDeConversa.findFirst({
        where: { agentId: crm.id, evento: EventoDeConversa.ATRIBUTO_MARCADO },
        select: { contasDeAutomacao: true },
      })
    : null;
  const agentesPorId = new Map(
    (
      await db.agent.findMany({ select: { id: true, key: true, name: true } })
    ).map((a) => [a.id, a]),
  );

  for (const p of pendentes) {
    if (r.registradas + r.sombra >= REGISTROS_POR_RODADA) break;
    const dados = (p.payload ?? {}) as DadosDoPendente;
    const conversaId = Number(dados.conversa);

    // Trava: duas rodadas (ou réplicas) nunca tratam a mesma linha.
    const pego = await db.webhookEvent.updateMany({
      where: { id: p.id, resultado: "pendente" },
      data: { resultado: "conferindo" },
    });
    if (pego.count !== 1) continue;
    r.olhadas += 1;

    const fechar = (resultado: string, detalhe: string) =>
      db.webhookEvent.update({
        where: { id: p.id },
        data: { resultado, detalhe: detalhe.slice(0, 500), processedAt: new Date() },
      });
    const devolver = (detalhe: string) =>
      db.webhookEvent.update({
        where: { id: p.id },
        data: { resultado: "pendente", detalhe: detalhe.slice(0, 500), processedAt: new Date() },
      });

    try {
      if (!Number.isInteger(conversaId) || conversaId <= 0) {
        await fechar("falhou", "linha sem conversa");
        r.falhas += 1;
        continue;
      }

      const local = await db.conversation.findUnique({
        where: { chatwootConversationId: conversaId },
        select: { id: true, agentId: true, portaAgentId: true },
      });
      const desde = dados.desde ? new Date(dados.desde) : new Date(0);

      const [saidasDeTask, suporte] = local
        ? await Promise.all([
            db.toolCall.findMany({
              where: {
                toolName: "clickup_criar_tarefa",
                isError: false,
                createdAt: { gte: desde },
                run: { conversationId: local.id },
              },
              select: { output: true },
            }),
            db.toolCall.count({
              where: {
                toolName: "acionar_agente_interno",
                createdAt: { gte: desde },
                run: { conversationId: local.id },
                input: { path: ["agente"], equals: AGENTE_DO_CRM_DE_SUPORTE },
              },
            }),
          ])
        : [[], 0];

      const aoVivo = await chatwoot.cliente.obterConversa(conversaId);
      const donoEhPessoa =
        aoVivo.assigneeId == null ? null : humanidadeDoDono(aoVivo.assigneeTipo);
      const agenteAtual = local?.agentId ? agentesPorId.get(local.agentId) : undefined;

      const decisao = decidirRegistro({
        status: aoVivo.status,
        donoEhPessoa,
        tasksNaConversa: contarTasks(saidasDeTask.map((s) => s.output)),
        virouSuporte: suporte > 0,
        agenteComercial: !agenteAtual || config.agentes.includes(agenteAtual.key),
        idadeMs: agora.getTime() - p.createdAt.getTime(),
      });

      if (decisao.acao === "esperar") {
        await devolver(decisao.motivo);
        r.esperando += 1;
        continue;
      }
      if (decisao.acao === "encerrar") {
        await fechar(decisao.resultado, decisao.motivo);
        r.encerradas += 1;
        continue;
      }

      if (config.modo === "sombra") {
        await fechar(
          "sombra",
          `registraria no CRM agora: a conversa está com uma pessoa da equipe e sem task (agente ${dados.agente ?? "?"})`,
        );
        r.sombra += 1;
        continue;
      }

      if (!crm?.active) {
        await devolver(`o agente de CRM "${config.agenteDoCrm}" está desligado ou não existe`);
        r.falhas += 1;
        continue;
      }

      const contato =
        aoVivo.contactId != null ? await chatwoot.cliente.obterContato(aoVivo.contactId) : null;
      const contas = gatilhoDoCrm?.contasDeAutomacao ?? [];
      const atendimento = await lerAtendimento(chatwoot.cliente, conversaId, (mensagens) =>
        recortarAtendimentoAtual(mensagens, agora.getTime() / 1000),
      );

      try {
        const resultado = await executarAgente({
          agentId: crm.id,
          source: RunSource.CONVERSA_MARCADA,
          conversationId: local?.id,
          chatwootConversationId: conversaId,
          inboxId: dados.inbox ?? aoVivo.inboxId ?? undefined,
          // As notas do CRM saem pelo robô da caixa: ele não tem bot próprio.
          canalAgentId: local?.portaAgentId ?? undefined,
          mensagem: mensagemDoLead({
            conversationId: conversaId,
            link: `${chatwoot.config.baseUrl}/app/accounts/${chatwoot.config.accountId}/conversations/${conversaId}`,
            contatoNome: contato?.nome ?? null,
            telefone: contato?.telefone ?? null,
            dono: aoVivo.assigneeNome,
            agenteComercial:
              agentesPorId.get(local?.agentId ?? "")?.name ?? dados.agente ?? "agente comercial",
            atendentes: quemAtendeu(atendimento.mensagens, contas),
            transcricao: montarTranscricao(atendimento.mensagens, contas, atendimento.completa),
            quando: quandoCompleto(Math.floor(agora.getTime() / 1000)),
          }),
        });
        await fechar(
          "registrada",
          `run ${resultado.runId} · ${resultado.toolCalls.length} tool(s) · ${resultado.iteracoes} iteração(ões)`,
        );
        r.registradas += 1;
      } catch (erro) {
        r.falhas += 1;
        if (ehInterrupcao(erro)) {
          await fechar("interrompida", erro.message);
          continue;
        }
        if (ehSemCredito(erro)) {
          await fechar("falhou", MOTIVO_SEM_CREDITO);
          continue;
        }
        const motivo = erro instanceof Error ? erro.message : String(erro);
        const runId = (erro as { runId?: string } | undefined)?.runId;
        const jaExecutouTool = runId ? (await db.toolCall.count({ where: { runId } })) > 0 : false;
        // A task pode já estar no CRM: de novo seria task em dobro.
        if (jaExecutouTool) await fechar("falhou", `falhou depois de executar ferramenta: ${motivo}`);
        else await devolver(`falhou antes de qualquer ferramenta, tenta de novo: ${motivo}`);
      }
    } catch (erro) {
      // Chatwoot ou banco fora do ar antes do modelo: volta para a fila, e a
      // validade de 24 h segura o fim.
      r.falhas += 1;
      const motivo = erro instanceof Error ? erro.message : String(erro);
      logger.warn({ conversa: conversaId, erro: motivo }, "lead no CRM: falhou, tenta de novo");
      await devolver(`não consegui conferir: ${motivo}`).catch(() => {});
    }
  }

  return r;
}
