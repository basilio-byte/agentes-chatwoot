import { z } from "zod";
import { FUSO_SEAHUB } from "@/lib/tempo";
import { normalizarTelefone } from "@/server/alerta-de-saldo/regras";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";

/**
 * Aviso de cobrança por etiqueta do ClickUp — as regras puras.
 *
 * Pedido do Laercio (22/09/2026, prioridade alta): pôr a etiqueta numa task da
 * Base de clientes manda ao cliente, pelo WhatsApp, a mensagem de cobrança
 * daquela etiqueta, e a etiqueta sai depois do envio. Sem modelo: as mensagens
 * são fixas, e o molde é o do NPS e da janela — função do sistema.
 *
 * A etiqueta É a fila. O que ainda está com ela não foi enviado; o que foi
 * enviado perde a etiqueta e ganha um comentário na task.
 */

/** O `provider` das linhas em `WebhookEvent`: reserva, envio e falha. */
export const PROVIDER_DA_COBRANCA = "COBRANCA";

/**
 * De quanto em quanto tempo a Base de clientes é conferida. 30 minutos por
 * decisão do usuário: menos processamento à toa, e cobrança não é urgente de
 * minuto.
 */
export const CONFERIR_A_CADA_MS = 30 * 60_000;

/**
 * Depois de um envio, a mesma etiqueta na mesma task não manda de novo por este
 * tempo. É a trava para o caso de a etiqueta não ter saído (falha ao removê-la):
 * sem ela, a rodada seguinte mandaria a mesma cobrança outra vez.
 */
export const HORAS_SEM_REENVIO = 72;

export const ETIQUETAS = ["cobranca-1", "cobranca-2"] as const;
export type Etiqueta = (typeof ETIQUETAS)[number];

/** Os textos do Laercio, letra por letra. A tela edita. */
export const MENSAGENS_PADRAO: Record<Etiqueta, string> = {
  "cobranca-1":
    "Olá! Tudo bem? Identificamos faturas em aberto em seu cadastro e gostaríamos de ajudar na regularização. Pagando via Pix, conseguimos oferecer 10% de desconto, ou podemos negociar uma condição que fique melhor para você. Nos responda por aqui para verificarmos as opções. 🙂",
  "cobranca-2":
    "Olá! Estamos retomando nosso contato sobre as faturas em aberto. Pedimos que regularize a pendência antes de completar 30 dias de vencimento, evitando a possibilidade de futura negativação. Se precisar negociar, fale conosco por aqui para encontrarmos uma solução. ⚠️",
};

const texto = (padrao: string) => z.string().trim().min(10).max(1000).default(padrao);

export const cobrancaConfigSchema = z.object({
  /**
   * A caixa por onde a mensagem sai. A 31 (WAHA) por decisão do usuário: sem a
   * janela de 24 h do WhatsApp oficial, e é por onde a equipe já inicia
   * conversa todo dia. Pela 29 exigiria template aprovado pela Meta.
   */
  caixaId: z.number().int().positive().default(31),
  /** "Base de clientes", no space SEAHUB. */
  listaId: z.string().regex(/^\d+$/).default("900701122530"),
  /** O campo CELULAR (tipo phone) da Base de clientes. */
  campoTelefone: z.string().min(8).default("3399c6f6-c890-40a6-865e-5a4e810fe8c6"),
  /** Quem recebe a conversa, para a resposta do cliente chegar direto nele. */
  atribuirA: z.string().trim().max(80).default("Laercio"),
  mensagens: z
    .object({
      "cobranca-1": texto(MENSAGENS_PADRAO["cobranca-1"]),
      "cobranca-2": texto(MENSAGENS_PADRAO["cobranca-2"]),
    })
    .default({ ...MENSAGENS_PADRAO }),
  /**
   * Espera entre um envio e o próximo. A caixa 31 é conexão NÃO oficial do
   * WhatsApp, e um lote disparado de uma vez é o jeito mais rápido de o número
   * ser bloqueado.
   */
  intervaloSegundos: z.number().int().min(10).max(600).default(30),
  tetoPorHora: z.number().int().min(1).max(200).default(60),
});

export type CobrancaConfig = z.infer<typeof cobrancaConfigSchema>;

/**
 * A config gravada, com os padrões no que faltar. Só o formulário grava, e ele
 * valida antes: config inválida aqui é linha mexida à mão, e cai nos padrões.
 */
export function lerConfigCobranca(bruto: unknown): CobrancaConfig {
  const lido = cobrancaConfigSchema.safeParse(bruto ?? {});
  return lido.success ? lido.data : cobrancaConfigSchema.parse({});
}

/**
 * Horário comercial em São Paulo: segunda a sexta, das 8h às 18h. Cobrança às
 * 23h não é cobrança, é incômodo — a etiqueta posta à noite espera a manhã.
 * O container roda em UTC, por isso o fuso é explícito.
 */
export function dentroDoHorario(agora: Date): boolean {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO_SEAHUB,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(agora);
  const dia = partes.find((p) => p.type === "weekday")?.value ?? "";
  const hora = Number(partes.find((p) => p.type === "hour")?.value ?? "-1") % 24;
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(dia) && hora >= 8 && hora < 18;
}

/** As etiquetas de cobrança que a task tem, na ordem de `ETIQUETAS`. */
export function etiquetasDaTarefa(tarefa: Pick<ClickUpTarefa, "tags">): Etiqueta[] {
  const tem = new Set((tarefa.tags ?? []).map((t) => t.name.trim().toLowerCase()));
  return ETIQUETAS.filter((e) => tem.has(e));
}

/**
 * O telefone do cliente, do campo CELULAR, em E.164. `null` sem campo, sem
 * valor ou com número que não dá para usar — e aí nada é enviado: mandar para
 * um número adivinhado é cobrar outra pessoa.
 */
export function telefoneDaTarefa(
  tarefa: Pick<ClickUpTarefa, "custom_fields">,
  campoId: string,
): string | null {
  const valor = tarefa.custom_fields?.find((c) => c.id === campoId)?.value;
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  return normalizarTelefone(String(valor));
}

/** "1º aviso" / "2º aviso". */
export function rotuloDoAviso(etiqueta: Etiqueta): string {
  return etiqueta === "cobranca-1" ? "1º aviso de cobrança" : "2º aviso de cobrança";
}

/** Primeiro as tasks que estão esperando há mais tempo. */
export function naOrdemDeChegada<T extends Pick<ClickUpTarefa, "date_updated">>(tarefas: T[]): T[] {
  const quando = (t: T) => Number(t.date_updated ?? 0) || 0;
  return [...tarefas].sort((a, b) => quando(a) - quando(b));
}

/** O comentário na task depois do envio. Sem telefone: a task já o tem. */
export function comentarioDeEnvio(args: {
  etiqueta: Etiqueta;
  quando: string;
  linkDaConversa: string | null;
  atribuidoA: string | null;
  problemas: string[];
}): string {
  return [
    `✅ ${rotuloDoAviso(args.etiqueta)} enviado pelo WhatsApp em ${args.quando}.`,
    args.linkDaConversa ? `Conversa no Chatwoot: ${args.linkDaConversa}` : null,
    args.atribuidoA ? `Conversa atribuída a ${args.atribuidoA}.` : null,
    ...args.problemas.map((p) => `⚠ ${p}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** O comentário na task quando não dá para enviar — sai uma vez por motivo. */
export function comentarioDeFalha(etiqueta: Etiqueta, motivo: string): string {
  return `⚠ ${rotuloDoAviso(etiqueta)} NÃO enviado: ${motivo} A etiqueta "${etiqueta}" continua na task; corrija e ela é conferida de novo em até 30 minutos, em horário comercial.`;
}

/** A nota interna na conversa: quem abrir sabe de onde veio a mensagem. */
export function notaDaConversa(etiqueta: Etiqueta, urlDaTarefa: string | null): string {
  return [
    `💰 ${rotuloDoAviso(etiqueta)} enviado automaticamente pela etiqueta "${etiqueta}" no ClickUp.`,
    urlDaTarefa ? `Task: ${urlDaTarefa}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const ROTULOS: Record<string, string> = {
  caixaId: "Caixa",
  atribuirA: "Atribuir a",
  mensagens: "Mensagens (de 10 a 1000 caracteres)",
};

/**
 * O formulário vira config, ou a primeira recusa em texto para quem preencheu.
 * O que a tela não mostra (lista, campo, ritmo) fica como estava.
 */
export function configDoFormulario(
  ler: (campo: string) => string | null,
  atual: CobrancaConfig,
): { config: CobrancaConfig } | { erro: string } {
  const valor = (campo: string) => (ler(campo) ?? "").replace(/\r\n/g, "\n").trim();
  const caixa = valor("caixaId");
  const lido = cobrancaConfigSchema.safeParse({
    ...atual,
    caixaId: caixa === "" ? Number.NaN : Number(caixa),
    atribuirA: valor("atribuirA"),
    mensagens: {
      "cobranca-1": valor("mensagem1"),
      "cobranca-2": valor("mensagem2"),
    },
  });
  if (!lido.success) {
    const chave = String(lido.error.issues[0]?.path?.[0] ?? "");
    return { erro: `${ROTULOS[chave] ?? chave}: valor inválido ou em branco.` };
  }
  return { config: lido.data };
}
