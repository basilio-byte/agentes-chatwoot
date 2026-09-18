import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { baseUrl } from "@/server/agents/openrouter";

/**
 * Saldo da conta da OpenRouter.
 *
 * Substitui o fluxo "Notificar Saldo Openrouter" do n8n, que lia o mesmo
 * endereço de hora em hora e **nunca avisou ninguém**: o nó de decisão não
 * tinha saída ligada. O número aparece na tela de Consumo, que é onde se olha
 * quanto se gastou e é a única tela em que o saldo faz sentido (decisão do
 * usuário em 16/09/2026: o painel é compartilhado com a equipe e o saldo não
 * precisa ficar visível em todas as telas). Desde 18/09/2026 há também o
 * alerta por WhatsApp (`alerta-de-saldo/`), que lê o saldo por esta mesma
 * função, com o mesmo cache.
 *
 * ⚠ **Falha de leitura nunca vira "saldo zero".** Mesma doutrina da consulta de
 * CNPJ e das escritas do Conexa: um timeout nosso não é um fato sobre a conta
 * deles, e um zero inventado mandaria alguém repor crédito que já existe — ou,
 * pior, acusaria falta de saldo quando o problema é outro.
 */

/** Abaixo disto a tela avisa. Herdado do fluxo do n8n que isto substitui. */
export const SALDO_MINIMO_USD = 20;

export type SituacaoDoSaldo = "ok" | "baixo" | "esgotado";

export function classificarSaldo(
  saldoUsd: number,
  minimo = SALDO_MINIMO_USD,
): SituacaoDoSaldo {
  if (saldoUsd <= 0) return "esgotado";
  if (saldoUsd < minimo) return "baixo";
  return "ok";
}

/**
 * Quantos dias o saldo aguenta no ritmo atual.
 *
 * É a única pergunta que o número sozinho não responde: US$ 30 é muito para
 * quem gasta US$ 1 por dia e é o fim da semana para quem gasta US$ 15. Devolve
 * `null` quando não há gasto medido — dividir por zero daria "infinito dias",
 * que é uma promessa que a tela não pode fazer.
 */
export function diasDeSaldo(
  saldoUsd: number,
  gastoDiarioUsd: number,
): number | null {
  if (!Number.isFinite(gastoDiarioUsd) || gastoDiarioUsd <= 0) return null;
  if (saldoUsd <= 0) return 0;
  return saldoUsd / gastoDiarioUsd;
}

export type LeituraDeSaldo =
  | {
      estado: "lido";
      /**
       * `conta` é o saldo da conta inteira (`/credits`); `chave` é o que resta
       * do teto DESTA chave (`/key`), que pode ser bem menos que a conta tem.
       * A tela diz qual dos dois está mostrando — são números diferentes.
       */
      origem: "conta" | "chave";
      saldoUsd: number;
      usadoUsd: number | null;
      compradoUsd: number | null;
      lidoEm: Date;
    }
  /** Sem chave configurada: não há o que perguntar. */
  | { estado: "sem_chave" }
  /** A leitura funcionou e mesmo assim não dá para saber o saldo. */
  | { estado: "indisponivel"; motivo: string; lidoEm: Date }
  /** A leitura falhou. Não diz nada sobre o saldo. */
  | { estado: "erro"; motivo: string; lidoEm: Date };

type CorpoCreditos = { data?: { total_credits?: unknown; total_usage?: unknown } };
type CorpoChave = {
  data?: { limit_remaining?: unknown; usage?: unknown; limit?: unknown };
};

/**
 * `/credits` devolve o comprado e o gasto de toda a conta; o saldo é a
 * diferença. É a mesma conta que o fluxo do n8n fazia.
 */
export function interpretarCreditos(
  corpo: unknown,
): { saldoUsd: number; usadoUsd: number; compradoUsd: number } | null {
  const dados = (corpo as CorpoCreditos | null)?.data;
  const comprado = dados?.total_credits;
  const usado = dados?.total_usage;
  if (typeof comprado !== "number" || typeof usado !== "number") return null;
  if (!Number.isFinite(comprado) || !Number.isFinite(usado)) return null;

  return { saldoUsd: comprado - usado, usadoUsd: usado, compradoUsd: comprado };
}

/**
 * `/key` aceita qualquer chave, mas só sabe do TETO da própria chave.
 *
 * ⚠ `limit_remaining` vem `null` quando a chave não tem teto — e aí esta
 * resposta não diz nada sobre o saldo da conta. Devolver zero, ou o `usage`
 * como se fosse saldo, seria inventar.
 */
export function interpretarChave(
  corpo: unknown,
): { saldoUsd: number; usadoUsd: number | null } | null {
  const dados = (corpo as CorpoChave | null)?.data;
  const resta = dados?.limit_remaining;
  if (typeof resta !== "number" || !Number.isFinite(resta)) return null;

  const usado = dados?.usage;
  return {
    saldoUsd: resta,
    usadoUsd: typeof usado === "number" && Number.isFinite(usado) ? usado : null,
  };
}

const TIMEOUT_MS = 8_000;
/** A tela é de servidor e renderiza a cada abertura: sem cache, cada F5 é uma ida à OpenRouter. */
const TTL_LIDO_MS = 5 * 60_000;
/** Falha expira rápido: um soluço não pode congelar a tela por cinco minutos. */
const TTL_FALHA_MS = 60_000;

let cache: { leitura: LeituraDeSaldo; expiraEm: number } | null = null;

/** Só para teste: derruba o cache de processo. */
export function esquecerSaldo() {
  cache = null;
}

export async function lerSaldo(): Promise<LeituraDeSaldo> {
  if (cache && cache.expiraEm > Date.now()) return cache.leitura;

  const leitura = await consultar();
  const ttl = leitura.estado === "lido" ? TTL_LIDO_MS : TTL_FALHA_MS;
  cache = { leitura, expiraEm: Date.now() + ttl };
  return leitura;
}

async function consultar(): Promise<LeituraDeSaldo> {
  const ambiente = env();
  // A chave de gestão vem primeiro quando existe: a documentação da OpenRouter
  // diz que `/credits` é operação de chave de gestão. Na prática a chave de
  // inferência responde (é o que o fluxo do n8n usava), então ela continua
  // sendo tentada — e, se for recusada, o `/key` ainda responde algo.
  const chave = ambiente.OPENROUTER_MANAGEMENT_KEY ?? ambiente.OPENROUTER_API_KEY;
  if (!chave) return { estado: "sem_chave" };

  const lidoEm = new Date();

  try {
    const creditos = await buscar("/credits", chave);

    if (creditos.ok) {
      const lido = interpretarCreditos(creditos.corpo);
      if (lido) return { estado: "lido", origem: "conta", ...lido, lidoEm };
      return {
        estado: "indisponivel",
        motivo: "a OpenRouter respondeu num formato que não reconheço",
        lidoEm,
      };
    }

    // Só recusa de permissão justifica perguntar de outro jeito. Qualquer outro
    // código é problema de verdade, e insistir só esconderia a causa.
    if (creditos.status !== 401 && creditos.status !== 403) {
      return {
        estado: "erro",
        motivo: `a OpenRouter respondeu HTTP ${creditos.status}`,
        lidoEm,
      };
    }

    const chaveInfo = await buscar("/key", chave);
    if (!chaveInfo.ok) {
      return {
        estado: "erro",
        motivo: `a OpenRouter recusou a chave (HTTP ${creditos.status} em /credits, ${chaveInfo.status} em /key)`,
        lidoEm,
      };
    }

    const lido = interpretarChave(chaveInfo.corpo);
    if (lido) {
      return {
        estado: "lido",
        origem: "chave",
        saldoUsd: lido.saldoUsd,
        usadoUsd: lido.usadoUsd,
        compradoUsd: null,
        lidoEm,
      };
    }

    return {
      estado: "indisponivel",
      motivo:
        "esta chave não tem teto próprio, e o saldo da conta só é devolvido a uma chave de gestão. " +
        "Crie uma em openrouter.ai/settings/management-keys e configure OPENROUTER_MANAGEMENT_KEY.",
      lidoEm,
    };
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    logger.warn({ erro }, "não consegui ler o saldo da OpenRouter");
    return { estado: "erro", motivo, lidoEm };
  }
}

async function buscar(
  caminho: string,
  chave: string,
): Promise<{ ok: boolean; status: number; corpo: unknown }> {
  const resposta = await fetch(`${baseUrl()}${caminho}`, {
    headers: { Authorization: `Bearer ${chave}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // Corpo de erro não interessa: quem decide é o status.
  const corpo = resposta.ok ? await resposta.json() : null;
  return { ok: resposta.ok, status: resposta.status, corpo };
}
