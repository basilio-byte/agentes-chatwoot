import type { ClickUpCampoPersonalizado } from "@/server/integrations/clickup/tipos";

/**
 * Follow-up do lead que parou de responder — as regras puras.
 *
 * Pedido do Diego (task 17twvjx1037, comentário de 19/11/2026), depois da
 * conversa 15070: o lead veio de um anúncio, conversou meia hora com o agente
 * de Salas Privativas, desistiu e fechou com um concorrente — *"por falta de
 * follow-up ou sugestão de outro espaço"*. O fluxo que ele escreveu:
 *
 *   30 min  → perguntar se o lead deseja seguir com a contratação;
 *   +30 min → perguntar se ele ainda está interessado;
 *   +30 min → encerrar o contato e perder no CRM com motivo "Não respondeu".
 *
 * ⚠ **O agente não roda sozinho**: ele só pensa quando o cliente escreve. Por
 * isso a cadeia inteira é do SISTEMA: o agente registra UMA vez (as duas
 * mensagens e o produto) e o vigia executa as três etapas, cada uma registrando
 * a seguinte. Qualquer mensagem do cliente, ou de alguém da equipe, derruba a
 * etapa pendente pelas travas de sempre (`decidirPrazo`) — e o agente, ao
 * responder, registra a cadeia de novo, do começo.
 *
 * Medido antes de construir (24/11/2026): dos 23 leads que pararam de responder
 * e foram passados a uma pessoa pelo prazo do cliente nos 30 dias anteriores, 3
 * receberam mensagem da equipe na primeira hora, 8 só depois de mais de um dia
 * e 5 nunca.
 */

export const ETAPAS_DO_FOLLOW_UP = 3;

export type EtapaDoFollowUp = 1 | 2 | 3;

export type AcaoDeFollowUp = {
  tipo: "follow_up";
  /** A etapa que este prazo executa quando vencer. */
  etapa: EtapaDoFollowUp;
  /** A 1ª e a 2ª mensagem, escritas pelo agente no registro. */
  mensagens: [string, string];
  /** O produto como o CRM o escreve — só para registrar o lead perdido. */
  produto: string | null;
};

/** A etapa seguinte da cadeia; `null` depois da última. */
export function proximaEtapa(acao: AcaoDeFollowUp): AcaoDeFollowUp | null {
  if (acao.etapa >= ETAPAS_DO_FOLLOW_UP) return null;
  return { ...acao, etapa: (acao.etapa + 1) as EtapaDoFollowUp };
}

/** A mensagem que a etapa manda ao cliente; a última não manda nada. */
export function mensagemDaEtapa(acao: AcaoDeFollowUp): string | null {
  if (acao.etapa === 3) return null;
  return acao.mensagens[acao.etapa - 1].trim();
}

/** O que a nota interna diz quando uma mensagem de follow-up sai. */
export function notaDaMensagem(args: {
  etapa: 1 | 2;
  minutos: number;
  motivo: string;
}): string {
  const depois =
    args.etapa === 1
      ? `Se continuar sem responder, a 2ª mensagem sai em ${args.minutos} min.`
      : `Se continuar sem responder, em ${args.minutos} min a conversa é encerrada e o lead fica como perdido no CRM (motivo "Não respondeu").`;
  return [
    `⏱️ Follow-up ${args.etapa} de ${ETAPAS_DO_FOLLOW_UP}: cliente sem responder há ${args.minutos} min, mensagem enviada. ${depois}`,
    `Motivo registrado pelo agente: ${args.motivo}`,
  ].join("\n");
}

// --- O CRM ----------------------------------------------------------------

/** O CRM Comercial: é lá que a equipe marca o lead perdido. */
export const LISTA_DO_CRM_COMERCIAL = "901302419821";

export const CAMPO_STATUS_CRM = "Status CRM";
export const CAMPO_MOTIVO_DE_PERDA = "Motivo de perda";
export const CAMPO_DATA_PERDIDO = "Data perdido";
export const STATUS_PERDIDO = "Perdido";
export const STATUS_GANHO = "Ganho";
export const MOTIVO_NAO_RESPONDEU = "Não respondeu";

/**
 * Os rótulos do campo TIPO DE PRODUTO, com a categoria e o tipo de atendimento
 * que o CRM Comercial usa para cada um (os mesmos do prompt do CRM).
 */
const PRODUTOS: Record<string, { categoria: string; atendimento: string }> = {
  "Sala de reunião": { categoria: "Serviços de espaço", atendimento: "Reserva de Salas" },
  "Sala de atendimento": { categoria: "Serviços de espaço", atendimento: "Reserva de Salas" },
  Cabine: { categoria: "Serviços de espaço", atendimento: "Reserva de Salas" },
  Auditório: { categoria: "Serviços de espaço", atendimento: "Reserva de Salas" },
  "Sala Privativa": { categoria: "Salas privativas", atendimento: "Atendimento Comercial" },
  "SeaBox Básico": { categoria: "SeaBox", atendimento: "Atendimento Comercial" },
  "SeaBox Pro": { categoria: "SeaBox", atendimento: "Atendimento Comercial" },
  "Endereço Fiscal Litoral": { categoria: "Serviços de endereço", atendimento: "Atendimento Comercial" },
  "Endereço Fiscal Batial": { categoria: "Serviços de endereço", atendimento: "Atendimento Comercial" },
  "Endereço Fiscal Abissal": { categoria: "Serviços de endereço", atendimento: "Atendimento Comercial" },
};

export const PRODUTOS_DO_CRM = Object.keys(PRODUTOS);

const comparavel = (texto: unknown) =>
  String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * O rótulo do produto como está no CRM, ou `null`. Sem acento, caixa nem espaço
 * extra; "endereço fiscal" sem o plano não é rótulo — vira `null`, e a task
 * nasce com "Não definido", como o CRM faz.
 */
export function rotuloDoProduto(texto: string | null | undefined): string | null {
  const alvo = comparavel(texto);
  if (!alvo) return null;
  return PRODUTOS_DO_CRM.find((p) => comparavel(p) === alvo) ?? null;
}

/** Os campos de classificação da task do lead perdido. */
export function classificacaoDoProduto(produto: string | null): {
  produto: string;
  categoria: string;
  atendimento: string;
} {
  const rotulo = rotuloDoProduto(produto);
  if (!rotulo) {
    return { produto: "Não definido", categoria: "Não Definido", atendimento: "Atendimento Comercial" };
  }
  return { produto: rotulo, ...PRODUTOS[rotulo] };
}

/**
 * O celular no formato que o CRM grava (`+55 84 998765432`), ou `null` quando
 * não é número brasileiro com DDD.
 */
export function celularDoCrm(telefone: string | null | undefined): string | null {
  const digitos = String(telefone ?? "").replace(/\D/g, "");
  const nacional =
    digitos.startsWith("55") && digitos.length >= 12 ? digitos.slice(2) : digitos;
  if (nacional.length !== 10 && nacional.length !== 11) return null;
  return `+55 ${nacional.slice(0, 2)} ${nacional.slice(2)}`;
}

/** O nome da opção escolhida num campo de lista: a API devolve o id ou o índice. */
function opcaoDe(campo: ClickUpCampoPersonalizado | undefined, valor: unknown): string | null {
  if (!campo || valor === undefined || valor === null || valor === "") return null;
  const opcoes = (campo.type_config?.options ?? []) as Array<{
    id?: string;
    name?: string;
    label?: string;
    orderindex?: number | string;
  }>;
  const achada = opcoes.find(
    (o) => o.id === valor || (o.orderindex !== undefined && String(o.orderindex) === String(valor)),
  );
  return achada?.name ?? achada?.label ?? null;
}

export type PerdaDecidida =
  | { acao: "marcar"; campos: { campo: string; valor: string }[] }
  | { acao: "deixar"; motivo: string };

/**
 * O que a perda escreve numa task do CRM.
 *
 * - **Ganho não vira perdido**: pagamento ou venda marcada pela equipe vale
 *   mais que um silêncio de uma hora e meia.
 * - **Perdido continua como está**: a equipe (ou uma cadeia anterior) já deu o
 *   lead como perdido, com o motivo dela.
 * - **Motivo e data só se estiverem vazios** — a doutrina de todo o cadastro: o
 *   que uma pessoa escreveu vale mais.
 * - Campo que a lista não tem fica de fora; sem o Status CRM, não há o que marcar.
 */
export function decidirPerda(args: {
  campos: ClickUpCampoPersonalizado[];
  /** O valor de cada campo da task, pelo NOME do campo. */
  valores: Record<string, unknown>;
  ganha: boolean;
  hoje: string;
}): PerdaDecidida {
  const porNome = (nome: string) => args.campos.find((c) => comparavel(c.name) === comparavel(nome));
  const vazio = (campo: ClickUpCampoPersonalizado) => {
    const v = args.valores[campo.name];
    return v === undefined || v === null || v === "";
  };

  const status = porNome(CAMPO_STATUS_CRM);
  if (!status) return { acao: "deixar", motivo: `a lista não tem o campo ${CAMPO_STATUS_CRM}` };

  const atual = comparavel(opcaoDe(status, args.valores[status.name]));
  if (args.ganha || atual === comparavel(STATUS_GANHO)) {
    return { acao: "deixar", motivo: "a task já está como ganha" };
  }
  if (atual === comparavel(STATUS_PERDIDO)) {
    return { acao: "deixar", motivo: "a task já estava como perdida" };
  }

  const campos: { campo: string; valor: string }[] = [{ campo: status.name, valor: STATUS_PERDIDO }];
  const motivo = porNome(CAMPO_MOTIVO_DE_PERDA);
  if (motivo && vazio(motivo)) campos.push({ campo: motivo.name, valor: MOTIVO_NAO_RESPONDEU });
  const data = porNome(CAMPO_DATA_PERDIDO);
  if (data && vazio(data)) campos.push({ campo: data.name, valor: args.hoje });
  return { acao: "marcar", campos };
}

/** O Status CRM que a task tem agora, pelo nome da opção. */
export function statusCrmDaTarefa(
  campos: Array<{ id: string; name?: string | null; value?: unknown; type_config?: { options?: unknown[] } | null }>,
): string | null {
  const campo = campos.find((c) => comparavel(c.name) === comparavel(CAMPO_STATUS_CRM));
  if (!campo) return null;
  return opcaoDe(
    { id: campo.id, name: campo.name ?? "", type: "drop_down", type_config: campo.type_config as never },
    campo.value,
  );
}

/** O comentário que fica na task: por que ela virou perdida, e de onde veio. */
export function comentarioDaPerda(args: {
  agente: string;
  minutos: number;
  linkDaConversa: string | null;
  criadaAgora: boolean;
}): string {
  const total = args.minutos * ETAPAS_DO_FOLLOW_UP;
  return [
    `⏱️ Lead marcado como perdido pelo follow-up automático do agente ${args.agente}: o cliente parou de responder, recebeu duas mensagens de follow-up (a cada ${args.minutos} min) e ficou ${total} min sem responder. Motivo de perda: "${MOTIVO_NAO_RESPONDEU}".`,
    args.criadaAgora
      ? "A task foi criada agora para o registro: o lead parou antes de o agente registrá-lo no CRM."
      : null,
    args.linkDaConversa ? `Conversa: ${args.linkDaConversa}` : null,
    "Se o cliente voltar a escrever, a conversa reabre e o atendimento recomeça.",
  ]
    .filter(Boolean)
    .join("\n");
}
