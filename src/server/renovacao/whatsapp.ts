import { createHash } from "node:crypto";

import { FUSO_SEAHUB } from "@/lib/tempo";
import { normalizarTelefone } from "@/server/alerta-de-saldo/regras";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";

import { STATUS_NOTIFICACAO } from "./regras";

/**
 * O WhatsApp da renovação para o cliente ONE — as regras, puras.
 *
 * Substitui o fluxo "Mensagem de renovação Clickup <> Chatwoot" do n8n
 * (`jZZEZ7yEpz14O4hQ`, desligado). O que ele fazia, e o que o ClickUp ainda faz:
 *
 * - A automação 5 do ClickUp (`Enviar mensagem de renovação por Whatsapp ONE e
 *   Seaway`: status para `notificação renovação` + CATEGORIA = ONE) chama o
 *   webhook desse fluxo. Com o fluxo desligado, ela dispara e nada sai — o
 *   cliente ONE recebe só o e-mail da automação 4.
 * - O fluxo mandava o texto pela Evolution API (servidor antigo), depois buscava
 *   o contato no Chatwoot, abria a conversa e a atribuía ao Felipe.
 *
 * ⚠ **Daqui o gatilho é o ESTADO, não o evento.** Em vez de esperar o ClickUp
 * chamar um endereço (e depender de a automação disparar quando é o SISTEMA que
 * troca o status pela API — coisa não provada), a rodada olha as tarefas que
 * estão em `notificação renovação` e entraram nele há pouco. Mesma doutrina do
 * aviso de cobrança, e a automação 5 pode continuar onde está: ela chama um fluxo
 * que não existe mais.
 *
 * ⚠ **Só a categoria ONE.** É o que a automação 5 cobria. Os outros três textos
 * do fluxo (Seahub, endereço com oferta bianual e "cliente renovado") não são
 * chamados por automação nenhuma — os clientes deles recebem só o e-mail do
 * ClickUp —, e portá-los acrescentaria mensagens que hoje não existem.
 */

/** Chave das reservas e dos desfechos em `WebhookEvent` (`provider` RENOVACAO). */
export const PREFIXO_DA_RESERVA = "whatsapp";
export const PREFIXO_DO_ENSAIO = "whatsapp-sombra";
export const PREFIXO_DA_FALHA = "whatsapp-falha";
/** O resumo da rodada, um por dia: `mensagens:<dia>`. */
export const CHAVE_DO_RESUMO = "mensagens";

/**
 * A caixa por onde a mensagem sai: a 31 (WAHA), a mesma do aviso de cobrança e
 * do alerta de saldo. Sem a janela de 24 h do WhatsApp oficial, e é por onde a
 * equipe já inicia conversa todo dia. O n8n mandava pela Evolution, que não é
 * nossa.
 */
export const CAIXA_DO_WHATSAPP = 31;

/** O campo CELULAR (tipo phone) da Base de clientes — o mesmo do aviso de cobrança. */
export const CAMPO_CELULAR = "3399c6f6-c890-40a6-865e-5a4e810fe8c6";

export const CONFERIR_A_CADA_MS = 30 * 60_000;

/**
 * A mensagem é do MOMENTO em que a tarefa entra em `notificação renovação`: só
 * vale para quem entrou há até esta janela. Sem ela, o primeiro dia em que a
 * chave fosse ligada mandaria "está se aproximando o período de renovação" a
 * quem está nesse status há semanas.
 *
 * 96 horas porque um fim de semana com feriado separa uma passagem de sexta às
 * 17h59 da primeira manhã útil (terça, 8h: 86 h).
 */
export const JANELA_EM_HORAS = 96;

/** Por rodada. A caixa 31 é conexão NÃO oficial: lote de uma vez é número bloqueado. */
export const ENVIOS_POR_RODADA = 10;
export const INTERVALO_ENTRE_ENVIOS_S = 30;
export const TETO_POR_HORA = 20;
/** Reserva "reservado" mais velha que isto é de um processo que caiu no meio. */
export const RESERVA_ABANDONADA_MS = 10 * 60_000;

/** O texto do n8n, letra por letra, com o nome do responsável como `{responsavel}`. */
export const TEXTO_PADRAO_ONE = [
  "Prezado(a) {responsavel},",
  "",
  "Esperamos que esta mensagem o(a) encontre bem.",
  "",
  "Gostaríamos de informar que está se aproximando o período de renovação do contrato referente ao seu espaço. Como parte do processo de atualização contratual, o reajuste do valor seguirá o Índice Geral de Preços – Mercado (IGP-M), conforme estabelecido no contrato vigente.",
  "",
  "O IGP-M é um indicador amplamente utilizado para atualização de valores contratuais e reflete a variação dos custos no mercado. Nosso compromisso é sempre garantir transparência e manter uma relação de parceria com nossos lojistas. Caso tenha dúvidas ou precise de esclarecimentos sobre o reajuste, estamos à disposição para conversar e auxiliá-lo(a) no que for necessário.",
  "",
  "Agradecemos pela confiança e parceria contínua. Para mais informações ou para dar andamento ao processo de renovação, entre em contato conosco.",
].join("\n");

export const ATRIBUIR_A_PADRAO = "Lucas Xavier";

const LIMITE_DO_TEXTO = { minimo: 40, maximo: 1500 };

function simples(texto: string | null | undefined) {
  return (texto ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/** O cliente ONE é o de `CATEGORIA DE SERVIÇO` = "ONE" — a condição da automação 5. */
export function ehClienteOne(categoria: string | null | undefined) {
  return simples(categoria) === "one";
}

/**
 * O texto com o nome de quem o recebe. Sem nome, o espaço antes do `{responsavel}`
 * some junto: "Prezado(a)," em vez de "Prezado(a) ,".
 */
export function textoDaMensagem(modelo: string | null | undefined, responsavel: string | null) {
  const nome = (responsavel ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return (modelo?.trim() || TEXTO_PADRAO_ONE).replace(
    /( ?)\{responsavel\}/g,
    (_, espaco: string) => (nome ? `${espaco}${nome}` : ""),
  );
}

/** Primeira recusa do texto escrito na tela, ou `null` se serve. */
export function recusaDoTexto(texto: string): string | null {
  const t = texto.trim();
  if (t.length < LIMITE_DO_TEXTO.minimo || t.length > LIMITE_DO_TEXTO.maximo) {
    return `O texto da mensagem precisa ter de ${LIMITE_DO_TEXTO.minimo} a ${LIMITE_DO_TEXTO.maximo} caracteres.`;
  }
  // `{nome}` escrito errado sairia LITERAL para o cliente: o único marcador é este.
  const estranho = [...t.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).find((m) => m !== "responsavel");
  if (estranho !== undefined) {
    return `O texto tem o marcador {${estranho}}, que não existe. O único é {responsavel}.`;
  }
  return null;
}

export type TarefaParaAvisar = {
  id: string;
  nome: string;
  status: string;
  /** Milissegundos em que a tarefa entrou no status de agora, lido do ClickUp. */
  entrouEmMs: number | null;
  categoria: string | null;
  /** O telefone do campo CELULAR, em E.164, ou `null`. */
  telefone: string | null;
};

/** Por que uma tarefa NÃO recebe a mensagem agora. */
export type CodigoDeNaoEnviar =
  | "outro-status"
  | "nao-one"
  | "fora-da-janela"
  | "sem-leitura"
  | "sem-celular";

/**
 * Os casos NORMAIS — não são pendência e não entram na lista do que a rodada
 * olhou e deixou. O resto é o que alguém precisa ver.
 */
export const CODIGOS_SILENCIOSOS: readonly CodigoDeNaoEnviar[] = [
  "outro-status",
  "nao-one",
  "fora-da-janela",
];

export type DecisaoDoAviso =
  | { enviar: true; entrouEmMs: number }
  | { enviar: false; codigo: CodigoDeNaoEnviar; motivo: string };

/** Enviar o WhatsApp desta tarefa agora? Na dúvida, não. */
export function decidirAviso(tarefa: TarefaParaAvisar, agora: Date): DecisaoDoAviso {
  if (simples(tarefa.status) !== simples(STATUS_NOTIFICACAO)) {
    return {
      enviar: false,
      codigo: "outro-status",
      motivo: `a tarefa está em "${tarefa.status}", não em "${STATUS_NOTIFICACAO}"`,
    };
  }
  if (!ehClienteOne(tarefa.categoria)) {
    return { enviar: false, codigo: "nao-one", motivo: "a categoria não é ONE" };
  }
  if (tarefa.entrouEmMs == null) {
    return {
      enviar: false,
      codigo: "sem-leitura",
      motivo: "não consegui ler desde quando a tarefa está em notificação",
    };
  }
  const horas = (agora.getTime() - tarefa.entrouEmMs) / 3_600_000;
  if (horas > JANELA_EM_HORAS) {
    return {
      enviar: false,
      codigo: "fora-da-janela",
      motivo: `está em notificação há ${Math.floor(horas / 24)} dia(s): a mensagem é do momento da passagem`,
    };
  }
  if (!tarefa.telefone) {
    return { enviar: false, codigo: "sem-celular", motivo: "a tarefa não tem CELULAR válido" };
  }
  return { enviar: true, entrouEmMs: tarefa.entrouEmMs };
}

/**
 * Recusa clara do Chatwoot: 4xx (menos 408 e 429, que são "tente depois"). Nada
 * saiu, e repetir igual dá no mesmo — alguém corrige o número.
 */
export function ehRecusaClara(status: number) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** O campo CELULAR da tarefa, em E.164. */
export function telefoneDaTarefaOne(tarefa: Pick<ClickUpTarefa, "custom_fields">): string | null {
  const valor = tarefa.custom_fields?.find((c) => c.id === CAMPO_CELULAR)?.value;
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  return normalizarTelefone(String(valor));
}

/** O nome de quem o cliente conhece: o campo RESPONSÁVEL, nunca o da equipe. */
export function responsavelDaTarefa(campos: Record<string, unknown>): string | null {
  for (const [nome, valor] of Object.entries(campos)) {
    if (simples(nome) === "responsavel" && typeof valor === "string" && valor.trim()) {
      return valor.trim();
    }
  }
  return null;
}

/** O nome do contato novo no Chatwoot: a pessoa, ou a empresa sem o "(1234) " do início. */
export function nomeDoContato(nomeDaTarefa: string, responsavel: string | null) {
  return responsavel || nomeDaTarefa.replace(/^\(\d+\)\s*/, "").trim() || "Cliente";
}

/** Só os quatro últimos dígitos: o rastro mostra QUAL número sem expor o telefone. */
export function finalDoTelefone(telefone: string) {
  return `…${telefone.replace(/\D/g, "").slice(-4)}`;
}

/** A chave da reserva: uma entrada no status, uma mensagem. */
export function chaveDoEnvio(tarefaId: string, entrouEmMs: number) {
  return `${PREFIXO_DA_RESERVA}:${tarefaId}:${entrouEmMs}`;
}

export function chaveDoEnsaio(tarefaId: string, entrouEmMs: number) {
  return `${PREFIXO_DO_ENSAIO}:${tarefaId}:${entrouEmMs}`;
}

/**
 * A chave da falha leva o número, para corrigir o CELULAR liberar nova tentativa —
 * mas como hash: a chave é texto de uma tabela que a equipe lê, e telefone não
 * mora lá.
 */
export function chaveDaFalha(tarefaId: string, entrouEmMs: number, codigo: string, telefone: string) {
  const numero = createHash("sha256").update(telefone).digest("hex").slice(0, 12);
  return `${PREFIXO_DA_FALHA}:${tarefaId}:${entrouEmMs}:${codigo}:${numero}`;
}

/** O comentário na tarefa depois do envio. */
export function comentarioDeEnvio(args: {
  quando: string;
  linkDaConversa: string | null;
  /** O que ficou da conversa, numa frase: atribuída, com quem ficou. */
  destino: string | null;
  problemas: string[];
}) {
  return [
    `✅ WhatsApp de renovação enviado ao cliente em ${args.quando}.`,
    args.linkDaConversa ? `Conversa no Chatwoot: ${args.linkDaConversa}` : null,
    args.destino,
    ...args.problemas.map((p) => `⚠ ${p}`),
    "",
    "_Lançado pelo sistema de agentes, no lugar do fluxo do n8n._",
  ]
    .filter((linha) => linha !== null)
    .join("\n");
}

/** O comentário quando não dá para enviar — sai uma vez por motivo. */
export function comentarioDeFalha(motivo: string) {
  return `⚠ O WhatsApp de renovação NÃO foi enviado: ${motivo}. Corrija e ele é tentado de novo na conferência seguinte (a cada 30 minutos, em horário comercial), enquanto a tarefa estiver em "${STATUS_NOTIFICACAO}" há menos de ${JANELA_EM_HORAS / 24} dias.`;
}

/** O comentário quando o envio pode ter saído e não dá para saber. */
export function comentarioDeIncerto(motivo: string) {
  return `⚠ O WhatsApp de renovação PODE ter chegado ao cliente (${motivo}). O sistema NÃO vai reenviar. Confira a conversa no Chatwoot e, se não saiu, mande à mão.`;
}

/** A nota interna na conversa: quem abrir sabe de onde veio a mensagem. */
export function notaDaConversa(urlDaTarefa: string | null) {
  return [
    "🔔 WhatsApp de renovação enviado automaticamente: a tarefa entrou em “notificação renovação” no ClickUp.",
    urlDaTarefa ? `Tarefa: ${urlDaTarefa}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Segunda a sexta, 8h às 18h em São Paulo — o mesmo horário da cobrança. */
export function dentroDoHorarioComercial(agora: Date): boolean {
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

/**
 * O que a tela do formulário grava: quem recebe a conversa e o texto. Texto igual
 * ao padrão (ou em branco) vira `null`: a tela segue o padrão se ele mudar.
 */
export function dadosDoFormulario(
  ler: (campo: string) => string | null,
  atual: { whatsappAtribuirA: string; whatsappTexto: string | null },
): { atribuirA: string; texto: string | null } | { erro: string } {
  const bruto = ler("whatsappAtribuirA");
  const atribuirA = bruto === null ? atual.whatsappAtribuirA : bruto.trim();
  if (!atribuirA) return { erro: "Atribuir a: diga quem recebe a conversa depois do envio." };
  if (atribuirA.length > 80) return { erro: "Atribuir a: no máximo 80 caracteres." };

  const textoBruto = ler("whatsappTexto");
  if (textoBruto === null) return { atribuirA, texto: atual.whatsappTexto };

  const texto = textoBruto.replace(/\r\n/g, "\n").trim();
  if (!texto || texto === TEXTO_PADRAO_ONE) return { atribuirA, texto: null };
  const recusa = recusaDoTexto(texto);
  return recusa ? { erro: recusa } : { atribuirA, texto };
}
