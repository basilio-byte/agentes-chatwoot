import { z } from "zod";

/**
 * Registro automático do lead no CRM Comercial — as regras, puras.
 *
 * Pedido do Diego (Formulário Bugs, 25 e 26/11/2026: três tasks "Não subiu no
 * CRM"). O CRM Comercial só recebia o lead TARDE, e cada agente comercial num
 * momento diferente: o Everton só cria task quando ele mesmo fecha a venda (109
 * leads passaram ao rodízio em 30 dias sem task nenhuma), Salas Privativas depois
 * das seis perguntas, Salas de Reunião no rodízio ou depois de reservar. Lead que
 * ia para uma pessoa da equipe dependia de alguém marcar o checkbox
 * `passar_para_crm` — e ninguém marcava na hora.
 *
 * Decisão do usuário (26/11/2026): o SISTEMA registra, em segundo plano, para o
 * cliente não esperar os ~40 s do CRM no turno em que escolheu o serviço.
 *
 * - **Quando nasce o pendente:** o robô passou a conversa a um agente comercial
 *   da lista (`agentes`) — é a escolha do serviço no menu. Um por atendimento.
 * - **Quando registra:** a conversa está com uma PESSOA da equipe e ainda não tem
 *   task. É o que o checkbox faz, e pelo mesmo caminho: o vendedor da task é o
 *   dono da conversa.
 * - ⚠ **Com o robô ainda conduzindo, ESPERA.** O CRM, sem vendedor, põe o Diego,
 *   e quando o especialista registra depois com o vendedor do rodízio o CRM
 *   responde "JÁ EXISTIA" sem trocar o vendedor: a task ficaria no nome errado.
 *   O lead que fica com o robô já tem caminho: venda vira task "Auto Venda" e
 *   abandono vira "perdido" pelo follow-up, que cria a task.
 * - **Não registra:** se a conversa já tem task (de qualquer agente), se virou
 *   suporte (acionou o CRM de Atendimentos) ou se passou a um agente que não é
 *   comercial.
 */

export const PROVIDER_LEAD = "LEAD_CRM";

/** Folga antes da primeira olhada: o especialista que registra no próprio turno chega antes. */
export const ESPERA_MS = 3 * 60_000;
/** Pendente com o robô por mais do que isto sai da fila: o lead seguiu outro caminho. */
export const VALIDADE_MS = 24 * 60 * 60_000;
/** O relógio da rodada. */
export const CONFERIR_A_CADA_MS = 3 * 60_000;
/** Teto de conversas olhadas por rodada (cada uma custa uma leitura ao Chatwoot). */
export const POR_RODADA = 30;
/** Teto de registros por rodada: cada um é uma execução do agente de CRM (~40 s). */
export const REGISTROS_POR_RODADA = 4;

/** Os agentes que vendem, por chave (a chave não muda quando o agente é renomeado). */
export const AGENTES_PADRAO = [
  "vendedor-ev",
  "agente-de-salas-de-reuniao-atendimentos-auditorios",
  "agente-de-salas-privativas",
  "agente-seabox",
  "agente-programa-de-parceria",
];
export const AGENTE_DO_CRM_PADRAO = "agente-crm-comercial";
/** Quem é acionado quando o atendimento é suporte: sinal de que não é lead. */
export const AGENTE_DO_CRM_DE_SUPORTE = "agente-crm-atendimentos";

const CHAVE = /^[a-z0-9-]+$/;

export const configDoLeadSchema = z.object({
  modo: z.enum(["desligado", "sombra", "ligado"]).default("desligado"),
  agentes: z.array(z.string().regex(CHAVE)).min(1).default(AGENTES_PADRAO),
  agenteDoCrm: z.string().regex(CHAVE).default(AGENTE_DO_CRM_PADRAO),
});

export type ConfigDoLead = z.infer<typeof configDoLeadSchema>;
export type ModoDoLead = ConfigDoLead["modo"];

/** A configuração mora na linha do Chatwoot, na chave `leadNoCrm`. */
export function lerConfigDoLead(configDoChatwoot: unknown): ConfigDoLead {
  const bruto =
    configDoChatwoot && typeof configDoChatwoot === "object"
      ? (configDoChatwoot as Record<string, unknown>).leadNoCrm
      : undefined;
  const lido = configDoLeadSchema.safeParse(bruto ?? {});
  return lido.success ? lido.data : configDoLeadSchema.parse({});
}

/** O formulário vira config, ou a recusa em texto para quem preencheu. */
export function configDoFormulario(args: {
  modo: string;
  agentes: string;
  agenteDoCrm: string;
}): { config: ConfigDoLead } | { erro: string } {
  const modo = configDoLeadSchema.shape.modo.safeParse(args.modo);
  if (!modo.success) return { erro: "Escolha desligado, sombra ou ligado." };

  const agentes = [
    ...new Set(
      // Sem quebrar em espaço: "Everton - Vendedor EV" viraria pedaços com cara
      // de chave ("-", "ev") em vez de ser recusado como nome.
      args.agentes
        .split(/[\r\n,;]+/)
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!agentes.length) return { erro: "Informe pelo menos um agente comercial." };
  const agenteDoCrm = args.agenteDoCrm.trim().toLowerCase();
  const tortos = [...agentes, agenteDoCrm].filter((a) => !CHAVE.test(a));
  if (tortos.length || !agenteDoCrm) {
    return {
      erro: `${tortos.join(", ") || "agente do CRM vazio"}: use a CHAVE do agente (minúsculas, números e hífen), como aparece na tela dele.`,
    };
  }
  if (agentes.includes(agenteDoCrm)) {
    return { erro: "O agente do CRM não pode estar na lista de agentes comerciais." };
  }
  return { config: { modo: modo.data, agentes, agenteDoCrm } };
}

/** Um pendente por atendimento: resolver e reabrir é outro atendimento. */
export function chaveDoLead(conversa: number, atendimentoDesde: Date | null): string {
  return `conversa:${conversa}:${atendimentoDesde ? atendimentoDesde.getTime() : 0}`;
}

export type DecisaoDoLead =
  | { acao: "registrar" }
  | { acao: "esperar"; motivo: string }
  | { acao: "encerrar"; resultado: string; motivo: string };

/**
 * O que fazer com um lead pendente, a partir do que foi lido ao vivo.
 *
 * A ordem importa: task que já existe vence tudo (é o registro feito por outro
 * caminho), e o dono só é olhado depois de afastar suporte e agente não
 * comercial.
 */
export function decidirRegistro(args: {
  /** `open`, `pending`, `resolved`, `snoozed`... como o Chatwoot devolve. */
  status: string | null;
  /** `true` pessoa, `false` robô, `undefined` tipo desconhecido, `null` sem dono. */
  donoEhPessoa: boolean | undefined | null;
  tasksNaConversa: number;
  virouSuporte: boolean;
  /** O agente que está com a conversa no nosso banco ainda é um dos comerciais (ou nenhum). */
  agenteComercial: boolean;
  idadeMs: number;
}): DecisaoDoLead {
  if (args.tasksNaConversa > 0) {
    return { acao: "encerrar", resultado: "já registrada", motivo: "a conversa já tem task no CRM" };
  }
  if (args.virouSuporte) {
    return {
      acao: "encerrar",
      resultado: "suporte",
      motivo: "o atendimento virou suporte (acionou o CRM de Atendimentos)",
    };
  }
  if (!args.agenteComercial) {
    return {
      acao: "encerrar",
      resultado: "não é lead",
      motivo: "a conversa passou para um agente que não é comercial",
    };
  }
  // Só pessoa CONFIRMADA: dono de tipo desconhecido não vira vendedor de ninguém.
  if (args.donoEhPessoa === true) return { acao: "registrar" };

  if ((args.status ?? "").toLowerCase() === "resolved") {
    return {
      acao: "encerrar",
      resultado: "sem pessoa",
      motivo: "a conversa foi resolvida sem passar por uma pessoa da equipe",
    };
  }
  if (args.idadeMs >= VALIDADE_MS) {
    return {
      acao: "encerrar",
      resultado: "expirada",
      motivo: "ficou 24 h com o robô: venda e abandono têm o próprio registro",
    };
  }
  return {
    acao: "esperar",
    motivo:
      args.donoEhPessoa === undefined
        ? "dono de tipo desconhecido: espera ficar claro"
        : "o robô ainda conduz a conversa",
  };
}

/** As tasks que a conversa já tem: `clickup_criar_tarefa` que criou ou achou a existente. */
export function contarTasks(saidas: unknown[]): number {
  return saidas.filter((s) => {
    if (typeof s !== "object" || s === null || Array.isArray(s)) return false;
    const { criada, jaExistia } = s as Record<string, unknown>;
    return criada === true || jaExistia === true;
  }).length;
}

/** Nome sem quebra de linha nem colchete: entra num cabeçalho que o modelo lê. */
function limpo(texto: string | null | undefined): string {
  return (texto ?? "").replace(/[\r\n[\]]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * A mensagem que abre o turno do agente de CRM.
 *
 * ⚠ Começa como a do checkbox, de propósito: o prompt do CRM Comercial tem a
 * seção "Quando vier do checkbox", que monta os dados pela transcrição, usa o
 * DONO da conversa como vendedor e procura task pelo telefone antes de criar — é
 * exatamente o registro que se quer aqui. A primeira linha diz que quem marcou
 * foi o sistema, e por quê, para não afirmar o que não aconteceu.
 */
export function mensagemDoLead(args: {
  conversationId: number;
  link: string | null;
  contatoNome: string | null;
  telefone: string | null;
  dono: string | null;
  agenteComercial: string;
  atendentes: string[];
  transcricao: string;
  quando: string;
}): string {
  const telefone = (args.telefone ?? "").replace(/[^\d+\s()-]/g, "").trim();
  return [
    "[Checkbox marcado no Chatwoot — registro automático do lead: o cliente escolheu um serviço comercial, a conversa está com uma pessoa da equipe e ainda não tem task no CRM, então o sistema fez o mesmo que a marcação do checkbox passar_para_crm e te acionou em segundo plano. Nada do que você escrever vai para o cliente.]",
    "Checkbox marcado: passar_para_crm (pelo sistema)",
    `Conversa: #${args.conversationId}`,
    ...(args.link ? [`Link: ${args.link}`] : []),
    `Marcado em: ${args.quando}`,
    `Contato: ${limpo(args.contatoNome) || "sem nome"}`,
    `Telefone do contato: ${telefone || "não informado"}`,
    `Dono da conversa no Chatwoot: ${limpo(args.dono) || "ninguém"}`,
    `Agente que atendeu o lead: ${limpo(args.agenteComercial)}`,
    `Quem da equipe respondeu ao cliente: ${
      args.atendentes.length > 0 ? args.atendentes.map(limpo).join(", ") : "ninguém"
    }`,
    "",
    args.transcricao,
  ].join("\n");
}
