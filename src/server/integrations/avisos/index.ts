import { z } from "zod";
import { IntegrationProvider, RunSource } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { entregarAviso } from "@/server/alerta-de-saldo/conversa";
import {
  HORAS_SEM_REPETIR,
  TETO_DO_TEXTO,
  assinaturaDoTexto,
  carimbar,
  configAvisosSchema,
  escolherDestinatarios,
  jaAvisados,
  lerConfigAvisos,
  normalizarNome,
  semNumeros,
} from "@/server/avisos/regras";
import { clienteComTokenDeUsuario } from "@/server/integrations/chatwoot/credenciais";
import type { IntegrationDefinition } from "../types";

export const NOME_DA_FERRAMENTA = "avisar_equipe_whatsapp";

/**
 * Aviso à equipe por WhatsApp — `avisos/regras.ts` conta o porquê.
 *
 * Provider próprio, como os Prazos e o Aniversário, para ser OPT-IN por agente:
 * mandar mensagem ao celular de alguém é coisa que só o agente que precisa deve
 * enxergar. E a ferramenta não aceita número: só nome do cadastro.
 */
export const avisosIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.AVISOS,
  label: "Aviso à equipe (WhatsApp)",
  descricao:
    "O agente manda um recado curto por WhatsApp a pessoas da equipe cadastradas aqui, pela caixa do aviso. Ele escolhe entre os nomes do cadastro — número de fora não recebe nada.",
  configSchema: configAvisosSchema,
  credentialLabel: null,

  async testarConexao(ctx) {
    const config = lerConfigAvisos(ctx.config);
    if (!config.destinatarios.length) {
      return { ok: false, mensagem: "Falta cadastrar quem pode receber o aviso por WhatsApp." };
    }
    return {
      ok: true,
      mensagem: `Pode avisar ${config.destinatarios.map((d) => d.nome).join(", ")} pela caixa ${config.caixaId}.`,
    };
  },

  tools: [
    {
      name: NOME_DA_FERRAMENTA,
      categoria: "Aviso à equipe",
      description:
        "Manda um recado CURTO por WhatsApp a pessoas da EQUIPE da Seahub cadastradas no painel — nunca a cliente. Em `para`, os nomes como estão no cadastro (número de fora do cadastro não recebe nada); em `texto`, o recado em até 700 caracteres, com o link onde está o detalhe. O mesmo recado não sai duas vezes para a mesma pessoa em 12 h.",
      requiresConfirmation: true,
      inputSchema: z.object({
        para: z
          .array(z.string().min(2))
          .min(1)
          .max(10)
          .describe("Nomes das pessoas, como estão no cadastro do aviso à equipe."),
        texto: z
          .string()
          .min(10)
          .max(TETO_DO_TEXTO)
          .describe("O recado. Curto, em português, com o link do detalhe."),
      }),
      async execute(entrada, ctx) {
        const { para, texto } = entrada as { para: string[]; texto: string };
        const config = lerConfigAvisos(ctx.config);

        if (!config.destinatarios.length) {
          return {
            enviado: false,
            erro: "Ninguém está cadastrado para receber o aviso por WhatsApp. Avise que essa configuração está faltando (Integrações → Aviso à equipe) — não é algo que você possa resolver.",
          };
        }

        // ⚠ Nome fora do cadastro recusa o envio INTEIRO: mandar só a uma parte
        // e dizer que avisou "a equipe" seria afirmar o que não aconteceu.
        const escolha = escolherDestinatarios(para, config.destinatarios);
        if (escolha.naoAchados.length || escolha.ambiguos.length) {
          return {
            enviado: false,
            erro: "Nada foi enviado: corrija os nomes e chame de novo.",
            ...(escolha.naoAchados.length ? { naoEstaoNoCadastro: escolha.naoAchados } : {}),
            ...(escolha.ambiguos.length ? { casamComMaisDeUmaPessoa: escolha.ambiguos } : {}),
            cadastrados: config.destinatarios.map((d) => d.nome),
          };
        }

        const assinatura = assinaturaDoTexto(texto);
        const anteriores = await db.toolCall
          .findMany({
            where: {
              toolName: NOME_DA_FERRAMENTA,
              isError: false,
              createdAt: { gte: new Date(Date.now() - HORAS_SEM_REPETIR * 3_600_000) },
              run: { agentId: ctx.agentId },
            },
            orderBy: { createdAt: "desc" },
            take: 30,
            select: { output: true },
          })
          // Banco fora do ar não segura o aviso: o pior caso é um recado repetido.
          .catch(() => []);
        const avisados = jaAvisados(anteriores, assinatura);
        const pendentes = escolha.escolhidos.filter((d) => !avisados.has(normalizarNome(d.nome)));
        const repetidos = escolha.escolhidos
          .filter((d) => avisados.has(normalizarNome(d.nome)))
          .map((d) => d.nome);

        if (!pendentes.length) {
          return {
            enviado: false,
            jaAvisadosAntes: repetidos,
            observacao: `Esse mesmo recado já foi entregue a ${repetidos.join(", ")} nas últimas ${HORAS_SEM_REPETIR} h. Nada foi enviado de novo — não chame outra vez.`,
          };
        }

        const agente = await db.agent
          .findUnique({ where: { id: ctx.agentId }, select: { name: true } })
          .then((a) => a?.name ?? null)
          .catch(() => null);
        const mensagem = carimbar(texto, agente);

        // No playground o recado não sai: é ali que o operador testa o agente,
        // e cada teste tocaria o celular de alguém da equipe.
        if (ctx.source === RunSource.PLAYGROUND) {
          return {
            enviado: false,
            simulado: true,
            para: pendentes.map((d) => d.nome),
            mensagem,
            observacao: "No playground o WhatsApp NÃO sai: isto é o que seria enviado. Diga que foi simulado, não que avisou.",
          };
        }

        const cliente = await clienteComTokenDeUsuario();
        if (!cliente) {
          return {
            enviado: false,
            erro: "Falta o token de usuário em Integrações → Chatwoot, por onde o aviso sai. Avise que essa configuração está faltando.",
          };
        }

        const entregas = await entregarAviso(cliente, config.caixaId, pendentes, mensagem);
        const algum = entregas.some((e) => e.ok);

        return {
          enviado: algum,
          assinatura,
          entregas: entregas.map((e) => ({ nome: e.nome, ok: e.ok, detalhe: semNumeros(e.detalhe) })),
          ...(repetidos.length ? { jaAvisadosAntes: repetidos } : {}),
          observacao: algum
            ? "Entregue ao Chatwoot, que leva ao WhatsApp. Diga que o aviso foi enviado — não que a pessoa leu."
            : "Não saiu para ninguém. Diga que o aviso NÃO foi enviado, com o motivo.",
        };
      },
    },
  ],
};
