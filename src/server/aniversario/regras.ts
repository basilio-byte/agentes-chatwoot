import { z } from "zod";
import { destinatariosSalvos, type Destinatario } from "@/server/alerta-de-saldo/regras";

/**
 * Presente de aniversário — as regras puras.
 *
 * Pedido do Diego (22/09/2026): a Seahub manda um e-mail no aniversário do
 * cliente oferecendo 2 h de sala de reunião ou de atendimento, e o cliente que
 * responde no WhatsApp caía na automação, que passava a conversa para ele. A API
 * do Conexa não vende pacote de horas (o pacote "2h - Sala de reunião
 * (Aniversário)" se escolhe na TELA), então o desenho é o que ele propôs: o
 * agente registra o pedido e avisa, ELE lança e fatura o pacote, e o sistema
 * fica conferindo até a venda aparecer paga para então reservar.
 *
 * Decisões dele, no mesmo dia:
 * - **A janela é de 7 dias DEPOIS do aniversário.** *"Semana de aniversário
 *   pode ser considerado 7 dias antes (o cliente só pede após a data)"*: o
 *   e-mail sai no dia, então o pedido vem depois, e vale se o aniversário foi
 *   até `diasDepois` dias antes do pedido.
 * - ⚠ **O agente NUNCA oferece o presente.** *"é só para quem receber o
 *   e-mail"*. A descrição da ferramenta diz isso, e o prompt também.
 * - **Ele lança e fatura; o aviso é por WhatsApp.** Pela caixa 31, o mesmo
 *   caminho provado do alerta de saldo.
 */

/**
 * De quanto em quanto tempo o Conexa é consultado, e só enquanto houver pedido
 * esperando: sem pedido, a rodada é uma consulta ao nosso banco e mais nada.
 */
export const CONFERIR_A_CADA_MS = 5 * 60_000;

/**
 * Antecedência mínima entre o pedido e o começo da reserva. Abaixo disso não
 * dá tempo de a equipe lançar o pacote, e a conversa iria para uma pessoa com
 * o cliente já na porta da sala.
 */
export const ANTECEDENCIA_MINIMA_MS = 60 * 60_000;

/**
 * O prazo nunca passa deste tanto antes do começo da reserva: se o pacote não
 * saiu até ali, a conversa vai para uma pessoa enquanto ainda dá para resolver.
 */
export const FOLGA_ANTES_DA_RESERVA_MS = 30 * 60_000;

/**
 * Um presente por cliente a cada tanto, pelos NOSSOS registros. É um freio de
 * conveniência: quem lança o pacote é uma pessoa, e é ela quem decide de fato.
 */
export const DIAS_ENTRE_PRESENTES = 300;

/**
 * A venda do pacote conta a partir de um pouco antes do pedido: a equipe às
 * vezes lança enquanto o agente ainda está conversando.
 */
export const TOLERANCIA_DA_VENDA_MS = 30 * 60_000;

/** Pedido em PROCESSANDO há mais que isto é de uma rodada que caiu no meio. */
export const PROCESSANDO_ABANDONADO_MS = 15 * 60_000;

export const TEXTO_CONFIRMACAO_PADRAO =
  "🎉 Seu presente de aniversário está liberado! A reserva está confirmada: {sala}, no dia {data}, das {inicio} às {fim}. As horas saem do pacote de presente, sem custo para você. Até lá! 🎂";

export const TEXTO_ENTREGA_PADRAO =
  "Vou pedir para a nossa equipe finalizar a liberação do seu presente de aniversário, tudo bem? Já te respondem por aqui. 😊";

const texto = (padrao: string) => z.string().trim().min(10).max(1000).default(padrao);

export const configAniversarioSchema = z.object({
  /** Quem recebe o aviso por WhatsApp. Telefone só aparece para Administrador. */
  avisar: z
    .unknown()
    .optional()
    .transform((bruto): Destinatario[] => destinatariosSalvos(bruto)),
  /** A caixa por onde o aviso à equipe sai: a 31, sem janela de 24 h. */
  caixaDoAviso: z.number().int().positive().default(31),
  /** Quem recebe a conversa quando o prazo vence ou a reserva não dá certo. */
  atendente: z.string().trim().max(80).default("Diego"),
  /** Até quantos dias depois do aniversário o pedido vale. */
  diasDepois: z.number().int().min(0).max(30).default(7),
  /** Quantas horas esperar o pacote pago antes de passar a conversa. */
  prazoHoras: z.number().int().min(1).max(72).default(4),
  /** Duração máxima da reserva: o pacote do presente é de 2 h. */
  horas: z.number().int().min(1).max(8).default(2),
  /**
   * O produto da venda que a equipe lança: "Pré-Venda Pacote de Horas", id 1 na
   * SEAHUB COWORKING e 3014 na SEATECH (conferido na venda da conversa 14149).
   */
  produtos: z.array(z.number().int().positive()).min(1).default([1, 3014]),
  confirmacao: texto(TEXTO_CONFIRMACAO_PADRAO),
  entrega: texto(TEXTO_ENTREGA_PADRAO),
});

export type ConfigAniversario = z.infer<typeof configAniversarioSchema>;

/** A config gravada, com os padrões no que faltar ou estiver quebrado. */
export function lerConfigAniversario(bruto: unknown): ConfigAniversario {
  const lido = configAniversarioSchema.safeParse(bruto ?? {});
  return lido.success ? lido.data : configAniversarioSchema.parse({});
}

/** `1994-05-01` (ou com hora depois) → `[1994, 5, 1]`; `null` se não é data. */
function partesDaData(bruto: unknown): [number, number, number] | null {
  if (typeof bruto !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(bruto.trim());
  if (!m) return null;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return [ano, mes, dia];
}

function bissexto(ano: number) {
  return (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
}

/**
 * Há quantos dias foi o último aniversário, contando de `hoje` (AAAA-MM-DD, o
 * dia de São Paulo). 0 é hoje. Quem nasceu em 29/02 faz aniversário em 28/02
 * nos anos que não são bissextos.
 */
export function diasDesdeOAniversario(nascimento: unknown, hoje: string): number | null {
  const n = partesDaData(nascimento);
  const h = partesDaData(hoje);
  if (!n || !h) return null;
  const [, mes, dia] = n;

  const noAno = (ano: number) => {
    const d = mes === 2 && dia === 29 && !bissexto(ano) ? 28 : dia;
    return Date.UTC(ano, mes - 1, d);
  };
  const diaDeHoje = Date.UTC(h[0], h[1] - 1, h[2]);
  let aniversario = noAno(h[0]);
  if (aniversario > diaDeHoje) aniversario = noAno(h[0] - 1);
  return Math.round((diaDeHoje - aniversario) / 86_400_000);
}

export type Janela =
  /** Ninguém do cadastro tem data de nascimento. */
  | { tipo: "semData" }
  /** Tem data, mas nenhum aniversário caiu na janela. */
  | { tipo: "fora" }
  | { tipo: "dentro"; diasDepois: number; aniversario: string };

/**
 * Alguma das datas de nascimento abre a janela do presente hoje?
 *
 * As datas são as do cadastro que pediu: a do cliente pessoa física e as das
 * pessoas vinculadas que contam (`aniversario/pedir.ts` decide quais).
 */
export function aniversarioNaJanela(
  nascimentos: unknown[],
  hoje: string,
  diasDepois: number,
): Janela {
  let algumaData = false;
  let melhor: { dias: number; aniversario: string } | null = null;

  for (const bruto of nascimentos) {
    const partes = partesDaData(bruto);
    const dias = diasDesdeOAniversario(bruto, hoje);
    if (!partes || dias === null) continue;
    algumaData = true;
    if (dias <= diasDepois && (!melhor || dias < melhor.dias)) {
      melhor = {
        dias,
        aniversario: `${String(partes[2]).padStart(2, "0")}/${String(partes[1]).padStart(2, "0")}`,
      };
    }
  }

  if (melhor) return { tipo: "dentro", diasDepois: melhor.dias, aniversario: melhor.aniversario };
  return algumaData ? { tipo: "fora" } : { tipo: "semData" };
}

/**
 * Até quando esperar o pacote: o prazo configurado, mas nunca depois de
 * `FOLGA_ANTES_DA_RESERVA_MS` antes de a reserva começar.
 */
export function vencimentoDoPedido(args: {
  agoraMs: number;
  prazoHoras: number;
  inicioDaReservaMs: number;
}): Date {
  return new Date(
    Math.min(
      args.agoraMs + args.prazoHoras * 3_600_000,
      args.inicioDaReservaMs - FOLGA_ANTES_DA_RESERVA_MS,
    ),
  );
}

export type VendaDoPresente =
  | { tipo: "nenhuma" }
  /** Lançada, mas ainda não paga (a cobrança de R$ 0 não foi quitada). */
  | { tipo: "esperando"; vendaId: number; status: string }
  | { tipo: "paga"; vendaId: number; pessoaId?: number };

/** Status em que a venda deixou de valer. */
const VENDA_QUE_NAO_VALE = new Set(["cancelled", "billedcancelled"]);

/**
 * Entre as vendas do cliente, a do pacote do presente — lançada depois do
 * pedido (com tolerância), de um dos produtos configurados e de R$ 0.
 *
 * ⚠ **Só `paid` libera a reserva.** Lançar e faturar é o que o Diego faz; a
 * venda `billed` ainda tem a cobrança de R$ 0 em aberto, e é o pagamento que
 * põe as horas na cota do cliente. Na conversa 14149 o caminho foi exatamente
 * esse: venda paga, e a reserva saiu descontada do pacote.
 */
export function vendaDoPresente(
  vendas: Array<Record<string, unknown>>,
  filtro: { produtos: number[]; desdeMs: number },
): VendaDoPresente {
  let esperando: { vendaId: number; status: string } | null = null;

  for (const venda of vendas) {
    const produto = (venda.product ?? {}) as Record<string, unknown>;
    const produtoId = Number(produto.id ?? venda.productId);
    if (!filtro.produtos.includes(produtoId)) continue;

    // A consulta já vem filtrada por `createdAtFrom`; a data só é conferida de
    // novo quando vem na resposta (a documentação diz que pode vir nula).
    const criadaEm = Date.parse(String(venda.createdAt ?? ""));
    if (Number.isFinite(criadaEm) && criadaEm < filtro.desdeMs) continue;

    // ⚠ O mesmo produto vende pacote de horas PAGO. O do presente é de R$ 0 —
    // sem isto, o cliente que comprasse um pacote no mesmo dia teria as horas
    // dele usadas como presente.
    const valor = Number(venda.amount);
    if (!Number.isFinite(valor) || valor !== 0) continue;

    const status = String(venda.status ?? "").trim().toLowerCase();
    if (VENDA_QUE_NAO_VALE.has(status)) continue;

    const vendaId = Number(venda.saleId ?? venda.id);
    if (!Number.isInteger(vendaId) || vendaId <= 0) continue;

    if (status === "paid") {
      const pessoa = Number(venda.requesterId);
      return {
        tipo: "paga",
        vendaId,
        ...(Number.isInteger(pessoa) && pessoa > 0 ? { pessoaId: pessoa } : {}),
      };
    }
    esperando ??= { vendaId, status: status || "sem status" };
  }

  return esperando ? { tipo: "esperando", ...esperando } : { tipo: "nenhuma" };
}

/** `2026-09-25` → `25/09`. */
export function diaCurto(dia: string): string {
  const p = partesDaData(dia);
  return p ? `${String(p[2]).padStart(2, "0")}/${String(p[1]).padStart(2, "0")}` : dia;
}

export type ResumoDoPedido = {
  salaNome: string | null;
  salaId: number;
  data: string;
  inicio: string;
  fim: string;
};

function sala(p: ResumoDoPedido) {
  return p.salaNome?.trim() || `sala ${p.salaId}`;
}

/** `Sala 03, 25/09, das 14:00 às 16:00`. */
export function horarioDoPedido(p: ResumoDoPedido) {
  return `${sala(p)}, ${diaCurto(p.data)}, das ${p.inicio} às ${p.fim}`;
}

/** A confirmação ao cliente, com a sala que o Conexa gravou. */
export function textoDeConfirmacao(modelo: string, p: ResumoDoPedido): string {
  return modelo
    .replaceAll("{sala}", sala(p))
    .replaceAll("{data}", diaCurto(p.data))
    .replaceAll("{inicio}", p.inicio)
    .replaceAll("{fim}", p.fim);
}

/** O WhatsApp para a equipe quando o pedido chega. */
export function avisoDePedido(args: {
  pedido: ResumoDoPedido;
  clienteId: number;
  clienteNome: string | null;
  aniversario: string;
  venceEm: string;
  linkDaConversa: string | null;
}): string {
  return [
    "🎂 Pedido de presente de aniversário",
    `Cliente: ${args.clienteNome?.trim() || "sem nome"} (Conexa ${args.clienteId}) — aniversário em ${args.aniversario}`,
    `Reserva pedida: ${horarioDoPedido(args.pedido)}`,
    args.linkDaConversa ? `Conversa: ${args.linkDaConversa}` : null,
    "",
    "Lance o pacote de 2 h (Pré-Venda Pacote de Horas) e fature a cobrança de R$ 0. Assim que a venda estiver paga, o sistema faz a reserva e confirma ao cliente — não precisa reservar.",
    `Se não estiver pago até ${args.venceEm}, a conversa passa para você.`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** A nota interna na conversa quando o pedido é registrado. */
export function notaDePedido(args: {
  pedido: ResumoDoPedido;
  aniversario: string;
  avisados: string[];
  venceEm: string;
}): string {
  return [
    `🎂 Presente de aniversário pedido: ${horarioDoPedido(args.pedido)} (aniversário em ${args.aniversario}).`,
    args.avisados.length
      ? `Avisado(s) por WhatsApp: ${args.avisados.join(", ")}.`
      : "⚠️ Ninguém foi avisado por WhatsApp.",
    "Falta lançar e faturar o pacote de 2 h no Conexa. Quando a venda aparecer paga, o sistema reserva e confirma ao cliente.",
    `Prazo: ${args.venceEm}. Sem o pacote pago até lá, a conversa vai para uma pessoa.`,
  ].join("\n");
}

/** A nota interna depois de reservar. */
export function notaDeReserva(args: {
  pedido: ResumoDoPedido;
  reservaId: number | null;
  vendaId: number;
  clienteAvisado: boolean;
}): string {
  return [
    `✅ Presente de aniversário reservado: ${horarioDoPedido(args.pedido)}${args.reservaId ? ` (reserva ${args.reservaId} no Conexa)` : ""}, descontado do pacote da venda ${args.vendaId}.`,
    args.clienteAvisado
      ? "O cliente recebeu a confirmação."
      : "⚠️ O cliente NÃO recebeu a confirmação: a conversa não estava com o robô. Avise-o por aqui.",
  ].join("\n");
}

/** A nota interna quando o pedido vai para uma pessoa. */
export function notaDeEntrega(args: {
  pedido: ResumoDoPedido;
  motivo: string;
  atribuidoA: string | null;
}): string {
  return [
    `⏱️ Presente de aniversário (${horarioDoPedido(args.pedido)}): ${args.motivo}`,
    args.atribuidoA
      ? `A conversa foi atribuída a ${args.atribuidoA}.`
      : "A conversa NÃO foi atribuída a ninguém — alguém precisa assumir.",
    "O sistema parou de acompanhar este pedido: daqui é com a equipe.",
  ].join("\n");
}
