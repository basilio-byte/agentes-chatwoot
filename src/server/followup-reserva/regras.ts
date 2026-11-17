import { agoraEmSaoPaulo, inicioDoDiaEmSaoPaulo, somarDias } from "@/lib/tempo";
import type { MensagemChatwoot } from "@/server/integrations/chatwoot/client";
import { ehResolvida, humanidadeDoDono } from "@/server/integrations/chatwoot/regras";
import type { FollowupConfig } from "./config";

/**
 * Follow-up da reserva que um agente criou e faturou — as regras, puras.
 *
 * Pedido do Régis (17/11/2026, conversa 11708): *"o cliente reserva mas a gente
 * não tem a comprovação que ele vem; esse por exemplo fez uma reserva pra hoje,
 * mas não pagou ainda; inserir tipo um followup pra confirmar a vinda dele e o
 * pagamento"*. Decisões do usuário no mesmo dia: só a reserva NÃO paga recebe, e
 * perto do horário.
 *
 * - **A reserva é a que um AGENTE criou numa conversa** (`conexa_criar_reserva`
 *   com `criada: true`), com a cobrança que ele gerou (`conexa_faturar_reserva`)
 *   — a mesma leitura da venda autônoma. Reserva feita pela equipe é dela.
 * - **Quando:** `horasAntesDoInicio` antes do começo, mas nunca depois de
 *   `JANELA_SEGURA_H` horas da última mensagem do cliente — a janela de 24 h do
 *   WhatsApp oficial; depois dela a mensagem livre não chega —, nunca fora do
 *   horário de envio, e nunca antes de `minutosAposReserva` depois de reservar.
 *   Sem instante que caiba em tudo isso, não há follow-up.
 * - **Pago é o que o Conexa diz**, lido na hora: a reserva paga, do pacote de
 *   horas ou cancelada não recebe nada, e a cobrança paga também não.
 * - **Nunca por cima de uma pessoa**: com alguém da equipe dono da conversa
 *   aberta, quem recebe é essa pessoa, numa nota interna. Conversa em andamento
 *   (alguém escreveu há pouco, ou o cliente espera resposta) espera a rodada
 *   seguinte.
 */

export const PROVIDER_FOLLOWUP = "FOLLOWUP_RESERVA";

/** O relógio da rodada: o follow-up é de horas, cinco minutos de atraso não pesam. */
export const CONFERIR_A_CADA_MS = 5 * 60_000;
/** Até onde a rodada olha para trás nas reservas que os agentes criaram. */
export const DIAS_PARA_TRAS = 30;
/**
 * A janela de 24 h do WhatsApp oficial, com folga: a mensagem livre só sai até
 * 22 h depois da última mensagem do cliente, para uma rodada atrasada ainda caber.
 */
export const JANELA_SEGURA_H = 22;
/** Passado disto, a janela pode estar fechada: não manda nada ao cliente. */
export const JANELA_LIMITE_H = 23;
/** A reserva começa em menos do que isto: tarde demais para perguntar. */
export const MINUTOS_MINIMOS_ANTES_DO_INICIO = 30;
/** Alguém escreveu há menos do que isto: a conversa está em andamento. */
export const MINUTOS_DE_CONVERSA_ATIVA = 10;
/** Teto de reservas conferidas no Conexa e no Chatwoot por rodada. */
export const RESERVAS_POR_RODADA = 10;
/** Reserva "reservado" mais velha que isto é de uma rodada que caiu no meio. */
export const RESERVA_ABANDONADA_MS = 10 * 60_000;

const MINUTO = 60_000;
const HORA = 60 * MINUTO;

/** A chave do desfecho de uma reserva. A sombra tem a sua: ensaiar não impede o envio de verdade. */
export function chaveDaReserva(reservaId: number, modo: FollowupConfig["modo"]): string {
  return modo === "sombra" ? `sombra:reserva:${reservaId}` : `reserva:${reservaId}`;
}

/** A hora cheia (0–23) em São Paulo. */
function horaEmSaoPaulo(instante: Date): number {
  return Number(agoraEmSaoPaulo(instante).hora.slice(0, 2));
}

function emHora(dia: string, hora: number): Date {
  return new Date(inicioDoDiaEmSaoPaulo(dia).getTime() + hora * HORA);
}

export function dentroDoHorarioDeEnvio(
  instante: Date,
  config: Pick<FollowupConfig, "horaDeInicio" | "horaDeFim">,
): boolean {
  const hora = horaEmSaoPaulo(instante);
  return hora >= config.horaDeInicio && hora < config.horaDeFim;
}

/** O último instante de envio permitido que não passa de `instante`. */
export function ultimoInstantePermitido(
  instante: Date,
  config: Pick<FollowupConfig, "horaDeInicio" | "horaDeFim">,
): Date {
  if (dentroDoHorarioDeEnvio(instante, config)) return instante;
  const dia = agoraEmSaoPaulo(instante).iso;
  const hora = horaEmSaoPaulo(instante);
  // Um minuto antes do fim: "até as 20h" quer dizer que às 20h já não sai.
  const fimDoDia = (d: string) => new Date(emHora(d, config.horaDeFim).getTime() - MINUTO);
  return hora < config.horaDeInicio ? fimDoDia(somarDias(dia, -1)) : fimDoDia(dia);
}

/** O primeiro instante de envio permitido a partir de `instante`. */
export function primeiroInstantePermitido(
  instante: Date,
  config: Pick<FollowupConfig, "horaDeInicio" | "horaDeFim">,
): Date {
  if (dentroDoHorarioDeEnvio(instante, config)) return instante;
  const dia = agoraEmSaoPaulo(instante).iso;
  const hora = horaEmSaoPaulo(instante);
  return hora < config.horaDeInicio
    ? emHora(dia, config.horaDeInicio)
    : emHora(somarDias(dia, 1), config.horaDeInicio);
}

/**
 * Quando o follow-up sai, ou `null` se não há instante que caiba em todas as
 * réguas (a reserva começa cedo demais, a janela fecha antes de o horário de
 * envio abrir…).
 */
export function momentoDoFollowup(args: {
  inicio: Date;
  criadaEm: Date;
  /** A última mensagem do cliente: é dela que a janela de 24 h conta. */
  ultimaDoCliente: Date;
  config: Pick<FollowupConfig, "horasAntesDoInicio" | "minutosAposReserva" | "horaDeInicio" | "horaDeFim">;
}): Date | null {
  const { inicio, criadaEm, ultimaDoCliente, config } = args;
  const fimDaJanela = ultimaDoCliente.getTime() + JANELA_SEGURA_H * HORA;
  const limite = inicio.getTime() - MINUTOS_MINIMOS_ANTES_DO_INICIO * MINUTO;

  const ideal = Math.min(inicio.getTime() - config.horasAntesDoInicio * HORA, fimDaJanela);
  let momento = ultimoInstantePermitido(new Date(ideal), config).getTime();

  const piso = primeiroInstantePermitido(
    new Date(criadaEm.getTime() + config.minutosAposReserva * MINUTO),
    config,
  ).getTime();
  if (momento < piso) momento = piso;

  if (momento > fimDaJanela || momento > limite) return null;
  return new Date(momento);
}

/** A última mensagem do cliente na página lida, ou `null` se ela não estiver ali. */
export function ultimaMensagemDoCliente(mensagens: MensagemChatwoot[]): Date | null {
  let maior = 0;
  for (const m of mensagens) {
    if (m.message_type === 0 && typeof m.created_at === "number" && m.created_at > maior) {
      maior = m.created_at;
    }
  }
  return maior ? new Date(maior * 1000) : null;
}

export type DecisaoDoEnvio =
  /** Volta na rodada seguinte. */
  | { acao: "aguardar"; motivo: string }
  | { acao: "enviar" }
  /** Uma pessoa está com a conversa: ela recebe a nota, o cliente não recebe nada. */
  | { acao: "avisar-quem-atende"; quem: string | null }
  /** Não sai mais: fica a nota interna e o desfecho. */
  | { acao: "desistir"; motivo: string };

/**
 * O que fazer com a conversa da reserva, lida ao vivo, na hora do follow-up.
 *
 * A ordem é a das garantias: tarde demais e janela fechada primeiro (não há o
 * que esperar), depois a pessoa dona da conversa (nunca falar por cima), e só
 * então o "agora não": conversa em andamento ou fora do horário de envio.
 */
export function decidirEnvio(args: {
  agora: Date;
  inicio: Date;
  ultimaDoCliente: Date;
  conversa: {
    status: string | null;
    assigneeId: number | null;
    assigneeTipo: string | null;
    assigneeNome?: string | null;
  };
  mensagens: MensagemChatwoot[];
  config: Pick<FollowupConfig, "horaDeInicio" | "horaDeFim">;
}): DecisaoDoEnvio {
  const { agora, inicio, ultimaDoCliente, conversa, mensagens, config } = args;

  if (agora.getTime() > inicio.getTime() - MINUTOS_MINIMOS_ANTES_DO_INICIO * MINUTO) {
    return {
      acao: "desistir",
      motivo: `a reserva começa em menos de ${MINUTOS_MINIMOS_ANTES_DO_INICIO} min`,
    };
  }
  if (agora.getTime() > ultimaDoCliente.getTime() + JANELA_LIMITE_H * HORA) {
    return {
      acao: "desistir",
      motivo: "a janela de 24 h do WhatsApp está fechando: a mensagem pode não chegar ao cliente",
    };
  }

  // Resolvida, ninguém está falando com o cliente — o dono que sobrou não conta.
  const resolvida = ehResolvida(conversa.status);
  if (!resolvida && conversa.assigneeId != null && humanidadeDoDono(conversa.assigneeTipo) !== false) {
    return { acao: "avisar-quem-atende", quem: conversa.assigneeNome ?? null };
  }

  if (!dentroDoHorarioDeEnvio(agora, config)) {
    return { acao: "aguardar", motivo: "fora do horário de envio" };
  }

  const publicas = mensagens.filter(
    (m) => (m.message_type === 0 || m.message_type === 1) && !m.private,
  );
  const ultima = publicas.reduce<MensagemChatwoot | null>(
    (maior, m) => (!maior || m.id > maior.id ? m : maior),
    null,
  );
  if (ultima && !resolvida) {
    if (ultima.message_type === 0) {
      return { acao: "aguardar", motivo: "o cliente está esperando resposta" };
    }
    const quando = typeof ultima.created_at === "number" ? ultima.created_at * 1000 : 0;
    if (agora.getTime() - quando < MINUTOS_DE_CONVERSA_ATIVA * MINUTO) {
      return { acao: "aguardar", motivo: "a conversa está em andamento" };
    }
  }

  return { acao: "enviar" };
}

const MINUSCULAS = new Set(["de", "da", "do", "das", "dos", "e"]);

function capitalizar(texto: string): string {
  return texto
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p, i) => (i > 0 && MINUSCULAS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

/**
 * O nome da sala como o cliente lê: `[SEAWAY] - SALA DE REUNIÃO 01 - 10 pessoas`
 * vira `Sala de Reunião 01 (Seaway)`. Fora desse formato, o nome como veio.
 */
export function nomeDaSala(bruto: string | null | undefined): string {
  const nome = (bruto ?? "").trim();
  const partes = /^\[([^\]]+)\]\s*-\s*(.+?)(?:\s*-\s*\d+\s*pessoas?)?$/i.exec(nome);
  if (!partes) return nome || "a sala reservada";
  return `${capitalizar(partes[2])} (${capitalizar(partes[1])})`;
}

/** `17h` ou `17h30`, no relógio de São Paulo. */
export function horaCurta(instante: Date): string {
  const [h, m] = agoraEmSaoPaulo(instante).hora.split(":");
  return `${Number(h)}h${m === "00" ? "" : m}`;
}

/** `hoje, 16/11`, `amanhã, 17/11` ou `segunda-feira, 24/11`. */
export function diaDaReserva(inicio: Date, agora: Date): string {
  const r = agoraEmSaoPaulo(inicio);
  const hoje = agoraEmSaoPaulo(agora).iso;
  const curta = r.data.slice(0, 5);
  if (r.iso === hoje) return `hoje, ${curta}`;
  if (r.iso === somarDias(hoje, 1)) return `amanhã, ${curta}`;
  return `${r.diaDaSemana.toLowerCase()}, ${curta}`;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function valorEmReais(valor: number): string {
  // O Intl separa "R$" do número com espaço sem quebra; o WhatsApp mostra igual.
  return BRL.format(valor).replace(/ /g, " ");
}

/** O primeiro nome do contato, ou `null` se o nome é um telefone ou está vazio. */
export function primeiroNome(nome: string | null | undefined): string | null {
  const limpo = (nome ?? "").trim();
  if (!limpo || /\d/.test(limpo)) return null;
  const primeiro = limpo.split(/\s+/)[0];
  return primeiro.length >= 2 ? capitalizar(primeiro) : null;
}

export type DadosDaMensagem = {
  nome: string | null;
  sala: string;
  data: string;
  inicio: string;
  fim: string;
  valor: string;
  link: string;
};

/** O texto da tela com os marcadores trocados. Sem nome, o "Oi, {nome}!" vira "Oi!". */
export function textoDoFollowup(modelo: string, dados: DadosDaMensagem): string {
  let texto = modelo;
  if (!dados.nome) texto = texto.replace(/,\s*\{nome\}/g, "").replace(/\s*\{nome\}/g, "");
  return texto.replace(/\{(nome|sala|data|inicio|fim|valor|link)\}/g, (_, chave: keyof DadosDaMensagem) =>
    String(dados[chave] ?? ""),
  );
}

/** Uma linha que identifica a reserva nas notas e no rastro. */
export function resumoDaReserva(r: { reservaId: number; sala: string; data: string; inicio: string; fim: string }) {
  return `reserva ${r.reservaId} (${r.sala}, ${r.data}, das ${r.inicio} às ${r.fim})`;
}

export function notaDeEnvio(resumo: string, cobrancaId: number): string {
  return [
    `🤖 Follow-up de reserva (automático): a ${resumo} não aparece paga no Conexa.`,
    `Mandei ao cliente a confirmação com o link da cobrança ${cobrancaId}. Se ele responder, o atendimento segue normalmente.`,
  ].join("\n");
}

export function notaParaQuemAtende(resumo: string, cobranca: string): string {
  return [
    `📌 Follow-up de reserva: a ${resumo} ainda não aparece paga no Conexa (${cobranca}).`,
    "Como a conversa está com você, não mandei nada ao cliente — vale confirmar com ele a vinda e o pagamento.",
  ].join("\n");
}

export function notaDeDesistencia(resumo: string, cobranca: string, motivo: string): string {
  return [
    `📌 Follow-up de reserva: a ${resumo} ainda não aparece paga no Conexa (${cobranca}).`,
    `A mensagem automática ao cliente não saiu: ${motivo}. Vale confirmar com ele a vinda e o pagamento.`,
  ].join("\n");
}

/** Recusa do Chatwoot que diz "nada saiu": 4xx, menos prazo e excesso. */
export function ehRecusaClara(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
