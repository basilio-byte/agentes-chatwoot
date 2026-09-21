import { z } from "zod";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition, ToolContext } from "../types";
import {
  conexaConfigSchema,
  resolverUnidade,
  salaOuErro,
  type ConexaConfig,
} from "./config";
import { ConexaApiError, ConexaClient, juntarPaginas } from "./client";
import {
  corpoDeAtualizacao,
  corpoDeClienteNovo,
  periodoDaAgenda,
} from "./entrada";
import { conferirHorario, instanteEmSaoPaulo } from "./agenda";
import { escolherSolicitante, pessoaDaApi } from "./solicitante";
import { acharCobrancaDaVenda, situacaoDeFaturamento } from "./faturamento";
import {
  acrescentarAnotacao,
  carimboDaAnotacao,
  formatarCliente,
  formatarClienteResumo,
  formatarCobranca,
  formatarContrato,
  formatarPlano,
  formatarReserva,
  semVazios,
  STATUS_PENDENTE,
} from "./formatacao";
// ⚠ O container roda em UTC. Carimbar a anotação com `new Date()` cru poria
// três horas a menos no que uma pessoa vai ler no ERP.
import { agoraEmSaoPaulo } from "@/lib/tempo";

/** Teto por resposta: lista longa só gasta token sem ajudar o modelo. */
const LIMITE = 25;

/**
 * A agenda é a exceção ao `LIMITE`: ela é lida para concluir que um horário está
 * LIVRE, e para isso não pode faltar reserva nenhuma. Percorre as páginas até o
 * teto e, acima dele, diz que a lista não veio inteira.
 */
const POR_PAGINA_DA_AGENDA = 50;
export const TETO_DA_AGENDA = 100;

/**
 * A API recusou ANTES de aplicar? Só um 4xx garante isso.
 *
 * ⚠ 5xx, timeout e queda de rede não dizem se a escrita entrou, e o runner
 * entrega a exceção ao modelo como resultado de tool comum — o que o ensina a
 * corrigir e chamar de novo. Numa reserva, é a mesma sala reservada duas vezes;
 * num cadastro, o cliente duplicado. Mesma doutrina das escritas do Google
 * Sheets: na dúvida, "indeterminado" e mandar conferir.
 */
function ehRecusaDaApi(erro: unknown) {
  return erro instanceof ConexaApiError && erro.status >= 400 && erro.status < 500;
}

function escritaIndeterminada(erro: unknown, comoConferir: string) {
  const motivo = erro instanceof Error ? erro.message : String(erro);
  return {
    resultado: "indeterminado",
    erro: `O Conexa não confirmou a gravação (${motivo.slice(0, 200)}). Ela PODE ter entrado.`,
    comoSeguir: `NÃO repita a chamada. ${comoConferir}`,
  };
}

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
    "Empresa cadastrada na configuração do Conexa — NÃO é o endereço: Seaway, Sebrae e Ayrton Senna não são unidades aqui. Omita para usar a primeira empresa cadastrada.",
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
        "Procura um cliente no ERP por CPF, CNPJ ou nome. Use ANTES de criar contrato, cobrança ou reserva — quase tudo no Conexa precisa do id do cliente. Devolve id e nome; documento e contato ficam em conexa_ver_cliente.",
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
          clientes: itens.map((c) => semVazios(formatarClienteResumo(c))),
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
        nome: z
          .string()
          .min(3)
          .describe("Nome da pessoa; numa empresa, o nome fantasia."),
        razaoSocial: z.string().optional().describe("Só para empresa (CNPJ)."),
        cpf: z.string().optional().describe("Pessoa física. Só os números."),
        cnpj: z.string().optional().describe("Empresa. Só os números."),
        email: z.string().optional(),
        telefone: z.string().optional().describe("Com DDD."),
        unidade: unidadeSchema,
      }),
      async execute(entrada, ctx) {
        const args = entrada as Record<string, string | undefined>;
        const { cliente, config } = contexto(ctx);
        const unidade = unidadeOuErro(args.unidade, config);
        if ("erro" in unidade) return unidade;

        const montado = corpoDeClienteNovo({
          companyId: unidade.companyId,
          nome: args.nome ?? "",
          razaoSocial: args.razaoSocial,
          cpf: args.cpf,
          cnpj: args.cnpj,
          email: args.email,
          telefone: args.telefone,
        });
        if ("erro" in montado) return montado;

        let id: number;
        try {
          ({ id } = await cliente.criarCliente(montado.corpo));
        } catch (erro) {
          if (ehRecusaDaApi(erro)) throw erro;
          return escritaIndeterminada(
            erro,
            "Procure antes com conexa_buscar_cliente pelo CPF ou CNPJ: cadastrar de novo às cegas pode duplicar o cliente.",
          );
        }

        return {
          criado: true,
          clienteId: id,
          ...(montado.avisos.length ? { avisos: montado.avisos } : {}),
        };
      },
    },
    {
      name: "conexa_atualizar_cliente",
      categoria: "Clientes",
      description:
        "Corrige dados de um cliente que já existe. E-mail e telefone são ACRESCENTADOS aos que o cadastro já tem — nada é apagado.",
      requiresConfirmation: true,
      inputSchema: z.object({
        clienteId: z.number().int().positive(),
        nome: z.string().optional(),
        email: z.string().optional(),
        telefone: z.string().optional().describe("Com DDD."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          clienteId: number;
          nome?: string;
          email?: string;
          telefone?: string;
        };
        const { cliente } = contexto(ctx);

        // ⚠ Ler IMEDIATAMENTE antes de escrever: `emailsMessage` e `phones` são
        // listas que o PATCH substitui inteiras, e a equipe cadastra ali à mão.
        const atual: Record<string, unknown> =
          args.email || args.telefone ? await cliente.obterCliente(args.clienteId) : {};
        const { corpo, avisos } = corpoDeAtualizacao(atual, args);

        if (!Object.keys(corpo).length) {
          return {
            atualizado: false,
            erro: "Nada para gravar: informe nome, e-mail ou um telefone válido.",
            ...(avisos.length ? { avisos } : {}),
          };
        }

        await cliente.atualizarCliente(args.clienteId, corpo);
        return { atualizado: true, ...(avisos.length ? { avisos } : {}) };
      },
    },

    {
      name: "conexa_anotar_no_cliente",
      categoria: "Clientes",
      description:
        "Acrescenta uma anotação ao campo de observações do cliente no ERP, sem apagar o que já estiver escrito lá. Use para registrar o que a equipe precisa saber depois — combinado feito, restrição do cliente, motivo de um pedido. A anotação fica marcada com a data e com a origem, e NÃO tem desfazer: escreva a versão final de uma vez, e não repita para confirmar. Não use para o que já tem campo próprio (nome, e-mail, telefone) nem para o que é só desta conversa.",
      requiresConfirmation: true,
      inputSchema: z.object({
        clienteId: z.number().int().positive(),
        anotacao: z
          .string()
          .trim()
          .min(3)
          .max(1000)
          .describe(
            "O que registrar, em uma ou duas frases. Escreva para uma pessoa da equipe ler daqui a meses, sem o contexto da conversa.",
          ),
      }),
      async execute(entrada, ctx) {
        const { clienteId, anotacao } = entrada as {
          clienteId: number;
          anotacao: string;
        };
        const { cliente } = contexto(ctx);

        // ⚠ Ler IMEDIATAMENTE antes de escrever. `notes` é um campo único e o
        // PATCH substitui: sem esta leitura, a primeira anotação apagaria tudo
        // que a equipe comercial escreveu à mão, sem erro e sem desfazer.
        //
        // O intervalo entre ler e gravar é uma corrida conhecida e aceita: o
        // Conexa não tem ETag nem `If-Match`, então duas anotações simultâneas
        // no mesmo cliente perdem uma. Mantê-lo curto é tudo que dá para fazer,
        // e o caso é raro — dois atendimentos do MESMO cliente no mesmo
        // segundo. Mesma escolha já feita nos `custom_attributes` do Chatwoot.
        const atual = await cliente.obterCliente(clienteId);
        const agora = agoraEmSaoPaulo();

        const resultado = acrescentarAnotacao(
          (atual as Record<string, unknown>).notes,
          anotacao,
          carimboDaAnotacao(agora, ctx),
        );

        if (resultado.excedeu) {
          // Recusa em vez de cortar: cortar destruiria exatamente o texto
          // humano que este caminho existe para preservar.
          return {
            anotado: false,
            nadaFoiAlterado: true,
            erro: `O campo de observações deste cliente já está cheio demais para receber mais texto sem virar ilegível. Avise que uma pessoa precisa revisar e limpar as observações dele no ERP — não é algo que você possa resolver.`,
          };
        }

        await cliente.atualizarCliente(clienteId, { notes: resultado.texto });

        return {
          anotado: true,
          clienteId,
          observacao:
            "A anotação foi ACRESCENTADA ao que já existia; nada foi apagado.",
        };
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
        "Reservas já feitas. Serve também para ver DISPONIBILIDADE: o Conexa não tem consulta de horário livre, então liste o que já está ocupado na sala e no dia. Só conclua que um horário está livre se a resposta vier com completa: true. Reserva com status cancelled ou billedCancelled não ocupa mais o horário.",
      inputSchema: z.object({
        sala: z
          .string()
          .optional()
          .describe(
            "O salaId de uma reserva listada (ex.: 2107) ou o nome cadastrado na configuração. NÃO use o número do nome da sala: \"Sala 03\" não é 3.",
          ),
        clienteId: z.number().int().positive().optional(),
        de: z
          .string()
          .optional()
          .describe("Início do período: o dia, AAAA-MM-DD (vale o dia inteiro, horário de São Paulo)."),
        ate: z
          .string()
          .optional()
          .describe("Fim do período: o dia, AAAA-MM-DD (inclui o dia inteiro)."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          sala?: string;
          clienteId?: number;
          de?: string;
          ate?: string;
        };
        const { cliente, config } = contexto(ctx);

        const sala = salaOuErro(args.sala, config);
        if ("erro" in sala) return sala;
        const periodo = periodoDaAgenda(args.de, args.ate);
        if ("erro" in periodo) return periodo;

        const { itens, completo } = await juntarPaginas(
          ({ offset, limit }) =>
            cliente.listarReservas({
              roomId: sala.roomId,
              customerId: args.clienteId,
              bookingDateTimeFrom: periodo.de,
              bookingDateTimeTo: periodo.ate,
              limit,
              offset,
            }),
          { porPagina: POR_PAGINA_DA_AGENDA, teto: TETO_DA_AGENDA },
        );
        const reservas = itens.map((r) => semVazios(formatarReserva(r)));

        if (!completo) {
          return {
            total: reservas.length,
            completa: false,
            aviso: `Há mais reservas no período do que as ${reservas.length} mostradas. NÃO conclua que um horário está livre por esta lista: consulte de novo filtrando pela sala (salaId) e por um período menor.`,
            reservas,
          };
        }
        if (sala.roomId && !reservas.length) {
          return {
            total: 0,
            completa: true,
            aviso: `Nenhuma reserva na sala ${sala.roomId} no período. Isso só quer dizer "livre" se ${sala.roomId} for um salaId que apareceu na agenda — um número de sala errado também volta vazio.`,
            reservas,
          };
        }
        return { total: reservas.length, completa: true, reservas };
      },
    },
    {
      name: "conexa_criar_reserva",
      categoria: "Reservas de sala",
      description:
        "Reserva uma sala. A ferramenta confere a agenda do dia e RECUSA se o horário estiver ocupado, devolvendo o que ocupa — o Conexa não avisa sobre conflito de forma clara, então a trava é aqui. Ainda assim consulte a agenda antes com conexa_listar_reservas: é dela que saem as alternativas para oferecer ao cliente. O retorno traz a sala e o horário que o Conexa gravou: é isso que se confirma ao cliente.",
      requiresConfirmation: true,
      inputSchema: z.object({
        clienteId: z.number().int().positive(),
        sala: z
          .string()
          .describe(
            "O salaId de uma reserva listada (ex.: 2107) ou o nome cadastrado na configuração. NÃO use o número do nome da sala: \"Sala 03\" não é 3.",
          ),
        data: z.string().describe("AAAA-MM-DD."),
        inicio: z.string().describe("HH:MM."),
        fim: z.string().describe("HH:MM."),
        solicitanteId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Id da pessoa que vai usar a sala. Sem ele, se o cliente tiver uma pessoa só, é ela; com mais de uma, a ferramenta devolve a lista para você escolher.",
          ),
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

        const sala = salaOuErro(args.sala, config);
        if ("erro" in sala) return sala;
        if (!sala.roomId) return { erro: "Informe a sala da reserva." };

        const inicioMs = instanteEmSaoPaulo(args.data, args.inicio);
        const fimMs = instanteEmSaoPaulo(args.data, args.fim);
        if (inicioMs === null || fimMs === null) {
          return {
            erro: `Data ou horário fora do formato: data "${args.data}" (AAAA-MM-DD), início "${args.inicio}" e fim "${args.fim}" (HH:MM).`,
          };
        }
        if (fimMs <= inicioMs) {
          return { erro: `O fim (${args.fim}) não é depois do início (${args.inicio}).` };
        }

        // ⚠ A conferência de conflito é feita AQUI, e não deixada para o modelo.
        // O Conexa não recusa sobreposição de forma clara, e até 16/09/2026 o
        // único freio era a instrução de consultar a agenda antes — que o modelo
        // pode pular, e que ninguém confere numa reserva feita de madrugada.
        const diaDaReserva = periodoDaAgenda(args.data, args.data);
        if ("erro" in diaDaReserva) return diaDaReserva;

        let agenda: { itens: Awaited<ReturnType<typeof cliente.listarReservas>>["itens"]; completo: boolean };
        try {
          agenda = await juntarPaginas(
            ({ offset, limit }) =>
              cliente.listarReservas({
                roomId: sala.roomId,
                bookingDateTimeFrom: diaDaReserva.de,
                bookingDateTimeTo: diaDaReserva.ate,
                limit,
                offset,
              }),
            { porPagina: POR_PAGINA_DA_AGENDA, teto: TETO_DA_AGENDA },
          );
        } catch {
          // Recusa, e não segue às cegas: entre uma reserva que não sai por
          // soluço do ERP e duas reservas na mesma sala, a primeira se conserta.
          return {
            criada: false,
            erro: "Não consegui ler a agenda da sala para conferir se o horário está livre, então não reservei.",
            comoSeguir:
              "Tente de novo em instantes. Se persistir, encaminhe para a equipe conferir a agenda à mão.",
          };
        }

        if (!agenda.completo) {
          return {
            criada: false,
            erro: `A agenda da sala neste dia não veio inteira (mais de ${TETO_DA_AGENDA} reservas), então não dá para afirmar que o horário está livre — e não reservei.`,
            comoSeguir: "Encaminhe para a equipe conferir a agenda à mão.",
          };
        }

        const conferencia = conferirHorario(
          agenda.itens.map((r) => formatarReserva(r)),
          { inicioMs, fimMs },
        );
        if (!conferencia.livre) {
          return {
            criada: false,
            erro: `O horário pedido não está livre nesta sala em ${args.data}.`,
            // Só as pontas do que ocupa: é o que o agente precisa para oferecer
            // outro horário, sem carregar dado de outro cliente para a conversa.
            ocupado: conferencia.conflitam.map((r) => ({ inicio: r.inicio, fim: r.fim })),
            ...(conferencia.ilegiveis.length
              ? {
                  aviso: `${conferencia.ilegiveis.length} reserva(s) desta sala no dia estão sem horário legível; por isso não dá para garantir que o horário está livre.`,
                }
              : {}),
            comoSeguir:
              "Ofereça outro horário livre do dia ao cliente, ou encaminhe para a equipe. NÃO tente reservar de novo o mesmo horário.",
          };
        }

        // ⚠ O Conexa EXIGE a pessoa que vai usar a sala ("Person Id cannot be
        // blank"), apesar de a documentação não marcar o campo como obrigatório.
        // Sem ela informada, uma pessoa ativa só é a escolha; o resto volta para
        // o agente decidir (`solicitante.ts`).
        let solicitanteId = args.solicitanteId;
        if (!solicitanteId) {
          let pessoas: Awaited<ReturnType<typeof cliente.listarPessoas>>;
          try {
            pessoas = await cliente.listarPessoas({ customerId: args.clienteId, limit: LIMITE });
          } catch {
            return {
              criada: false,
              erro: "Não consegui ler as pessoas vinculadas ao cliente, e o Conexa exige uma na reserva — não reservei.",
              comoSeguir: "Tente de novo em instantes. Se persistir, encaminhe para a equipe.",
            };
          }
          const escolha = escolherSolicitante(
            pessoas.itens.map(pessoaDaApi),
            !pessoas.temMais,
          );
          if (escolha.tipo === "nenhuma") {
            return {
              criada: false,
              erro: "O cliente não tem nenhuma pessoa ativa vinculada no Conexa, e a reserva exige uma — não reservei.",
              comoSeguir: "Encaminhe para a equipe cadastrar no Conexa a pessoa que vai usar a sala.",
            };
          }
          if (escolha.tipo === "varias") {
            return {
              criada: false,
              erro: "O cliente tem mais de uma pessoa vinculada no Conexa, e a reserva precisa dizer qual vai usar a sala — não reservei.",
              pessoas: escolha.opcoes,
              ...(escolha.listaCompleta
                ? {}
                : { aviso: `A lista mostra só as ${escolha.opcoes.length} primeiras.` }),
              comoSeguir:
                "Chame de novo com solicitanteId. Se o nome de uma delas for o da pessoa com quem você está falando, use essa; senão, pergunte ao cliente quem vai usar a sala.",
            };
          }
          solicitanteId = escolha.id;
        }

        let id: number;
        try {
          ({ id } = await cliente.criarReserva({
            customerId: args.clienteId,
            roomId: sala.roomId,
            date: args.data,
            startTime: args.inicio,
            finalTime: args.fim,
            personId: solicitanteId,
            notes: args.observacoes,
          }));
        } catch (erro) {
          if (ehRecusaDaApi(erro)) throw erro;
          return escritaIndeterminada(
            erro,
            "Confira antes com conexa_listar_reservas, filtrando pela sala e pelo dia: reservar de novo às cegas pode ocupar a mesma sala duas vezes.",
          );
        }

        // Quem diz o que foi gravado é o Conexa, não o pedido: é daqui que saem
        // a sala e o horário da confirmação ao cliente.
        try {
          const reserva = semVazios(formatarReserva(await cliente.obterReserva(id)));
          return { criada: true, reserva };
        } catch {
          return {
            criada: true,
            reservaId: id,
            aviso:
              "A reserva foi criada, mas não consegui ler de volta o que o Conexa gravou. Confira com conexa_ver_reserva antes de dizer sala e horário ao cliente.",
          };
        }
      },
    },
    {
      name: "conexa_faturar_reserva",
      categoria: "Reservas de sala",
      description:
        "Gera a cobrança de uma reserva e devolve valor, vencimento e link de pagamento. Confere antes de cobrar: reserva descontada do pacote de horas não é cobrada, reserva cancelada é recusada, e reserva que já tem cobrança devolve a existente em vez de criar outra. Chame UMA vez, logo depois de conexa_criar_reserva.",
      requiresConfirmation: true,
      inputSchema: z.object({
        reservaId: z
          .number()
          .int()
          .positive()
          .describe("O id da reserva, devolvido por conexa_criar_reserva."),
      }),
      async execute(entrada, ctx) {
        const { reservaId } = entrada as { reservaId: number };
        const { cliente } = contexto(ctx);

        const semCobrar =
          "Não informe valor nem link ao cliente: encaminhe para a equipe cobrar.";
        const comoMandarOLink =
          "Mande ao cliente o valorAtual e o faturaUrl, que é a página de pagamento; sem faturaUrl, o boletoUrl. Não invente valor nem link.";

        // A decisão de SE cobrar é do código (`faturamento.ts`), não do modelo.
        const situacao = situacaoDeFaturamento(await cliente.obterReserva(reservaId));

        if (situacao.tipo === "recusar") {
          return { faturada: false, erro: situacao.motivo, comoSeguir: semCobrar };
        }
        if (situacao.tipo === "pacoteDeHoras") {
          return {
            faturada: false,
            descontadaDoPacoteDeHoras: true,
            observacao:
              'Nada a cobrar: a reserva foi descontada do pacote de horas do cliente. Na confirmação, o valor é "Descontado do seu pacote de horas".',
          };
        }

        const { vendaId, clienteId } = situacao;
        const existente =
          vendaId && clienteId
            ? await acharCobrancaDaVenda(cliente, vendaId, clienteId)
            : undefined;

        if (existente?.cobranca) {
          return {
            faturada: true,
            jaExistia: true,
            cobranca: semVazios(formatarCobranca(existente.cobranca)),
            observacao: comoMandarOLink,
          };
        }
        if (situacao.tipo === "jaFaturada") {
          return {
            faturada: false,
            jaFaturada: true,
            observacao:
              "A reserva já foi faturada, mas não achei cobrança pendente dela. NÃO gere outra: diga que o link de pagamento chega pela equipe.",
          };
        }
        if (!existente?.conferido) {
          // Sem cliente na reserva, ou lista de pendentes que não veio inteira:
          // não dá para afirmar que a cobrança ainda não existe.
          return {
            faturada: false,
            erro: "Não consegui conferir as cobranças pendentes do cliente, então não dá para garantir que esta reserva ainda não foi cobrada.",
            comoSeguir: semCobrar,
          };
        }

        let id: number;
        try {
          ({ id } = await cliente.criarCobranca({
            salesIds: [situacao.vendaId],
            dueDate: situacao.vencimento,
          }));
        } catch (erro) {
          if (ehRecusaDaApi(erro)) throw erro;
          return escritaIndeterminada(
            erro,
            "A cobrança pode ter sido criada: não chame conexa_faturar_reserva de novo. Diga ao cliente que o link de pagamento chega pela equipe e encaminhe.",
          );
        }

        try {
          const cobranca = semVazios(formatarCobranca(await cliente.obterCobranca(id)));
          return { faturada: true, cobranca, observacao: comoMandarOLink };
        } catch {
          return {
            faturada: true,
            cobrancaId: id,
            aviso:
              "A cobrança foi criada, mas não consegui ler valor e link. Não invente nenhum dos dois: diga que o link de pagamento chega pela equipe.",
          };
        }
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
        sala: z
          .string()
          .optional()
          .describe(
            "O salaId de uma reserva listada (ex.: 2107) ou o nome cadastrado na configuração. NÃO use o número do nome da sala: \"Sala 03\" não é 3.",
          ),
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

        const sala = salaOuErro(args.sala, config);
        if ("erro" in sala) return sala;

        await cliente.alterarReserva(
          args.reservaId,
          semVazios({
            roomId: sala.roomId,
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
