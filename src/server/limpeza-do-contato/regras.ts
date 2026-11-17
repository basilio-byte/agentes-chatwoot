import { z } from "zod";

/**
 * Limpeza dos campos do contato quando a conversa é resolvida — as regras, puras.
 *
 * Pedido do Diego (task 17twvjx2j0q, 17/11/2026): a task do CRM nasceu com CANAL
 * "Site" porque o contato carregava o canal de um cadastro antigo, e o "cadastro
 * completo" copia os atributos do contato para a task. A resposta dele: *"limpar
 * os campos editáveis do Chatwoot após a conversa ser resolvida… o que não mexe:
 * dados pessoais, ex. e-mail, CPF, permanecem"*. Decisões do usuário no mesmo
 * dia: a lista abaixo (com Observações), e limpar 15 minutos DEPOIS da resolução.
 *
 * - **Os campos são do atendimento, não da pessoa**: canal, campanha,
 *   qualificação, produto, espaço, valores e datas do negócio, observações. O que
 *   identifica a pessoa (`NUNCA_LIMPAR`) não sai nem se alguém puser na lista.
 * - **15 minutos depois**: o agente de CRM lê esses campos para montar a task
 *   quando alguém marca o checkbox — em 30 dias, 8 de 119 marcações vieram com a
 *   conversa resolvida menos de 10 minutos depois. Com a espera, ele lê antes.
 * - **Só com a conversa ainda resolvida e o contato sem outra conversa aberta**:
 *   reabriu, o atendimento continua; outra conversa aberta, os campos podem ser
 *   dela.
 */

export const PROVIDER_LIMPEZA = "LIMPEZA_CONTATO";

/** Quanto esperar depois da resolução. */
export const ESPERA_MS = 15 * 60_000;
/** Resolução que ficou pendente mais do que isto (worker fora do ar) não limpa mais. */
export const VALIDADE_MS = 48 * 60 * 60_000;
/** O relógio da rodada. */
export const CONFERIR_A_CADA_MS = 2 * 60_000;
/** Teto de contatos por rodada: cada um custa até quatro chamadas ao Chatwoot. */
export const POR_RODADA = 40;

/** A lista decidida em 17/11/2026: a chave de cada atributo no Chatwoot. */
export const CAMPOS_PADRAO = [
  "canal",
  "campanha",
  "qualificao",
  "avaliao_atendimento",
  "categoria_de_servio",
  "tipo_de_produto_novo",
  "espao",
  "faturamento",
  "valor_contrato",
  "data_inicio_contrato",
  "vencimento",
  "informaes_complementares",
  "observaes",
];

/**
 * Dados pessoais e de ligação com outros sistemas: nunca limpos. As chaves são as
 * do Chatwoot (a acentuação some na chave: "Aniversário" é `aniversrio`).
 */
export const NUNCA_LIMPAR = [
  "nome_completo",
  "email",
  "cpf",
  "cnpj",
  "cep",
  "aniversrio",
  "estado_civil",
  "responsvel",
  "instagram",
  "endereo_scio",
  "sede_da_empresa",
  "id_da_empresa",
  "link_conexa",
  "id_clickup",
  "doc_tipo",
  "doc_status",
  "doc_conferido_em",
  "doc_validade",
  "waha_whatsapp_chat_id",
  "waha_whatsapp_jid",
  "waha_whatsapp_lid",
];

const CHAVE = /^[a-z0-9_]+$/;

export const configDaLimpezaSchema = z.object({
  ligada: z.boolean().default(false),
  campos: z
    .array(z.string().regex(CHAVE))
    .min(1)
    .refine((cs) => cs.every((c) => !NUNCA_LIMPAR.includes(c)))
    .default(CAMPOS_PADRAO),
});

export type ConfigDaLimpeza = z.infer<typeof configDaLimpezaSchema>;

/** A configuração mora na linha do Chatwoot, na chave `limpezaDoContato`. */
export function lerConfigDaLimpeza(configDoChatwoot: unknown): ConfigDaLimpeza {
  const bruto =
    configDoChatwoot && typeof configDoChatwoot === "object"
      ? (configDoChatwoot as Record<string, unknown>).limpezaDoContato
      : undefined;
  const lido = configDaLimpezaSchema.safeParse(bruto ?? {});
  return lido.success ? lido.data : configDaLimpezaSchema.parse({});
}

/** O formulário vira config, ou a recusa em texto para quem preencheu. */
export function configDoFormulario(args: {
  ligada: boolean;
  campos: string;
}): { config: ConfigDaLimpeza } | { erro: string } {
  const campos = [
    ...new Set(
      args.campos
        .split(/[\s,;]+/)
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!campos.length) return { erro: "Informe pelo menos um campo para limpar." };
  const tortos = campos.filter((c) => !CHAVE.test(c));
  if (tortos.length) {
    return {
      erro: `${tortos.join(", ")}: use a CHAVE do atributo no Chatwoot (minúsculas, números e _), não o nome que aparece na tela.`,
    };
  }
  const pessoais = campos.filter((c) => NUNCA_LIMPAR.includes(c));
  if (pessoais.length) {
    return { erro: `${pessoais.join(", ")}: dado pessoal ou de ligação, nunca é limpo.` };
  }
  return { config: { ligada: args.ligada, campos } };
}

/** A chave da limpeza de UMA resolução: reabrir e resolver de novo é outra. */
export function chaveDaLimpeza(conversa: number, resolvidaEm: number): string {
  return `conversa:${conversa}:${resolvidaEm}`;
}

function vazio(valor: unknown) {
  return valor === undefined || valor === null || (typeof valor === "string" && !valor.trim());
}

/** Os campos da lista que o contato tem preenchidos agora. */
export function camposParaLimpar(atributos: Record<string, unknown>, campos: string[]): string[] {
  return campos.filter((c) => !NUNCA_LIMPAR.includes(c) && !vazio(atributos[c]));
}

export type DecisaoDaLimpeza = { acao: "limpar" } | { acao: "pular"; motivo: string };

/** Pode limpar? Conversa conferida ao vivo, e as outras conversas do mesmo contato. */
export function decidirLimpeza(args: {
  conversaId: number;
  status: string | null;
  contactId: number | null;
  outras: { id: number; status: string | null }[];
}): DecisaoDaLimpeza {
  if ((args.status ?? "").toLowerCase() !== "resolved") {
    return { acao: "pular", motivo: "a conversa foi reaberta: o atendimento continua" };
  }
  if (args.contactId == null) return { acao: "pular", motivo: "a conversa está sem contato" };
  const aberta = args.outras.find(
    (c) => c.id !== args.conversaId && (c.status ?? "").toLowerCase() !== "resolved",
  );
  if (aberta) {
    return {
      acao: "pular",
      motivo: `o contato tem outra conversa em andamento (#${aberta.id}): os campos podem ser dela`,
    };
  }
  return { acao: "limpar" };
}
