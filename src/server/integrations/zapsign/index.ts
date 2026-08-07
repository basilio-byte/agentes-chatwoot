import { z } from "zod";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition, ToolContext } from "../types";
import {
  AUTH_MODES,
  normalizarStatusDeSignatario,
  resolverModelo,
  zapsignConfigSchema,
  type ZapSignConfig,
} from "./config";
import { ZapSignClient, type DocumentoCriado, type Signatario } from "./client";

function contexto(ctx: ToolContext): {
  cliente: ZapSignClient;
  config: ZapSignConfig;
} {
  if (!ctx.credential) {
    throw new Error("Token da ZapSign não configurado.");
  }
  const config = zapsignConfigSchema.parse(ctx.config);
  return { cliente: new ZapSignClient(config, ctx.credential), config };
}

const signatarioSchema = z.object({
  nome: z.string().min(3).describe("Nome completo de quem assina."),
  email: z.string().optional(),
  telefone: z
    .string()
    .optional()
    .describe("Com DDD, só números. Necessário para envio por WhatsApp."),
  cpf: z.string().optional().describe("Só os números."),
  papel: z
    .string()
    .optional()
    .describe('Função no documento, ex.: "Contratante". Aparece no relatório.'),
  autenticacao: z
    .enum(AUTH_MODES)
    .optional()
    .describe("Como ele confirma a identidade. Omita para usar o padrão."),
  enviarPorWhatsapp: z
    .boolean()
    .optional()
    .describe("Manda o link por WhatsApp. É COBRADO por envio."),
  enviarPorEmail: z.boolean().optional(),
});

type EntradaSignatario = z.infer<typeof signatarioSchema>;

function paraSignatario(s: EntradaSignatario): Signatario {
  return {
    name: s.nome,
    email: s.email,
    phone_country: s.telefone ? "55" : undefined,
    phone_number: s.telefone?.replace(/\D/g, ""),
    cpf: s.cpf?.replace(/\D/g, ""),
    qualification: s.papel,
    auth_mode: s.autenticacao,
    send_automatic_whatsapp: s.enviarPorWhatsapp,
    send_automatic_email: s.enviarPorEmail,
  };
}

/**
 * Marca de ambiente em toda resposta que cria ou consulta documento.
 *
 * Não é enfeite: em sandbox o documento **não tem validade jurídica**, e nada
 * na resposta da ZapSign diz isso. Sem a marca, um agente geraria um contrato
 * de teste, mandaria o link ao cliente com toda a confiança, e o registro da
 * execução não guardaria nenhuma pista de que aquilo não valia nada.
 */
function marcaDeAmbiente(config: ZapSignConfig) {
  return config.ambiente === "sandbox"
    ? {
        ambiente: "sandbox" as const,
        avisoImportante:
          "AMBIENTE DE TESTES: este documento NÃO tem validade jurídica. Não trate como contrato válido nem diga ao cliente que está assinado de verdade.",
      }
    : { ambiente: "producao" as const };
}

/**
 * O que o cliente precisa receber: o link de cada signatário.
 *
 * `original_file` e `signed_file` ficam de fora de propósito — expiram em 60
 * minutos, e devolver ao modelo uma URL que morre antes de ele usar só gera
 * mensagem quebrada para o cliente.
 */
function formatarDocumento(doc: DocumentoCriado, config: ZapSignConfig) {
  return {
    ...marcaDeAmbiente(config),
    documentoId: doc.token,
    nome: doc.name,
    status: doc.status,
    signatarios: (doc.signers ?? []).map((s) => ({
      signatarioId: s.token,
      nome: s.name,
      situacao: normalizarStatusDeSignatario(s.status),
      linkParaAssinar: s.sign_url,
    })),
  };
}

export const zapsignIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.ZAPSIGN,
  label: "ZapSign",
  descricao:
    "Assinatura eletrônica: gera o contrato a partir de um modelo, preenche os campos e devolve o link de assinatura.",
  configSchema: zapsignConfigSchema,
  credentialLabel: "API Token (Configurações → Integrações na ZapSign)",

  async testarConexao(ctx) {
    const { cliente } = contexto(ctx);
    return cliente.testar();
  },

  tools: [
    // ─── Modelos ──────────────────────────────────────────────────────────
    {
      name: "zapsign_listar_modelos",
      categoria: "Modelos",
      description:
        "Lista os modelos de documento disponíveis para gerar contrato. Use quando não souber qual modelo existe ou como ele se chama exatamente.",
      inputSchema: z.object({}),
      async execute(_entrada, ctx) {
        const { cliente, config } = contexto(ctx);
        const { results } = await cliente.listarModelos();

        return {
          modelos: results
            .filter((m) => m.active)
            .map((m) => ({ id: m.token, nome: m.name })),
          apelidosCadastrados: config.modelos.map((m) => m.nome),
        };
      },
    },
    {
      name: "zapsign_ver_modelo",
      categoria: "Modelos",
      description:
        "Mostra QUAIS CAMPOS um modelo pede. Chame isto antes de gerar o contrato: os nomes das variáveis precisam bater exatamente, e é aqui que você descobre quais são e quais são obrigatórias.",
      inputSchema: z.object({
        modelo: z
          .string()
          .describe("Nome cadastrado do modelo, ou o id dele."),
      }),
      async execute(entrada, ctx) {
        const { modelo } = entrada as { modelo: string };
        const { cliente, config } = contexto(ctx);

        const { templateId, nomes } = resolverModelo(modelo, config);
        if (!templateId) {
          return { erro: `"${modelo}" não é um modelo conhecido.`, modelosCadastrados: nomes };
        }

        const detalhe = await cliente.detalharModelo(templateId);
        return {
          id: detalhe.token,
          nome: detalhe.name,
          campos: (detalhe.inputs ?? [])
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((i) => ({
              variavel: i.variable,
              rotulo: i.label,
              obrigatorio: Boolean(i.required),
            })),
        };
      },
    },

    // ─── Documentos ───────────────────────────────────────────────────────
    {
      name: "zapsign_gerar_contrato",
      categoria: "Documentos",
      description:
        "Gera o contrato a partir de um modelo, preenchendo os campos, e devolve o LINK DE ASSINATURA de cada signatário. É o caminho principal desta integração. Confira os campos com zapsign_ver_modelo antes.",
      requiresConfirmation: true,
      inputSchema: z.object({
        modelo: z.string().describe("Nome cadastrado do modelo, ou o id dele."),
        campos: z
          .array(
            z.object({
              variavel: z
                .string()
                .describe(
                  'Exatamente como veio de zapsign_ver_modelo, com as chaves: "{{NOME COMPLETO}}".',
                ),
              valor: z.string(),
            }),
          )
          .describe("Os valores que substituem as variáveis do modelo."),
        signatarios: z
          .array(signatarioSchema)
          .min(1)
          .describe("Quem assina. O primeiro é o principal."),
        nomeDoDocumento: z.string().optional(),
        prazoParaAssinar: z
          .string()
          .optional()
          .describe("Data limite, AAAA-MM-DD."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          modelo: string;
          campos: { variavel: string; valor: string }[];
          signatarios: EntradaSignatario[];
          nomeDoDocumento?: string;
          prazoParaAssinar?: string;
        };
        const { cliente, config } = contexto(ctx);

        const { templateId, nomes } = resolverModelo(args.modelo, config);
        if (!templateId) {
          return { erro: `"${args.modelo}" não é um modelo conhecido.`, modelosCadastrados: nomes };
        }

        const [principal, ...demais] = args.signatarios;

        // A criação por modelo aceita UM signatário no corpo; os outros entram
        // depois, um por chamada. Fazemos aqui para o agente não precisar
        // orquestrar isso — e não parar no meio, com contrato criado e metade
        // dos signatários faltando.
        const doc = await cliente.criarPorModelo({
          template_id: templateId,
          signer_name: principal.nome,
          signer_email: principal.email,
          signer_phone_country: principal.telefone ? "55" : undefined,
          signer_phone_number: principal.telefone?.replace(/\D/g, ""),
          send_automatic_email: principal.enviarPorEmail,
          send_automatic_whatsapp:
            principal.enviarPorWhatsapp ?? config.whatsappAutomatico,
          data: args.campos.map((c) => ({ de: c.variavel, para: c.valor })),
        });

        for (const s of demais) {
          await cliente.adicionarSignatario(doc.token, paraSignatario(s));
        }

        // Relê depois de acrescentar: a resposta da criação só traz o primeiro,
        // e o agente precisa do link de todos.
        const completo = demais.length
          ? await cliente.detalhar(doc.token)
          : doc;

        return {
          ...formatarDocumento(completo, config),
          observacao:
            "Mande o link ao signatário. Ele expira só quando o documento é assinado ou cancelado.",
        };
      },
    },
    {
      name: "zapsign_ver_documento",
      categoria: "Documentos",
      description:
        "Situação de um documento: quem já assinou, quem falta e o link de cada um. Use para responder 'já assinaram?' e para reenviar um link.",
      inputSchema: z.object({ documentoId: z.string().min(10) }),
      async execute(entrada, ctx) {
        const { documentoId } = entrada as { documentoId: string };
        const { cliente, config } = contexto(ctx);
        return formatarDocumento(await cliente.detalhar(documentoId), config);
      },
    },
    {
      name: "zapsign_listar_documentos",
      categoria: "Documentos",
      description:
        "Lista documentos da conta, opcionalmente por situação. Atenção: a ZapSign cacheia esta rota por 60 segundos, então documento recém-criado pode não aparecer — para esse caso use zapsign_ver_documento.",
      inputSchema: z.object({
        situacao: z.enum(["pending", "signed", "refused"]).optional(),
        emailDoSignatario: z.string().optional(),
        pagina: z.number().int().min(1).optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          situacao?: "pending" | "signed" | "refused";
          emailDoSignatario?: string;
          pagina?: number;
        };
        const { cliente, config } = contexto(ctx);
        const { count, results } = await cliente.listar({
          status: args.situacao,
          signer_email: args.emailDoSignatario,
          page: args.pagina ?? 1,
        });
        return {
          ...marcaDeAmbiente(config),
          total: count,
          documentos: results.map((d) => ({
            documentoId: d.token,
            nome: d.name,
            status: d.status,
          })),
        };
      },
    },
    {
      name: "zapsign_criar_documento_de_arquivo",
      categoria: "Documentos",
      description:
        "Cria documento para assinatura a partir de um PDF ou DOCX já pronto, acessível por URL pública. Use quando NÃO houver modelo — se houver, prefira zapsign_gerar_contrato.",
      requiresConfirmation: true,
      inputSchema: z.object({
        nome: z.string().min(3),
        urlDoArquivo: z.string().describe("URL pública do PDF ou DOCX."),
        signatarios: z.array(signatarioSchema).min(1),
        prazoParaAssinar: z.string().optional().describe("AAAA-MM-DD."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          nome: string;
          urlDoArquivo: string;
          signatarios: EntradaSignatario[];
          prazoParaAssinar?: string;
        };
        const { cliente, config } = contexto(ctx);

        const ehDocx = args.urlDoArquivo.toLowerCase().includes(".docx");
        const doc = await cliente.criarDocumento({
          name: args.nome,
          ...(ehDocx
            ? { url_docx: args.urlDoArquivo }
            : { url_pdf: args.urlDoArquivo }),
          signers: args.signatarios.map(paraSignatario),
          date_limit_to_sign: args.prazoParaAssinar,
        });
        return formatarDocumento(doc, config);
      },
    },
    {
      name: "zapsign_cancelar_documento",
      categoria: "Documentos",
      description:
        "Cancela um documento que ainda não foi assinado. Ele fica com marca d'água de cancelado e ninguém mais consegue assinar. Confirme com o cliente antes.",
      requiresConfirmation: true,
      inputSchema: z.object({
        documentoId: z.string().min(10),
        motivo: z.string().min(3).describe("Fica registrado no documento."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as { documentoId: string; motivo: string };
        const { cliente, config } = contexto(ctx);
        await cliente.cancelarDocumento(args.documentoId, args.motivo);
        return { ...marcaDeAmbiente(config), cancelado: true };
      },
    },

    // ─── Signatários ──────────────────────────────────────────────────────
    {
      name: "zapsign_adicionar_signatario",
      categoria: "Signatários",
      description:
        "Acrescenta um signatário a um documento que já existe, e devolve o link dele. Use quando aparecer alguém a mais para assinar.",
      requiresConfirmation: true,
      inputSchema: z.object({
        documentoId: z.string().min(10),
        signatario: signatarioSchema,
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          documentoId: string;
          signatario: EntradaSignatario;
        };
        const { cliente, config } = contexto(ctx);
        const novo = await cliente.adicionarSignatario(
          args.documentoId,
          paraSignatario(args.signatario),
        );
        return {
          ...marcaDeAmbiente(config),
          signatarioId: novo.token,
          linkParaAssinar: novo.sign_url,
        };
      },
    },
    {
      name: "zapsign_ver_signatario",
      categoria: "Signatários",
      description:
        "Situação de um signatário: se abriu o link, quantas vezes viu e se já assinou. Use para saber se vale a pena cobrar.",
      inputSchema: z.object({ signatarioId: z.string().min(10) }),
      async execute(entrada, ctx) {
        const { signatarioId } = entrada as { signatarioId: string };
        const { cliente, config } = contexto(ctx);
        const s = await cliente.detalharSignatario(signatarioId);
        return {
          ...marcaDeAmbiente(config),
          nome: s.name,
          situacao: normalizarStatusDeSignatario(s.status),
          vezesQueAbriu: s.times_viewed ?? 0,
          assinouEm: s.signed_at ?? null,
        };
      },
    },
    {
      name: "zapsign_corrigir_signatario",
      categoria: "Signatários",
      description:
        "Corrige nome, e-mail ou telefone de um signatário — e reenvia o link se o envio automático estiver ligado. Só funciona enquanto ele NÃO assinou.",
      requiresConfirmation: true,
      inputSchema: z.object({
        signatarioId: z.string().min(10),
        nome: z.string().optional(),
        email: z.string().optional(),
        telefone: z.string().optional().describe("Com DDD, só números."),
        reenviarPorWhatsapp: z.boolean().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          signatarioId: string;
          nome?: string;
          email?: string;
          telefone?: string;
          reenviarPorWhatsapp?: boolean;
        };
        const { cliente, config } = contexto(ctx);
        await cliente.atualizarSignatario(args.signatarioId, {
          name: args.nome,
          email: args.email,
          phone_country: args.telefone ? "55" : undefined,
          phone_number: args.telefone?.replace(/\D/g, ""),
          send_automatic_whatsapp: args.reenviarPorWhatsapp,
        } as Partial<Signatario>);
        return { ...marcaDeAmbiente(config), atualizado: true };
      },
    },
  ],
};
