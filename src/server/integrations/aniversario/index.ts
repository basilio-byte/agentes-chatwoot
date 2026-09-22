import { z } from "zod";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition } from "../types";
import { configAniversarioSchema, lerConfigAniversario } from "@/server/aniversario/regras";
import { pedirPresente, type EntradaDoPedido } from "@/server/aniversario/pedir";

/**
 * Presente de aniversário — o agente registra, a equipe lança o pacote no
 * Conexa, o vigia reserva (`aniversario/regras.ts` conta o porquê).
 *
 * Provider próprio, como os Prazos e os Materiais, para ser OPT-IN por agente:
 * só quem tem a integração ligada na própria tela enxerga a ferramenta. E a
 * ferramenta não reserva nada — quem reserva é o sistema, depois de a venda do
 * pacote aparecer paga.
 */
export const aniversarioIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.ANIVERSARIO,
  label: "Presente de aniversário",
  descricao:
    "O cliente que recebeu o e-mail de aniversário pede as 2 h de sala; o agente confere o cadastro e registra, a equipe lança e fatura o pacote no Conexa, e o sistema reserva e confirma sozinho.",
  configSchema: configAniversarioSchema,
  credentialLabel: null,

  async testarConexao(ctx) {
    const config = lerConfigAniversario(ctx.config);
    if (!config.avisar.length) {
      return { ok: false, mensagem: "Falta cadastrar quem recebe o aviso por WhatsApp." };
    }
    return {
      ok: true,
      mensagem: `Avisa ${config.avisar.map((d) => d.nome).join(", ")} pela caixa ${config.caixaDoAviso}; sem o pacote pago em ${config.prazoHoras} h, a conversa vai para ${config.atendente}.`,
    };
  },

  tools: [
    {
      name: "aniversario_pedir_presente",
      categoria: "Presente de aniversário",
      description:
        "Registra o pedido do PRESENTE DE ANIVERSÁRIO (2 h de sala de reunião ou de atendimento, sem custo). ⚠ NUNCA ofereça nem mencione o presente: use só quando o CLIENTE disser que recebeu o e-mail de aniversário da Seahub e quiser usar as horas. Antes, combine sala, dia e horário (até 2 h) e confira a agenda. A ferramenta confere o CPF/CNPJ, o aniversário no cadastro e a agenda, e avisa a equipe, que libera o pacote. NÃO reserve nem fature você mesmo: quando o pacote for liberado, o sistema reserva e manda a confirmação ao cliente nesta conversa. Chamar de novo na mesma conversa troca o horário pedido.",
      requiresConfirmation: true,
      inputSchema: z.object({
        clienteId: z.number().int().positive().describe("Id do cliente no Conexa."),
        sala: z
          .string()
          .describe(
            'O salaId de uma reserva listada (ex.: 2107) ou o nome cadastrado na configuração. NÃO use o número do nome da sala: "Sala 03" não é 3.',
          ),
        nomeDaSala: z
          .string()
          .optional()
          .describe("O nome da sala como aparece na agenda, para o aviso à equipe."),
        data: z.string().describe("AAAA-MM-DD."),
        inicio: z.string().describe("HH:MM."),
        fim: z.string().describe("HH:MM. No máximo 2 h depois do início."),
      }),
      async execute(entrada, ctx) {
        return pedirPresente(entrada as EntradaDoPedido, ctx);
      },
    },
  ],
};
