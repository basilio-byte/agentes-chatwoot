import type { CepLido } from "./regras";

/**
 * Consulta de CEP (ViaCEP, pública e gratuita), para duas coisas que a Spedy só
 * descobre DEPOIS de gastar número: o código IBGE da cidade do tomador e se o
 * CEP existe e é da cidade que o cadastro diz — a nota rejeitada em 07/10/2026
 * (E0240) era exatamente isso.
 *
 * ⚠ Falha da consulta é `desconhecido`, nunca `inexistente`: só a resposta
 * `erro: true` do ViaCEP autoriza dizer que o CEP não existe. Um serviço público
 * fora do ar não pode segurar nota de cliente.
 *
 * Cache em memória por 24 h, porque o mesmo cliente tem várias cobranças.
 */

const VALIDADE_MS = 24 * 60 * 60_000;
const PRAZO_MS = 5_000;

const guardados = new Map<string, { em: number; lido: CepLido }>();

type Buscador = (url: string, init?: RequestInit) => Promise<Response>;

export async function consultarCep(
  cep: string,
  opcoes: { buscar?: Buscador; agora?: number } = {},
): Promise<CepLido> {
  const buscar = opcoes.buscar ?? fetch;
  const agora = opcoes.agora ?? Date.now();
  if (!/^\d{8}$/.test(cep)) return { estado: "desconhecido" };

  const guardado = guardados.get(cep);
  if (guardado && agora - guardado.em < VALIDADE_MS) return guardado.lido;

  let lido: CepLido;
  try {
    const resposta = await buscar(`https://viacep.com.br/ws/${cep}/json/`, {
      signal: AbortSignal.timeout(PRAZO_MS),
    });
    if (!resposta.ok) return { estado: "desconhecido" };
    const json = (await resposta.json()) as Record<string, unknown>;
    if (json.erro === true || json.erro === "true") {
      lido = { estado: "inexistente" };
    } else if (typeof json.localidade === "string" && json.localidade) {
      const ibge = Number(json.ibge);
      lido = {
        estado: "ok",
        ibge: Number.isInteger(ibge) && ibge > 0 ? ibge : null,
        cidade: json.localidade,
        uf: typeof json.uf === "string" ? json.uf : "",
      };
    } else {
      return { estado: "desconhecido" };
    }
  } catch {
    return { estado: "desconhecido" };
  }
  guardados.set(cep, { em: agora, lido });
  return lido;
}

/** Só para teste. */
export function esquecerCeps() {
  guardados.clear();
}
