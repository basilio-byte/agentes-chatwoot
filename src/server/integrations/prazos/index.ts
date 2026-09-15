import { z } from "zod";
import {
  IntegrationProvider,
  PrazoTipo,
  RunSource,
} from "@/generated/prisma/enums";
import { formatarData } from "@/lib/utils";
import type { IntegrationDefinition, ToolContext } from "../types";
import { clienteDoAgente } from "../chatwoot/credenciais";
import { resolverAtendente } from "../chatwoot/atendentes";
import { humanidadeDoDono, podeAgir } from "../chatwoot/regras";
import { referenciaDasMensagens } from "@/server/prazos/decisao";
import { jaVoltouParaOAgente, registrarPrazo } from "@/server/prazos/registrar";

/**
 * Prazos da conversa — o agente registra, o vigia executa.
 *
 * Provider próprio, e não duas tools a mais na integração do Chatwoot, para ser
 * OPT-IN: tool nova no Chatwoot aparece para todo agente com as ferramentas dele
 * liberadas (foi o que aconteceu com a chamada interna em 14/09/2026), e um
 * modelo que nunca devia registrar prazo passaria a poder. Aqui, só quem tem a
 * integração ligada na própria tela enxerga as duas.
 *
 * Toda a garantia de não se meter em atendimento de pessoa mora na execução
 * (`prazos/decisao.ts`), que confere o Chatwoot ao vivo no vencimento. O que
 * as tools conferem na hora do registro é só se o prazo faz sentido agora.
 */

function foraDoAtendimento(ctx: ToolContext): string | null {
  if (ctx.source !== RunSource.CHATWOOT || !ctx.chatwootConversationId) {
    return "Prazo só existe num atendimento do Chatwoot — nada foi registrado.";
  }
  return null;
}

export const prazosIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.PRAZOS,
  label: "Prazos da conversa",
  descricao:
    "O agente registra um prazo na conversa (esperar a equipe ou o cliente responder) e o worker age no vencimento, depois de conferir o Chatwoot ao vivo.",
  configSchema: z.object({}),
  credentialLabel: null,

  async testarConexao() {
    return {
      ok: true,
      mensagem:
        "Não há o que testar: os prazos usam o Chatwoot do próprio agente e rodam no worker, no mesmo relógio do vigia.",
    };
  },

  tools: [
    {
      name: "prazo_resposta_da_equipe",
      categoria: "Prazos",
      description:
        'Registra um prazo para a EQUIPE responder. Use logo depois de entregar a conversa a uma pessoa, e só quando as suas instruções mandarem esperar a resposta dela. Se ninguém da equipe escrever nesta conversa em N minutos, o sistema faz UMA coisa, sempre com nota interna: passa a conversa para a pessoa indicada (acao "reatribuir") ou devolve a conversa a VOCÊ, que retoma o atendimento sozinho sem o cliente precisar escrever (acao "voltar_para_o_agente"). Se alguém da equipe escrever antes (inclusive nota interna), outra pessoa assumir ou a conversa for resolvida, o prazo cai sozinho. Nada é enviado ao cliente no registro.',
      requiresConfirmation: true,
      inputSchema: z.object({
        minutos: z
          .number()
          .int()
          .min(1)
          .max(240)
          .describe("Quantos minutos esperar, a partir de agora."),
        acao: z
          .enum(["reatribuir", "voltar_para_o_agente"])
          .optional()
          .describe(
            'O que acontece se ninguém responder. "reatribuir" (padrão): passa para reatribuirPara. "voltar_para_o_agente": a conversa volta para você.',
          ),
        reatribuirPara: z
          .string()
          .min(2)
          .optional()
          .describe(
            'Só com acao "reatribuir": quem assume se ninguém responder — o nome como está no Chatwoot.',
          ),
        motivo: z
          .string()
          .min(5)
          .describe("Por que o prazo existe, em uma frase. Vai na nota interna se ele vencer."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          minutos: number;
          acao?: "reatribuir" | "voltar_para_o_agente";
          reatribuirPara?: string;
          motivo: string;
        };
        const voltar = args.acao === "voltar_para_o_agente";

        const fora = foraDoAtendimento(ctx);
        if (fora) return { registrado: false, erro: fora };

        if (!voltar && !args.reatribuirPara?.trim()) {
          return {
            registrado: false,
            erro: 'Informe reatribuirPara, ou use acao "voltar_para_o_agente" para a conversa voltar para você.',
          };
        }

        const porta = ctx.canalAgentId ?? ctx.agentId;
        const cliente = await clienteDoAgente(porta);
        if (!cliente) {
          throw new Error("Bot do Chatwoot não configurado para o canal desta conversa.");
        }

        const conversa = ctx.chatwootConversationId!;
        const [aoVivo, mensagens, atendentes] = await Promise.all([
          cliente.obterConversa(conversa),
          cliente.listarMensagens(conversa),
          cliente.listarAtendentes(),
        ]);

        if (aoVivo.assigneeId == null || humanidadeDoDono(aoVivo.assigneeTipo) !== true) {
          return {
            registrado: false,
            erro: "A conversa não está com uma pessoa agora. Entregue a conversa primeiro e só depois registre o prazo.",
          };
        }

        let nomeDestino: string | null = null;
        if (voltar) {
          if (await jaVoltouParaOAgente(conversa)) {
            return {
              registrado: false,
              erro: 'Esta conversa já voltou para você uma vez neste atendimento, e não volta de novo. Se as suas instruções mandarem esperar a equipe outra vez, use acao "reatribuir" com reatribuirPara.',
            };
          }
        } else {
          const destino = resolverAtendente(args.reatribuirPara!, atendentes);
          if (destino.tipo === "nenhum") {
            return {
              registrado: false,
              erro: `Não achei "${args.reatribuirPara}" na equipe.`,
              atendentes: destino.disponiveis,
            };
          }
          if (destino.tipo === "ambiguo") {
            return {
              registrado: false,
              erro: `"${args.reatribuirPara}" corresponde a mais de uma pessoa. Use o nome completo.`,
              candidatos: destino.candidatos,
            };
          }
          if (destino.atendente.id === aoVivo.assigneeId) {
            return {
              registrado: false,
              erro: "Essa pessoa já é a dona da conversa — o prazo não teria para quem passar.",
            };
          }
          nomeDestino = destino.atendente.name?.trim() || args.reatribuirPara!;
        }

        const dono = atendentes.find((a) => a.id === aoVivo.assigneeId);
        const prazo = await registrarPrazo({
          tipo: PrazoTipo.EQUIPE,
          chatwootConversationId: conversa,
          agentId: ctx.agentId,
          portaAgentId: porta,
          minutos: args.minutos,
          referenciaMensagemId: referenciaDasMensagens(mensagens),
          donoId: aoVivo.assigneeId,
          donoNome: dono?.name?.trim() ?? null,
          acao: voltar
            ? { tipo: "voltar_para_o_agente" }
            : { tipo: "reatribuir", atendente: nomeDestino! },
          motivo: args.motivo,
        });

        return {
          registrado: true,
          venceEm: formatarData(prazo.venceEm),
          observacao: voltar
            ? "Se ninguém da equipe escrever nesta conversa até lá, ela volta para você, com nota interna, e o sistema te aciona para retomar o atendimento sozinho — sem o cliente precisar escrever. Nada aparece para o cliente agora. Siga as suas instruções."
            : `Se ninguém da equipe escrever nesta conversa até lá, ela passa para ${nomeDestino}, com nota interna. Nada aparece para o cliente. Siga as suas instruções.`,
        };
      },
    },

    {
      name: "prazo_resposta_do_cliente",
      categoria: "Prazos",
      description:
        'Registra um prazo para o CLIENTE responder. Use no fim do seu turno, depois de fazer uma pergunta, e só quando as suas instruções mandarem agir se ele não responder em N minutos. Se o cliente escrever antes, o prazo cai sozinho; chamar de novo troca o prazo anterior. Se vencer, o sistema faz UMA coisa: manda a mensagem que você deixou (acao "mensagem") ou entrega a conversa à pessoa indicada, com o aviso (acao "atribuir"). Se uma pessoa da equipe assumir ou escrever na conversa, nada acontece.',
      requiresConfirmation: true,
      inputSchema: z.object({
        minutos: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .describe("Quantos minutos de silêncio do cliente, a partir de agora."),
        acao: z
          .enum(["mensagem", "atribuir"])
          .describe('"mensagem": manda o texto ao cliente. "atribuir": entrega a uma pessoa, com o texto como aviso.'),
        texto: z
          .string()
          .min(5)
          .describe("O que o CLIENTE vai ler no vencimento: a mensagem de retomada, ou o aviso da passagem."),
        atendente: z
          .string()
          .optional()
          .describe('Só com acao "atribuir": quem assume, o nome como está no Chatwoot.'),
        motivo: z
          .string()
          .min(5)
          .describe("Por que o prazo existe, em uma frase. Vai em nota interna."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          minutos: number;
          acao: "mensagem" | "atribuir";
          texto: string;
          atendente?: string;
          motivo: string;
        };

        const fora = foraDoAtendimento(ctx);
        if (fora) return { registrado: false, erro: fora };

        if (args.acao === "atribuir" && !args.atendente?.trim()) {
          return {
            registrado: false,
            erro: 'Com acao "atribuir", informe o atendente.',
          };
        }

        const porta = ctx.canalAgentId ?? ctx.agentId;
        const cliente = await clienteDoAgente(porta);
        if (!cliente) {
          throw new Error("Bot do Chatwoot não configurado para o canal desta conversa.");
        }

        const conversa = ctx.chatwootConversationId!;
        const [aoVivo, mensagens] = await Promise.all([
          cliente.obterConversa(conversa),
          cliente.listarMensagens(conversa),
        ]);

        const veredito = podeAgir({
          status: aoVivo.status,
          assigneeId: aoVivo.assigneeId,
          donoEhHumano: humanidadeDoDono(aoVivo.assigneeTipo),
        });
        if (!veredito.pode) {
          return {
            registrado: false,
            erro: `O prazo do cliente só vale com a conversa com o bot (${veredito.motivo}).`,
          };
        }

        let nomeDestino: string | null = null;
        if (args.acao === "atribuir") {
          const destino = resolverAtendente(args.atendente!, await cliente.listarAtendentes());
          if (destino.tipo === "nenhum") {
            return {
              registrado: false,
              erro: `Não achei "${args.atendente}" na equipe.`,
              atendentes: destino.disponiveis,
            };
          }
          if (destino.tipo === "ambiguo") {
            return {
              registrado: false,
              erro: `"${args.atendente}" corresponde a mais de uma pessoa. Use o nome completo.`,
              candidatos: destino.candidatos,
            };
          }
          nomeDestino = destino.atendente.name?.trim() || args.atendente!;
        }

        const prazo = await registrarPrazo({
          tipo: PrazoTipo.CLIENTE,
          chatwootConversationId: conversa,
          agentId: ctx.agentId,
          portaAgentId: porta,
          minutos: args.minutos,
          referenciaMensagemId: referenciaDasMensagens(mensagens),
          donoId: null,
          donoNome: null,
          acao:
            args.acao === "atribuir"
              ? { tipo: "atribuir", atendente: nomeDestino!, aviso: args.texto }
              : { tipo: "mensagem", texto: args.texto },
          motivo: args.motivo,
        });

        return {
          registrado: true,
          venceEm: formatarData(prazo.venceEm),
          observacao:
            args.acao === "atribuir"
              ? `Se o cliente não responder até lá, ele recebe o aviso e a conversa passa para ${nomeDestino}. Se responder antes, nada acontece. Termine o seu turno normalmente.`
              : "Se o cliente não responder até lá, ele recebe a mensagem de retomada, uma vez só. Se responder antes, nada acontece. Termine o seu turno normalmente.",
        };
      },
    },
  ],
};
