import OpenAI from "openai";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  MODELO_PADRAO_CLAUDE_MAX,
  resolverMotor,
  type MotorDoAgente,
  type ResolucaoDoMotor,
} from "./motor";

/**
 * O proxy Claude MAX: cliente, catálogo de modelos e a chave geral.
 *
 * O proxy é o `claude-max-api-proxy`, projeto à parte do usuário, que roda o
 * Claude Code da assinatura Max atrás de um endpoint compatível com a OpenAI.
 * Mesmo SDK que a OpenRouter, outra `baseURL`, outra chave — como a leitura de
 * mídia faz com a OpenAI direta.
 */

/** A base OpenAI do proxy termina em `/v1`; aceita com ou sem, e sem barra no fim. */
export function baseUrlClaudeMax(): string | null {
  const bruta = env().CLAUDE_MAX_BASE_URL?.trim();
  if (!bruta) return null;
  const sem = bruta.replace(/\/+$/, "");
  return sem.endsWith("/v1") ? sem : `${sem}/v1`;
}

export function claudeMaxConfigurado(): boolean {
  return Boolean(baseUrlClaudeMax() && env().CLAUDE_MAX_API_KEY?.trim());
}

/**
 * Teto de uma ida ao proxy. Uma resposta do Opus com raciocínio passa de um
 * minuto; acima disto é mais barato voltar para a OpenRouter do que esperar —
 * o vigia entrega a conversa a uma pessoa em 3 minutos de espera.
 */
const TIMEOUT_MS = 120_000;

let cliente: OpenAI | null = null;

/**
 * ⚠ `maxRetries: 0`, ao contrário da OpenRouter. O SDK repete 429 e 5xx sozinho
 * duas vezes, com espera: aqui cada repetição é tempo de cliente esperando uma
 * resposta que a OpenRouter daria na hora. A volta É a nova tentativa.
 */
export function getClaudeMax(): OpenAI {
  const baseURL = baseUrlClaudeMax();
  const apiKey = env().CLAUDE_MAX_API_KEY?.trim();
  if (!baseURL || !apiKey) {
    throw new Error(
      "Proxy Claude MAX não configurado: defina CLAUDE_MAX_BASE_URL e CLAUDE_MAX_API_KEY no Easypanel.",
    );
  }
  cliente ??= new OpenAI({ apiKey, baseURL, timeout: TIMEOUT_MS, maxRetries: 0 });
  return cliente;
}

export type ModeloClaudeMax = {
  id: string;
  nome: string;
  contexto: number | null;
  maxSaida: number | null;
};

/**
 * Reserva, se o proxy não responder: os modelos do plano Max em 21/09/2026. O
 * proxy lê a lista da própria assinatura; esta só existe para a tela não ficar
 * sem opção.
 */
const RESERVA: ModeloClaudeMax[] = [
  { id: "claude-sonnet-5", nome: "Claude Sonnet 5", contexto: null, maxSaida: null },
  { id: "claude-haiku-4-5", nome: "Claude Haiku 4.5", contexto: null, maxSaida: null },
  { id: "claude-opus-5", nome: "Claude Opus 5", contexto: null, maxSaida: null },
  { id: "claude-fable-5-1", nome: "Claude Fable 5.1", contexto: null, maxSaida: null },
];

/** `claude-haiku-4-5` → `Claude Haiku 4.5`. O `/models` do proxy não traz nome. */
export function nomeDoModelo(id: string): string {
  const partes = id.split("-");
  const palavras = partes.filter((p) => !/^\d+$/.test(p));
  const versao = partes.filter((p) => /^\d+$/.test(p)).join(".");
  const nome = palavras.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  return versao ? `${nome} ${versao}` : nome;
}

type RespostaDeModelos = {
  data?: Array<{
    id?: string;
    context_window?: number | null;
    max_output_tokens?: number | null;
  }>;
};

const TTL_MS = 60 * 60 * 1000;
let catalogo: { modelos: ModeloClaudeMax[]; doProxy: boolean; expiraEm: number } | null = null;

/** Só para teste. */
export function esquecerCatalogoClaudeMax() {
  catalogo = null;
  cliente = null;
}

/**
 * Os modelos que o plano oferece, lidos do próprio proxy (`GET /models`, que
 * exige a chave). Cache de 1 h, como o da OpenRouter. `doProxy: false` diz à
 * tela que a lista é a reserva — o proxy não respondeu.
 */
export async function listarModelosClaudeMax(): Promise<{
  modelos: ModeloClaudeMax[];
  doProxy: boolean;
}> {
  if (catalogo && catalogo.expiraEm > Date.now()) return catalogo;
  const baseURL = baseUrlClaudeMax();
  const apiKey = env().CLAUDE_MAX_API_KEY?.trim();
  if (!baseURL || !apiKey) return { modelos: RESERVA, doProxy: false };

  try {
    const resposta = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    const corpo = (await resposta.json()) as RespostaDeModelos;
    const modelos = (corpo.data ?? [])
      .filter((m): m is { id: string } & typeof m => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({
        id: m.id,
        nome: nomeDoModelo(m.id),
        contexto: typeof m.context_window === "number" ? m.context_window : null,
        maxSaida: typeof m.max_output_tokens === "number" ? m.max_output_tokens : null,
      }));
    if (modelos.length === 0) throw new Error("lista vazia");
    catalogo = { modelos, doProxy: true, expiraEm: Date.now() + TTL_MS };
    return catalogo;
  } catch (erro) {
    logger.warn(
      { erro: erro instanceof Error ? erro.message : erro },
      "não consegui listar os modelos do proxy Claude MAX — usando a reserva",
    );
    // Falha expira rápido: o proxy pode estar só reiniciando.
    catalogo = { modelos: RESERVA, doProxy: false, expiraEm: Date.now() + 60_000 };
    return catalogo;
  }
}

export async function obterModeloClaudeMax(id: string): Promise<ModeloClaudeMax | null> {
  const { modelos } = await listarModelosClaudeMax();
  return modelos.find((m) => m.id === id) ?? null;
}

/** A chave geral. Sem linha gravada, desligada — o sistema de antes. */
export async function lerMotorGlobal(): Promise<{ claudeMaxLigado: boolean; modeloPadrao: string }> {
  const linha = await db.motorDosAgentes.findUnique({ where: { id: "unico" } });
  return {
    claudeMaxLigado: linha?.claudeMaxLigado ?? false,
    modeloPadrao: linha?.modeloPadrao || MODELO_PADRAO_CLAUDE_MAX,
  };
}

/** O motor deste agente agora, com a chave geral e a configuração lidas na hora. */
export async function planejarMotor(agente: {
  motor: MotorDoAgente;
  modeloClaudeMax: string | null;
}): Promise<ResolucaoDoMotor> {
  const configurado = claudeMaxConfigurado();
  // Sem proxy configurado não há o que ler: a OpenRouter é a resposta, e o
  // turno de sempre não ganha nem uma consulta a mais.
  const global = configurado
    ? await lerMotorGlobal()
    : { claudeMaxLigado: false, modeloPadrao: MODELO_PADRAO_CLAUDE_MAX };
  return resolverMotor({
    motorDoAgente: agente.motor,
    modeloDoAgente: agente.modeloClaudeMax,
    chaveGeralLigada: global.claudeMaxLigado,
    modeloPadrao: global.modeloPadrao,
    proxyConfigurado: configurado,
  });
}
