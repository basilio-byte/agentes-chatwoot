import { createHash } from "node:crypto";
import { z } from "zod";
import { destinatariosSalvos, type Destinatario } from "@/server/alerta-de-saldo/regras";

/**
 * Aviso à equipe por WhatsApp — as regras puras de `avisar_equipe_whatsapp`.
 *
 * Nasceu do agente de jardim (05/10/2026): o Fúlvio pediu que a avaliação
 * semanal chegasse ao celular de quem cuida do jardim e de quem executa, com um
 * "positivo ou negativo". Quem executa não está no ClickUp, então a notificação
 * do ClickUp não o alcança.
 *
 * O caminho de envio não é novo: é o do alerta de saldo, da cobrança e do
 * presente de aniversário (caixa 31, token de usuário, `entregarAviso`).
 * O que é novo é um AGENTE escolher quem recebe — e por isso ele só escolhe
 * entre nomes cadastrados no painel, nunca um número.
 */

/** O recado é curto: o detalhe mora onde o agente trabalha (a task, a nota). */
export const TETO_DO_TEXTO = 700;

/**
 * O mesmo recado à mesma pessoa só sai uma vez nesse intervalo. O modelo repete
 * chamada, o proxy duplica pedido de ferramenta e a fila reexecuta turno —
 * cada um desses viraria um WhatsApp a mais no celular de alguém.
 */
export const HORAS_SEM_REPETIR = 12;

export const configAvisosSchema = z.object({
  /** Quem pode receber. Telefone só aparece para Administrador. */
  destinatarios: z
    .unknown()
    .optional()
    .transform((bruto): Destinatario[] => destinatariosSalvos(bruto)),
  /** Por onde sai: a 31 (WAHA), sem a janela de 24 h do WhatsApp oficial. */
  caixaId: z.number().int().positive().default(31),
});

export type ConfigAvisos = z.infer<typeof configAvisosSchema>;

/** A config gravada, com os padrões no que faltar ou estiver quebrado. */
export function lerConfigAvisos(bruto: unknown): ConfigAvisos {
  const lido = configAvisosSchema.safeParse(bruto ?? {});
  return lido.success ? lido.data : configAvisosSchema.parse({});
}

/** Sem acento, sem caixa e com um espaço só entre as palavras. */
export function normalizarNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const palavras = (nome: string) =>
  normalizarNome(nome)
    .split(" ")
    .filter((p) => p.length >= 3);

export type Escolha = {
  escolhidos: Destinatario[];
  /** Pedidos que não casaram com ninguém do cadastro. */
  naoAchados: string[];
  /** Pedidos que casaram com mais de uma pessoa. */
  ambiguos: string[];
};

/**
 * Casa os nomes que o agente pediu com o cadastro.
 *
 * Nome igual (sem acento nem caixa) vence. Senão, casa quando as palavras do
 * nome mais curto estão todas no outro: "Socorro" acha "Maria do Socorro", e
 * "Maria do Socorro" acha "Socorro". ⚠ Mais de uma pessoa casando é recusa, não
 * palpite — o recado da pessoa errada é o celular errado tocando.
 */
export function escolherDestinatarios(pedidos: string[], cadastrados: Destinatario[]): Escolha {
  const escolhidos: Destinatario[] = [];
  const naoAchados: string[] = [];
  const ambiguos: string[] = [];

  for (const pedido of pedidos) {
    const alvo = normalizarNome(pedido);
    if (!alvo) continue;

    let achados = cadastrados.filter((d) => normalizarNome(d.nome) === alvo);
    if (achados.length === 0) {
      const doPedido = palavras(pedido);
      achados = cadastrados.filter((d) => {
        const doCadastro = palavras(d.nome);
        if (!doPedido.length || !doCadastro.length) return false;
        const [curto, longo] =
          doPedido.length <= doCadastro.length ? [doPedido, doCadastro] : [doCadastro, doPedido];
        return curto.every((p) => longo.includes(p));
      });
    }

    if (achados.length === 1) {
      if (!escolhidos.some((e) => e.telefone === achados[0].telefone)) escolhidos.push(achados[0]);
    } else if (achados.length === 0) {
      naoAchados.push(pedido);
    } else {
      ambiguos.push(pedido);
    }
  }

  return { escolhidos, naoAchados, ambiguos };
}

/**
 * O carimbo é do SISTEMA, não do modelo: quem recebe precisa saber que o recado
 * é automático e de onde veio, antes de agir sobre ele. Mesma lição da nota da
 * conversa parada e das anotações do Conexa.
 */
export function carimbar(texto: string, agente: string | null): string {
  const cabecalho = `🤖 Aviso automático${agente ? ` · ${agente}` : ""}`;
  const limpo = texto.trim();
  return limpo.startsWith("🤖 Aviso automático") ? limpo : `${cabecalho}\n${limpo}`;
}

/** Identifica o recado, para não mandar o mesmo duas vezes. */
export function assinaturaDoTexto(texto: string): string {
  const normalizado = texto.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalizado).digest("hex").slice(0, 16);
}

/**
 * Quem já recebeu ESTE recado, pelas chamadas gravadas da ferramenta.
 *
 * Só conta entrega aceita (`ok: true`) e a mesma assinatura. Simulação de
 * playground, recusa e falha de envio não contam — senão a nova tentativa
 * depois de uma falha seria barrada como repetição.
 */
export function jaAvisados(chamadas: { output: unknown }[], assinatura: string): Set<string> {
  const nomes = new Set<string>();
  for (const { output } of chamadas) {
    if (typeof output !== "object" || output === null || Array.isArray(output)) continue;
    const saida = output as Record<string, unknown>;
    if (saida.assinatura !== assinatura || !Array.isArray(saida.entregas)) continue;
    for (const entrega of saida.entregas as unknown[]) {
      const e = entrega as Record<string, unknown>;
      if (e?.ok === true && typeof e.nome === "string") nomes.add(normalizarNome(e.nome));
    }
  }
  return nomes;
}

/**
 * Tira número de telefone de texto que volta ao modelo e fica gravado.
 *
 * O detalhe de uma falha vem do Chatwoot e pode repetir o número ("phone number
 * has already been taken"). O registro da execução é lido pela equipe inteira,
 * e o telefone é dado que só o Administrador vê.
 */
export function semNumeros(texto: string): string {
  return texto.replace(/\+?\d[\d\s().-]{7,}\d/g, "[número]");
}
