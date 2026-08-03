import { z } from "zod";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition, ToolContext } from "../types";
import {
  conexaConfigSchema,
  resolverSala,
  resolverUnidade,
  type ConexaConfig,
} from "./config";
import { ConexaClient } from "./client";
import {
  formatarCliente,
  formatarCobranca,
  formatarContrato,
  formatarPlano,
  formatarReserva,
  semVazios,
  STATUS_PENDENTE,
} from "./formatacao";

/** Teto por resposta: lista longa só gasta token sem ajudar o modelo. */
const LIMITE = 25;

function contexto(ctx: ToolContext): {
  cliente: ConexaClient;
  config: ConexaConfig;
} {
  if (!ctx.credential) {
    throw new Error("Token de API do Conexa não configurado.");
  }
  const config = conexaConfigSchema.parse(ctx.config);
  return { cliente: new ConexaClient(config, ctx.credential), config };
}

/**
 * Traduz o nome da unidade para `companyId`, ou explica o que existe.
 *
 * A Seahub tem mais de uma unidade e `companyId` aparece em quase todo endpoint
 * — deixá-lo implícito faria o agente vender para a unidade errada em silêncio.
 */
function unidadeOuErro(termo: string | undefined, config: ConexaConfig) {
  const { companyId, nomes } = resolverUnidade(termo, config);
  if (companyId) return { companyId };
  return {
    erro: termo
      ? `"${termo}" não é uma unidade cadastrada.`
      : "Nenhuma unidade cadastrada na configuração do Conexa.",
    unidadesDisponiveis: nomes,
  };
}

const unidadeSchema = z
  .string()
  .optional()
  .describe(
    "Nome da unidade cadastrada (ex.: \"Natal\"). Omita se houver só uma.",
  );

export const conexaIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.CONEXA,
  label: "Conexa (ERP)",
  descricao:
    "ERP do coworking: clientes, planos, contratos com assinatura eletrônica, cobranças com Pix e reservas de sala.",
  configSchema: conexaConfigSchema,
  credentialLabel: "Token de API (criado por um administrador no Conexa)",

  async testarConexao(ctx) {
    const { cliente } = contexto(ctx);
    return cliente.testar();
  },

  tools: [
    // ─── Clientes ─────────────────────────────────────────────────────────
    {
      name: "conexa_buscar_cliente",
      categoria: "Clientes",
      description:
        "Procura um cliente no ERP por CPF, CNPJ ou nome. Use ANTES de criar contrato, cobrança ou reserva — quase tudo no Conexa precisa do id do cliente.",
      inputSchema: z.object({
        cpf: z.string().optional().describe("Só os números."),
        cnpj: z.string().optional().describe("Só os números."),
        nome: z.string().optional().describe("Parte do nome ou razão social."),
        unidade: unidadeSchema,
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          cpf?: string;
          cnpj?: string;
          nome?: string;
          unidade?: string;
        };
        const { cliente, config } = contexto(ctx);
        const unidade = unidadeOuErro(args.unidade, config);
        if ("erro" in unidade) return unidade;

        if (!args.cpf && !args.cnpj && !args.nome) {
          return { erro: "Informe CPF, CNPJ ou nome para procurar." };
        }

        const { itens, temMais } = await cliente.buscarClientes({
          companyId: unidade.companyId,
          cpf: args.cpf?.replace(/\D/g, ""),
          cnpj: args.cnpj?.replace(/\D/g, ""),
          name: args.nome,
          limit: LIMITE,
        });

        if (!itens.length) {
          return { encontrados: 0, aviso: "Nenhum cliente com esses dados." };
        }
        return {
          encontrados: itens.length,
          temMais,
          clientes: itens.map((c) => semVazios(formatarCliente(c))),
        };
      },
    },
    {
      name: "conexa_ver_cliente",
      categoria: "Clientes",
      description:
        "Dados completos de um cliente pelo id, incluindo documento e contato. Use depois de conexa_buscar_cliente, quando precisar de mais do que a lista mostra.",
      inputSchema: z.object({ clienteId: z.number().int().positive() }),
      async execute(entrada, ctx) {
        const { clienteId } = entrada as { clienteId: number };
        const { cliente } = contexto(ctx);
        return semVazios(formatarCliente(await cliente.obterCliente(clienteId)));
      },
    },
    {
      name: "conexa_criar_cliente",
      categoria: "Clientes",
      description:
        "Cadastra um cliente novo no ERP. Use só depois de conferir com conexa_buscar_cliente que ele ainda não existe — cadastro duplicado bagunça cobrança e contrato.",
      requiresConfirmation: true,
      inputSchema: z.object({
        nome: z.string().min(3).describe("Nome da pessoa ou nome fantasia."),
        razaoSocial: z.string().optional(),
        cpf: z.string().optional().describe("Só os números."),
        cnpj: z.string().optional().describe("Só os números."),
        email: z.string().optional(),
        telefone: z.string().optional(),
        unidade: unidadeSchema,
      }),
      async execute(entrada, ctx) {
        const args = entrada as Record<string, string | undefined>;
        const { cliente, config } = contexto(ctx);
        const unidade = unidadeOuErro(args.unidade, config);
        if ("erro" in unidade) return unidade;

        if (!args.cpf && !args.cnpj) {
          return { erro: "O Conexa exige CPF ou CNPJ para cadastrar." };
        }

        const { id } = await cliente.criarCliente(
          semVazios({
            companyId: unidade.companyId,
            name: args.nome,
            legalName: args.razaoSocial,
            cpf: args.cpf?.replace(/\D/g, ""),
            cnpj: args.cnpj?.replace(/\D/g, ""),
            email: args.email,
            phone: args.telefone,
          }),
        );
        return { criado: true, clienteId: id };
      },
    },
    {
      name: "conexa_atualizar_cliente",
      categoria: "Clientes",
      description: "Corrige dados de um cliente que já existe.",
      requiresConfirmation: true,
      inputSchema: z.object({
        clienteId: z.number().int().positive(),
        nome: z.string().optional(),
        email: z.string().optional(),
        telefone: z.string().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          clienteId: number;
          nome?: string;
          email?: string;
          telefone?: string;
        };
        const { cliente } = contexto(ctx);
        await cliente.atualizarCliente(
          args.clienteId,
          semVazios({ name: args.nome, email: args.email, phone: args.telefone }),
        );
        return { atualizado: true };
      },
    },

    // ─── Pessoas ──────────────────────────────────────────────────────────
    {
      name: "conexa_listar_pessoas",
      categoria: "Pessoas",
      description:
        "Lista as pessoas vinculadas a um cliente. É delas que sai o solicitante de uma reserva e o signatário de um contrato.",
      inputSchema: z.object({
        clienteId: z.number().int().positive(),
        nome: z.string().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as { clienteId: number; nome?: string };
        const { cliente } = contexto(ctx);
        const { itens } = await cliente.listarPessoas({
          customerId: args.clienteId,
          name: args.nome,
          limit: LIMITE,
        });
        return itens.map((p) =>
          semVazios({
            id: p.personId ?? p.id,
            nome: p.name,
            email: p.email,
            cpf: p.cpf,
          }),
        );
      },
    },
    {
      name: "conexa_criar_pessoa",
      categoria: "Pessoas",
      description: "Cadastra uma pessoa vinculada a um cliente.",
      requiresConfirmation: true,
      inputSchema: z.object({
        clienteId: z.number().int().positive(),
        nome: z.string().min(3),
        email: z.string().optional(),
        cpf: z.string().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          clienteId: number;
          nome: string;
          email?: string;
          cpf?: string;
        };
        const { cliente } = contexto(ctx);
        const { id } = await cliente.criarPessoa(
          semVazios({
            customerId: args.clienteId,
            name: args.nome,
            email: args.email,
            cpf: args.cpf?.replace(/\D/g, ""),
          }),
        );
        return { criado: true, pessoaId: id };
      },
    },

    // ─── Planos e produtos ────────────────────────────────────────────────
    {
      name: "conexa_listar_planos",
      categoria: "Planos e produtos",
      description:
        "Lista os planos ativos com os valores ATUAIS. Use isto em vez de recitar preço de memória: preço muda, e o do ERP é o que vale.",
      inputSchema: z.object({
        nome: z.string().optional().describe("Parte do nome do plano."),
        unidade: unidadeSchema,
      }),
      async execute(entrada, ctx) {
        const args = entrada as { nome?: string; unidade?: string };
        const { cliente, config } = contexto(ctx);
        const unidade = unidadeOuErro(args.unidade, config);
        if ("erro" in unidade) return unidade;

        const { itens } = await cliente.listarPlanos({
          companyId: unidade.companyId,
          name: args.nome,
          isActive: 1,
          limit: LIMITE,
        });
        return itens.map((p) => semVazios(formatarPlano(p)));
      },
    },
    {
      name: "conexa_ver_plano",
      categoria: "Planos e produtos",
      description:
        "Detalhes de um plano pelo id, com o valor vigente. Use quando o cliente já escolheu e você precisa confirmar o preço antes de criar o contrato.",
      inputSchema: z.object({ planoId: z.number().int().positive() }),
      async execute(entrada, ctx) {
        const { planoId } = entrada as { planoId: number };
        const { cliente } = contexto(ctx);
        return semVazios(formatarPlano(await cliente.obterPlano(planoId)));
      },
    },
    {
      name: "conexa_listar_produtos",
      categoria: "Planos e produtos",
      description: "Lista produtos e serviços avulsos, com preço atual.",
      inputSchema: z.object({
        nome: z.string().optional(),
        unidade: unidadeSchema,
      }),
      async execute(entrada, ctx) {
        const args = entrada as { nome?: string; unidade?: string };
        const { cliente, config } = contexto(ctx);
        const unidade = unidadeOuErro(args.unidade, config);
        if ("erro" in unidade) return unidade;

        const { itens } = await cliente.listarProdutos({
          companyId: unidade.companyId,
          name: args.nome,
          isActive: 1,
          limit: LIMITE,
        });
        return itens.map((p) =>
          semVazios({ id: p.productId ?? p.id, nome: p.name, valor: p.price }),
        );
      },
    },

    // ─── Contratos ────────────────────────────────────────────────────────
    {
      name: "conexa_criar_contrato",
      categoria: "Contratos",
      description:
        "Cria o contrato do cliente num plano. É o passo que efetiva a venda no ERP. Confirme plano, periodicidade e data de início com o cliente ANTES de chamar.",
      requiresConfirmation: true,
      inputSchema: z.object({
        clienteId: z.number().int().positive(),
        planoId: z.number().int().positive(),
        periodicidade: z
          .enum(["monthly", "bimonthly", "quarterly", "semester", "yearly"])
          .describe("Periodicidade do pagamento, conforme o plano."),
        inicio: z.string().describe("Data de início, formato AAAA-MM-DD."),
        diaDeVencimento: z
          .number()
          .int()
          .min(1)
          .max(31)
          .optional()
          .describe("Obrigatório no primeiro contrato do cliente."),
        valor: z.number().optional().describe("Só se for diferente do plano."),
        observacoes: z.string().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          clienteId: number;
          planoId: number;
          periodicidade: string;
          inicio: string;
          diaDeVencimento?: number;
          valor?: number;
          observacoes?: string;
        };
        const { cliente } = contexto(ctx);

        const { id } = await cliente.criarContrato(
          semVazios({
            customerId: args.clienteId,
            planId: args.planoId,
            paymentFrequency: args.periodicidade,
            startDate: args.inicio,
            dueDay: args.diaDeVencimento,
            amount: args.valor,
            notes: args.observacoes,
          }),
        );
        return {
          criado: true,
          contratoId: id,
          proximoPasso:
            "Para o cliente assinar, chame conexa_enviar_contrato_para_assinatura.",
        };
      },
    },
    {
      name: "conexa_ver_contrato",
      categoria: "Contratos",
      description:
        "Situação de um contrato pelo id: plano, periodicidade, valor e vigência. Use para conferir o que o cliente já tem antes de mudar qualquer coisa.",
      inputSchema: z.object({ contratoId: z.number().int().positive() }),
      async execute(entrada, ctx) {
        const { contratoId } = entrada as { contratoId: number };
        const { cliente } = contexto(ctx);
        return semVazios(formatarContrato(await cliente.obterContrato(contratoId)));
      },
    },
    {
      name: "conexa_listar_contratos",
      categoria: "Contratos",
      description: "Contratos de um cliente. Use para saber o que ele já tem.",
      inputSchema: z.object({
        clienteId: z.number().int().positive(),
        somenteAtivos: z.boolean().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as { clienteId: number; somenteAtivos?: boolean };
        const { cliente } = contexto(ctx);
        const { itens } = await cliente.listarContratos({
          customerId: args.clienteId,
          isActive: args.somenteAtivos === false ? undefined : 1,
          limit: LIMITE,
        });
        return itens.map((c) => semVazios(formatarContrato(c)));
      },
    },
    {
      name: "conexa_enviar_contrato_para_assinatura",
      categoria: "Contratos",
      description:
        "Manda o contrato para assinatura eletrônica. Com entrega por WhatsApp, o cliente assina sem sair da conversa. Chame depois de conexa_criar_contrato.",
      requiresConfirmation: true,
      inputSchema: z.object({
        contratoId: z.number().int().positive(),
        nomeDoSignatario: z.string().min(3),
        entregarPor: z
          .enum(["whatsapp", "email"])
          .describe("Por onde o cliente recebe o link de assinatura."),
        destino: z
          .string()
          .min(5)
          .describe(
            "O e-mail, ou o WhatsApp com DDI e DDD e só números (ex.: 5584999998888).",
          ),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          contratoId: number;
          nomeDoSignatario: string;
          entregarPor: "whatsapp" | "email";
          destino: string;
        };
        const { cliente, config } = contexto(ctx);

        // O modelo de contrato é do Conexa e não tem endpoint de listagem — sem
        // ele cadastrado, não há como gerar o PDF para assinar.
        if (!config.contractTemplateId) {
          return {
            erro: "Nenhum modelo de contrato cadastrado na configuração do Conexa.",
            comoResolver:
              "Cadastre o id do modelo em Integrações → Conexa antes de enviar contratos.",
          };
        }

        await cliente.solicitarAssinatura(args.contratoId, {
          contractTemplateId: config.contractTemplateId,
          customerSigners: [
            {
              name: args.nomeDoSignatario,
              deliveryMethod: args.entregarPor,
              deliveryValue:
                args.entregarPor === "whatsapp"
                  ? args.destino.replace(/\D/g, "")
                  : args.destino,
              role: "sign",
            },
          ],
        });
        return {
          enviado: true,
          observacao: `O cliente recebe o link por ${args.entregarPor}. Avise-o e diga que a assinatura é digital.`,
        };
      },
    },
    {
      name: "conexa_encerrar_contrato",
      categoria: "Contratos",
      description:
        "Encerra um contrato com data de término. Cancelamento é decisão comercial — só use se a equipe já autorizou.",
      requiresConfirmation: true,
      inputSchema: z.object({
        contratoId: z.number().int().positive(),
        fim: z.string().describe("Data de encerramento, AAAA-MM-DD."),
        motivo: z.string().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as { contratoId: number; fim: string; motivo?: string };
        const { cliente } = contexto(ctx);
        await cliente.encerrarContrato(
          args.contratoId,
          semVazios({ endDate: args.fim, notes: args.motivo }),
        );
        return { encerrado: true };
      },
    },

    // ─── Cobrança ─────────────────────────────────────────────────────────
    {
      name: "conexa_listar_cobrancas",
      categoria: "Cobrança",
      description:
        "Cobranças de um cliente. Por padrão traz só as PENDENTES, que é o que interessa a quem pede segunda via.",
      inputSchema: z.object({
        clienteId: z.number().int().positive(),
        todas: z
          .boolean()
          .optional()
          .describe("true traz também as pagas e negociadas."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as { clienteId: number; todas?: boolean };
        const { cliente } = contexto(ctx);

        const { itens } = await cliente.listarCobrancas({
          customerId: args.clienteId,
          // `unpaid`, não `open`: filtrar pelo nome errado devolve lista vazia
          // e faria o agente dizer que não há débito a quem está devendo.
          status: args.todas ? undefined : STATUS_PENDENTE,
          limit: LIMITE,
        });

        const cobrancas = itens.map((c) => semVazios(formatarCobranca(c)));
        return cobrancas.length
          ? { total: cobrancas.length, cobrancas }
          : { total: 0, aviso: "Nenhuma cobrança pendente para este cliente." };
      },
    },
    {
      name: "conexa_ver_cobranca",
      categoria: "Cobrança",
      description:
        "Detalhes de uma cobrança, com linha digitável e link do boleto.",
      inputSchema: z.object({ cobrancaId: z.number().int().positive() }),
      async execute(entrada, ctx) {
        const { cobrancaId } = entrada as { cobrancaId: number };
        const { cliente } = contexto(ctx);
        return semVazios(formatarCobranca(await cliente.obterCobranca(cobrancaId)));
      },
    },
    {
      name: "conexa_pix_da_cobranca",
      categoria: "Cobrança",
      description:
        "Código Pix copia-e-cola de uma cobrança. Consulte SEMPRE na hora de mandar: depois do vencimento o Conexa gera um Pix novo, com juros e multa.",
      inputSchema: z.object({ cobrancaId: z.number().int().positive() }),
      async execute(entrada, ctx) {
        const { cobrancaId } = entrada as { cobrancaId: number };
        const { cliente } = contexto(ctx);
        const pix = await cliente.obterPix(cobrancaId);
        if (!pix.copyPasteCode) {
          return { erro: "Esta cobrança não tem Pix disponível." };
        }
        // O QR vem em base64 e não serve para o modelo — só pesaria o contexto.
        return { copiaECola: pix.copyPasteCode };
      },
    },
    {
      name: "conexa_criar_cobranca",
      categoria: "Cobrança",
      description:
        "Fatura vendas já lançadas, gerando uma cobrança. Todas as vendas precisam ser do mesmo cliente.",
      requiresConfirmation: true,
      inputSchema: z.object({
        vendaIds: z.array(z.number().int().positive()).min(1),
        vencimento: z.string().optional().describe("AAAA-MM-DD."),
        observacoes: z.string().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          vendaIds: number[];
          vencimento?: string;
          observacoes?: string;
        };
        const { cliente } = contexto(ctx);
        const { id } = await cliente.criarCobranca({
          salesIds: args.vendaIds,
          dueDate: args.vencimento,
          notes: args.observacoes,
        });
        return { criada: true, cobrancaId: id };
      },
    },

    // ─── Reservas de sala ─────────────────────────────────────────────────
    {
      name: "conexa_listar_reservas",
      categoria: "Reservas de sala",
      description:
        "Reservas já feitas. Serve também para ver DISPONIBILIDADE: o Conexa não tem consulta de horário livre, então liste o que já está ocupado na sala e no dia.",
      inputSchema: z.object({
        sala: z.string().optional().describe("Nome da sala cadastrada."),
        clienteId: z.number().int().positive().optional(),
        de: z.string().optional().describe("Início do período, AAAA-MM-DD."),
        ate: z.string().optional().describe("Fim do período, AAAA-MM-DD."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          sala?: string;
          clienteId?: number;
          de?: string;
          ate?: string;
        };
        const { cliente, config } = contexto(ctx);

        const { roomId, nomes } = resolverSala(args.sala, config);
        if (args.sala && !roomId) {
          return { erro: `"${args.sala}" não é uma sala cadastrada.`, salasDisponiveis: nomes };
        }

        const { itens } = await cliente.listarReservas({
          roomId,
          customerId: args.clienteId,
          bookingDateTimeFrom: args.de,
          bookingDateTimeTo: args.ate,
          limit: LIMITE,
        });
        return itens.map((r) => semVazios(formatarReserva(r)));
      },
    },
    {
      name: "conexa_criar_reserva",
      categoria: "Reservas de sala",
      description:
        "Reserva uma sala. Confira antes com conexa_listar_reservas se o horário está livre — o Conexa não avisa sobre conflito de forma clara.",
      requiresConfirmation: true,
      inputSchema: z.object({
        clienteId: z.number().int().positive(),
        sala: z.string().describe("Nome da sala cadastrada."),
        data: z.string().describe("AAAA-MM-DD."),
        inicio: z.string().describe("HH:MM."),
        fim: z.string().describe("HH:MM."),
        solicitanteId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Id da pessoa, de conexa_listar_pessoas."),
        observacoes: z.string().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          clienteId: number;
          sala: string;
          data: string;
          inicio: string;
          fim: string;
          solicitanteId?: number;
          observacoes?: string;
        };
        const { cliente, config } = contexto(ctx);

        const { roomId, nomes } = resolverSala(args.sala, config);
        if (!roomId) {
          // Não existe endpoint que liste salas: o nome vem do cadastro do
          // painel, e sem ele o agente não tem como descobrir o id sozinho.
          return {
            erro: `"${args.sala}" não é uma sala cadastrada.`,
            salasDisponiveis: nomes,
          };
        }

        const { id } = await cliente.criarReserva({
          customerId: args.clienteId,
          roomId,
          date: args.data,
          startTime: args.inicio,
          finalTime: args.fim,
          personId: args.solicitanteId,
          notes: args.observacoes,
        });
        return { criada: true, reservaId: id };
      },
    },
    {
      name: "conexa_ver_reserva",
      categoria: "Reservas de sala",
      description:
        "Detalhes de uma reserva pelo id: sala, horário e situação. Use para confirmar com o cliente antes de alterar ou cancelar.",
      inputSchema: z.object({ reservaId: z.number().int().positive() }),
      async execute(entrada, ctx) {
        const { reservaId } = entrada as { reservaId: number };
        const { cliente } = contexto(ctx);
        return semVazios(formatarReserva(await cliente.obterReserva(reservaId)));
      },
    },
    {
      name: "conexa_alterar_reserva",
      categoria: "Reservas de sala",
      description: "Muda data, horário ou sala de uma reserva.",
      requiresConfirmation: true,
      inputSchema: z.object({
        reservaId: z.number().int().positive(),
        sala: z.string().optional(),
        data: z.string().optional().describe("AAAA-MM-DD."),
        inicio: z.string().optional().describe("HH:MM."),
        fim: z.string().optional().describe("HH:MM."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          reservaId: number;
          sala?: string;
          data?: string;
          inicio?: string;
          fim?: string;
        };
        const { cliente, config } = contexto(ctx);

        const { roomId, nomes } = resolverSala(args.sala, config);
        if (args.sala && !roomId) {
          return { erro: `"${args.sala}" não é uma sala cadastrada.`, salasDisponiveis: nomes };
        }

        await cliente.alterarReserva(
          args.reservaId,
          semVazios({
            roomId,
            date: args.data,
            startTime: args.inicio,
            finalTime: args.fim,
          }),
        );
        return { alterada: true };
      },
    },
    {
      name: "conexa_cancelar_reserva",
      categoria: "Reservas de sala",
      description: "Cancela uma reserva. Confirme com o cliente antes.",
      requiresConfirmation: true,
      inputSchema: z.object({
        reservaId: z.number().int().positive(),
        motivo: z.string().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as { reservaId: number; motivo?: string };
        const { cliente } = contexto(ctx);
        await cliente.cancelarReserva(
          args.reservaId,
          semVazios({ cancellationReason: args.motivo }),
        );
        return { cancelada: true };
      },
    },

    // ─── CRM ──────────────────────────────────────────────────────────────
    {
      name: "conexa_registrar_lead",
      categoria: "CRM",
      description:
        "Registra um cliente potencial no CRM do Conexa. Use quando alguém demonstra interesse mas ainda não fecha.",
      requiresConfirmation: true,
      inputSchema: z.object({
        contato: z.string().min(3).describe("Nome de quem falou com você."),
        empresa: z.string().optional(),
        telefone: z.string().optional(),
        email: z.string().optional(),
        observacoes: z.string().optional(),
        unidade: unidadeSchema,
      }),
      async execute(entrada, ctx) {
        const args = entrada as Record<string, string | undefined>;
        const { cliente, config } = contexto(ctx);
        const unidade = unidadeOuErro(args.unidade, config);
        if ("erro" in unidade) return unidade;

        // `partnerId` é obrigatório e não tem endpoint de listagem — vem do
        // cadastro do painel, como as salas.
        if (!config.crmPartnerId) {
          return {
            erro: "Origem do CRM não cadastrada na configuração do Conexa.",
            comoResolver: "Cadastre a origem em Integrações → Conexa.",
          };
        }

        const { id } = await cliente.registrarLead(
          semVazios({
            companyId: unidade.companyId,
            partnerId: config.crmPartnerId,
            statusId: config.crmStatusId,
            contactNames: args.contato,
            name: args.empresa,
            phones: args.telefone ? [args.telefone] : undefined,
            emails: args.email ? [args.email] : undefined,
            notes: args.observacoes,
          }),
        );
        return { registrado: true, leadId: id };
      },
    },

    // ─── Apoio ────────────────────────────────────────────────────────────
    {
      name: "conexa_listar_unidades",
      categoria: "Apoio",
      description:
        "Unidades da Seahub no ERP. Use se ficar em dúvida sobre onde o cliente é atendido.",
      inputSchema: z.object({}),
      async execute(_entrada, ctx) {
        const { cliente } = contexto(ctx);
        const { itens } = await cliente.listarUnidades({ limit: LIMITE });
        return itens.map((u) =>
          semVazios({ id: u.companyId ?? u.id, nome: u.tradeName ?? u.legalName }),
        );
      },
    },
  ],
};
