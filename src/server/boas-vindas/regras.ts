import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { humanidadeDoDono } from "@/server/integrations/chatwoot/regras";
import { telefoneCanonico } from "@/server/integrations/clickup/telefone";

/**
 * Template de boas-vindas pelo WhatsApp OFICIAL: regras puras e testadas.
 *
 * Substitui o fluxo "Template Boas Vindas" do n8n. A macro 97 do Chatwoot
 * ("Disparar Template Boas Vindas") atribui a conversa a quem clicou, chama o
 * endereço daqui e põe a etiqueta `template_meta_enviado`. O que mudou do fluxo
 * antigo, e por quê, está em `processar.ts`.
 */

/** `WebhookEvent.provider` das entregas desta função. */
export const PROVIDER_DO_BOAS_VINDAS = "BOAS_VINDAS";

/** O nome da macro no Chatwoot (Configurações → Macros), para a tela dizer qual é. */
export const NOME_DA_MACRO = "Disparar Template Boas Vindas";

/** O que abre toda nota que o sistema deixa por aqui — é por ela que se acha no Chatwoot. */
const MARCA = "📨 Template de boas-vindas:";

export const boasVindasConfigSchema = z.object({
  /**
   * O canal da NotificaMe de onde o template sai (o `from` do envio). Não é
   * segredo, mas também não vai para o código: fica na config, em branco até a
   * tela (ou quem instala) preencher. Em branco, nada é enviado.
   */
  canalId: z.string().trim().max(80).default(""),
  /** Nome do template na NotificaMe. É um por vez: trocar de template é trocar este campo. */
  template: z.string().trim().min(1).max(100).default("template_diego2"),
  /** Nome do parâmetro do corpo (`{{texto}}`), que recebe o nome do contato. */
  parametro: z.string().trim().min(1).max(60).default("texto"),
  idioma: z.string().trim().min(2).max(10).default("pt_BR"),
  /**
   * A caixa em que o cliente responde ao template (a do WhatsApp oficial). É nela
   * que a nota é deixada e que a conversa é reaberta e atribuída.
   */
  caixaDoCliente: z.number().int().positive().default(29),
  /**
   * Quanto tempo o mesmo número fica sem receber o template de novo. Pegaria o
   * clique duplo e a macro rodada duas vezes por engano; 10 minutos não atrapalha
   * quem de fato precisa mandar de novo (a falha de envio não conta).
   */
  minutosSemReenvio: z.number().int().min(1).max(240).default(10),
  /** Freio contra laço: mais que isso por hora e o sistema para de enviar. */
  tetoPorHora: z.number().int().min(1).max(500).default(60),
  /** Só o hash do token do endereço; o formulário NUNCA toca neste campo. */
  tokenHash: z.string().nullable().default(null),
  tokenGeradoEm: z.string().nullable().default(null),
});

export type BoasVindasConfig = z.infer<typeof boasVindasConfigSchema>;

/**
 * A config gravada, com os padrões no que faltar. Só o formulário grava, e ele
 * valida antes: config inválida aqui é linha mexida à mão, e cai nos padrões —
 * menos o token do endereço, que é o que deixaria a macro sem destino.
 */
export function lerConfigBoasVindas(bruto: unknown): BoasVindasConfig {
  const lido = boasVindasConfigSchema.safeParse(bruto ?? {});
  if (lido.success) return lido.data;

  const b = (bruto && typeof bruto === "object" ? bruto : {}) as Record<string, unknown>;
  return boasVindasConfigSchema.parse({
    tokenHash: typeof b.tokenHash === "string" ? b.tokenHash : null,
    tokenGeradoEm: typeof b.tokenGeradoEm === "string" ? b.tokenGeradoEm : null,
  });
}

const ROTULOS: Record<string, string> = {
  canalId: "Canal da NotificaMe",
  template: "Template",
  parametro: "Parâmetro do nome",
  idioma: "Idioma",
  caixaDoCliente: "Caixa do cliente (número)",
  minutosSemReenvio: "Minutos sem reenvio (inteiro, de 1 a 240)",
  tetoPorHora: "Teto por hora (inteiro, de 1 a 500)",
};

/**
 * O formulário vira config, ou a primeira recusa em texto para quem preencheu.
 * Número em branco é recusa, não zero: `Number("")` é 0. O token do endereço
 * vem da config que já estava gravada — o formulário não escreve segredo.
 */
export function configDoFormulario(
  ler: (campo: string) => string | null,
  atual: BoasVindasConfig,
): { config: BoasVindasConfig } | { erro: string } {
  const valor = (campo: string) => (ler(campo) ?? "").replace(/\r\n/g, "\n").trim();
  const numero = (campo: string) => (valor(campo) === "" ? Number.NaN : Number(valor(campo)));

  const lido = boasVindasConfigSchema.safeParse({
    canalId: valor("canalId"),
    template: valor("template"),
    parametro: valor("parametro"),
    idioma: valor("idioma"),
    caixaDoCliente: numero("caixaDoCliente"),
    minutosSemReenvio: numero("minutosSemReenvio"),
    tetoPorHora: numero("tetoPorHora"),
    tokenHash: atual.tokenHash,
    tokenGeradoEm: atual.tokenGeradoEm,
  });
  if (!lido.success) {
    const chave = String(lido.error.issues[0]?.path?.[0] ?? "");
    return { erro: `${ROTULOS[chave] ?? chave}: valor inválido ou em branco.` };
  }
  return { config: lido.data };
}

// ---------------------------------------------------------------------------
// O endereço que a macro chama
// ---------------------------------------------------------------------------

/** O token vai no endereço; guardamos só o hash, como o do MCP e o do aviso do Conexa. */
export function hashDoToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Compara em tempo constante. Sem hash guardado, nada confere. */
export function tokenDoEnderecoConfere(
  apresentado: string,
  hashGuardado: string | null | undefined,
): boolean {
  if (!hashGuardado || !apresentado) return false;
  const a = Buffer.from(hashDoToken(apresentado), "hex");
  const b = Buffer.from(hashGuardado, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// O que a macro manda
// ---------------------------------------------------------------------------

export type MacroLida = {
  /** A conversa em que a pessoa clicou (número que aparece na tela do Chatwoot). */
  conversaId: number;
  caixaId: number | null;
  contatoId: number | null;
  /** Como o Chatwoot chama o contato. Pode vir vazio. */
  nome: string;
  /** Só dígitos, com o código do país; `null` se o contato não tem telefone utilizável. */
  telefone: string | null;
  /** Quem clicou: a macro atribui a conversa a quem a executa. */
  clique: { id: number; nome: string | null } | null;
};

function objeto(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function inteiro(x: unknown): number | null {
  return typeof x === "number" && Number.isSafeInteger(x) && x > 0 ? x : null;
}

function texto(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

/**
 * O telefone do contato, só dígitos. O Chatwoot guarda `+558499999999`; o
 * identificador que a WAHA grava (`5584…@s.whatsapp.net`) serve de segunda
 * chance. `@lid` e `@g.us` NÃO são telefone: casar os dígitos deles com um
 * número seria coincidência.
 */
export function telefoneDoContato(sender: Record<string, unknown>): string | null {
  const direto = String(sender.phone_number ?? "").replace(/\D/g, "");
  if (direto.length >= 10 && direto.length <= 15) return direto;

  const m = /^(\d{10,15})@(s\.whatsapp\.net|c\.us)$/.exec(String(sender.identifier ?? "").trim());
  return m ? m[1] : null;
}

/**
 * O corpo que o Chatwoot manda quando a macro roda. ⚠ É um corpo SEM assinatura:
 * quem descobrir o endereço pode mandar qualquer coisa — por isso só valem os
 * campos que o formato da macro garante, e o evento precisa ser o da macro.
 */
export function lerMacro(corpo: unknown): { ok: true; macro: MacroLida } | { ok: false; motivo: string } {
  const c = objeto(corpo);
  if (c.event !== "macro.executed") {
    return { ok: false, motivo: `o evento não é de macro (${texto(c.event) ?? "sem evento"})` };
  }

  const conversaId = inteiro(c.id);
  if (conversaId === null) return { ok: false, motivo: "o corpo veio sem o número da conversa" };

  const meta = objeto(c.meta);
  const sender = objeto(meta.sender);
  const quem = objeto(meta.assignee);
  const cliqueId = inteiro(quem.id);

  return {
    ok: true,
    macro: {
      conversaId,
      caixaId: inteiro(c.inbox_id),
      contatoId: inteiro(sender.id),
      nome: texto(sender.name) ?? "",
      telefone: telefoneDoContato(sender),
      clique: cliqueId === null ? null : { id: cliqueId, nome: texto(quem.name) },
    },
  };
}

// ---------------------------------------------------------------------------
// O template
// ---------------------------------------------------------------------------

/**
 * O que vai no parâmetro do template. O WhatsApp recusa quebra de linha, tabulação
 * e mais de quatro espaços seguidos num parâmetro, e um parâmetro vazio é recusa
 * também — daí o "cliente" quando o contato não tem nome.
 */
export function nomeParaOTemplate(nome: string | null | undefined): string {
  const limpo = (nome ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 100);
  return limpo || "cliente";
}

/** O corpo do template com os `{{parametros}}` trocados. O que não tem valor fica como está. */
export function textoDoTemplate(corpo: string, parametros: Record<string, string>): string {
  return corpo.replace(/\{\{\s*([\w]+)\s*\}\}/g, (todo, nome: string) => parametros[nome] ?? todo);
}

// ---------------------------------------------------------------------------
// Uma vez por clique
// ---------------------------------------------------------------------------

/**
 * Identifica o número sem guardá-lo: a entrega é lida pela equipe toda, e telefone
 * de cliente não entra nela. A forma canônica faz o número com e sem o nono dígito
 * ser o mesmo.
 */
export function hashDoTelefone(telefone: string): string {
  const canonico = telefoneCanonico(telefone) ?? telefone.replace(/\D/g, "");
  return createHash("sha256").update(canonico).digest("hex").slice(0, 16);
}

/** Todo envio deste número começa assim; é o que a conferência de "já mandei há pouco" procura. */
export function prefixoDoEnvio(telefone: string): string {
  return `envio:${hashDoTelefone(telefone)}:`;
}

/**
 * A chave ÚNICA do envio: o mesmo número, no mesmo intervalo, só entra uma vez —
 * a trava do banco é a garantia contra duas entregas simultâneas, que a conferência
 * de "mandei há pouco" sozinha deixaria passar.
 */
export function chaveDoEnvio(telefone: string, agora: Date, minutosSemReenvio: number): string {
  const intervalo = Math.floor(agora.getTime() / (minutosSemReenvio * 60_000));
  return `${prefixoDoEnvio(telefone)}${intervalo}`;
}

// ---------------------------------------------------------------------------
// Depois do envio
// ---------------------------------------------------------------------------

/**
 * A conversa do cliente na caixa do WhatsApp oficial: a mais recente. É ali que
 * ele vai responder ao template, e é nela que a nota e a atribuição valem.
 */
export function conversaDoCliente(
  conversas: Array<{ id: number; caixaId: number | null }>,
  caixaDoCliente: number,
): number | null {
  const daCaixa = conversas.filter((c) => c.caixaId === caixaDoCliente).sort((a, b) => b.id - a.id);
  return daCaixa[0]?.id ?? null;
}

export type EstadoAoVivo = {
  status: string | null;
  assigneeId: number | null;
  assigneeTipo: string | null;
  assigneeNome: string | null;
};

export type Providencia =
  | { acao: "manter"; com: string }
  | { acao: "assumir"; reabrir: boolean; atribuir: boolean };

/**
 * ⚠ **Nunca tira a conversa de quem está com ela.** Dono que é pessoa (ou de tipo
 * que não se reconhece) fica com a conversa. Conversa sem dono — ou com o nosso
 * próprio robô, que não é dono de ninguém — vai para quem clicou, reaberta se
 * estiver resolvida ou pendente: o cliente vai responder ali, e sem dono humano
 * quem responde é o agente de entrada.
 */
export function providenciaDoDono(estado: EstadoAoVivo, cliqueId: number | null): Providencia {
  const temDono = estado.assigneeId != null;
  if (temDono && humanidadeDoDono(estado.assigneeTipo) !== false) {
    return { acao: "manter", com: estado.assigneeNome ?? "outra pessoa" };
  }
  return {
    acao: "assumir",
    reabrir: estado.status != null && estado.status !== "open",
    atribuir: cliqueId != null,
  };
}

// ---------------------------------------------------------------------------
// As notas internas
// ---------------------------------------------------------------------------

/**
 * A nota de quem recebeu o template. Começa EXATAMENTE como a do fluxo do n8n
 * (`Template enviado: "…"` e a mensagem), porque a equipe já procura por ela; o
 * que vem depois diz o que o sistema fez com a conversa.
 */
export function notaDeEnvio(args: {
  template: string;
  /** O texto que o cliente recebeu, ou `null` se não deu para ler o template. */
  texto: string | null;
  quem: string | null;
  /** O que aconteceu com a conversa (atribuída, já estava com alguém…). */
  destino: string | null;
  problemas: string[];
}): string {
  const linhas = [
    `Template enviado: "${args.template}"`,
    "",
    "Mensagem:",
    "",
    args.texto ?? "(não consegui ler o texto do template na NotificaMe)",
    "",
    `Disparado${args.quem ? ` por ${args.quem}` : ""} pela macro "${NOME_DA_MACRO}".`,
  ];
  if (args.destino) linhas.push(args.destino);
  for (const p of args.problemas) linhas.push(`⚠ ${p}`);
  return linhas.join("\n");
}

export type MotivoDeFalha =
  | { tipo: "desligado" }
  | { tipo: "sem-credencial" }
  | { tipo: "sem-telefone" }
  | { tipo: "repetido"; minutosAtras: number; espera: number }
  | { tipo: "teto"; teto: number }
  | { tipo: "recusado"; detalhe: string }
  | { tipo: "incerto"; detalhe: string };

/**
 * O que a pessoa que clicou lê quando o template NÃO saiu. Sem isto o clique
 * parecia ter funcionado — a macro atribui e etiqueta de qualquer jeito.
 */
export function notaDeFalha(motivo: MotivoDeFalha): string {
  switch (motivo.tipo) {
    case "desligado":
      return `${MARCA} NÃO enviado. O envio está desligado em Integrações → Boas-vindas. Nada saiu para o cliente.`;
    case "sem-credencial":
      return `${MARCA} NÃO enviado. Falta o token ou o canal da NotificaMe em Integrações → Boas-vindas. Nada saiu para o cliente.`;
    case "sem-telefone":
      return `${MARCA} NÃO enviado. O contato não tem um telefone válido. Nada saiu para o cliente.`;
    case "repetido":
      return `${MARCA} NÃO reenviado. Este número recebeu o template há ${motivo.minutosAtras} min, e o sistema espera ${motivo.espera} min entre dois envios para o mesmo número.`;
    case "teto":
      return `${MARCA} NÃO enviado. O teto de ${motivo.teto} envios por hora foi atingido. Nada saiu para o cliente.`;
    case "recusado":
      return `${MARCA} NÃO enviado. A NotificaMe recusou o pedido (${motivo.detalhe}). Nada saiu para o cliente.`;
    case "incerto":
      return `${MARCA} ⚠ a NotificaMe não respondeu direito (${motivo.detalhe}) e a mensagem PODE ter saído. Confira com o cliente antes de disparar de novo.`;
  }
}
