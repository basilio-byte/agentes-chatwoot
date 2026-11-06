import { logger } from "@/lib/logger";
import {
  dentroDoBrasil,
  extrairCep,
  formatarCep,
  limparEndereco,
  type Coordenadas,
} from "../clickup/localizacao";

/**
 * Endereço → coordenadas, pelo Nominatim (OpenStreetMap).
 *
 * Por que ele, e não a BrasilAPI por CEP (medido em 06/11/2026): a BrasilAPI
 * devolve o centro da CIDADE — todo CEP de Natal volta com o mesmo ponto
 * (-5.795, -35.209) —, e um pino igual para todo cliente seria dado falso com
 * cara de dado. O Nominatim põe o pino na rua certa quando recebe bairro e CEP
 * (na rua, não no número: o texto do endereço é que vale). Gratuito e sem chave;
 * a política de uso pede no máximo 1 consulta por segundo e um User-Agent que
 * identifique quem chama — o volume daqui é de algumas por semana.
 *
 * ⚠ Falha NUNCA vira coordenada inventada: sem resposta, devolve `null`, e quem
 * chama deixa o campo em branco para a equipe preencher.
 */

const URL_DA_BUSCA = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "SeahubAgentes/1.0 (+https://agentes.seahubcoworking.com.br)";
const PRAZO_MS = 6_000;
/** A política do Nominatim: no máximo 1 consulta por segundo. */
const ESPERA_ENTRE_CONSULTAS_MS = 1_100;
const VALIDADE_DO_CACHE_MS = 24 * 60 * 60 * 1000;
const TETO_DO_CACHE = 200;

type Resultado = { lat?: string; lon?: string; display_name?: string };

const cache = new Map<string, { em: number; coordenadas: Coordenadas }>();

export function esquecerGeocodificacoes() {
  cache.clear();
}

export type OpcoesDaGeocodificacao = {
  fetchImpl?: typeof fetch;
  esperar?: (ms: number) => Promise<void>;
};

async function buscar(
  consulta: string,
  fetchImpl: typeof fetch,
): Promise<Resultado | null> {
  try {
    const url = `${URL_DA_BUSCA}?${new URLSearchParams({
      format: "jsonv2",
      limit: "1",
      countrycodes: "br",
      q: consulta,
    })}`;
    const resposta = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "pt-BR" },
      signal: AbortSignal.timeout(PRAZO_MS),
    });
    if (!resposta.ok) {
      logger.warn({ status: resposta.status }, "geocodificação: o Nominatim recusou a consulta");
      return null;
    }
    const corpo = (await resposta.json()) as unknown;
    return Array.isArray(corpo) && corpo.length > 0 ? (corpo[0] as Resultado) : null;
  } catch (erro) {
    logger.warn({ erro }, "geocodificação: o Nominatim não respondeu");
    return null;
  }
}

function coordenadasDe(resultado: Resultado | null): Coordenadas | null {
  if (!resultado) return null;
  const c = { lat: Number(resultado.lat), lng: Number(resultado.lon) };
  return dentroDoBrasil(c) ? c : null;
}

/**
 * Tenta o endereço inteiro; se não achar e houver CEP, tenta só o CEP — e aí só
 * vale se o resultado cita o MESMO CEP, para um CEP parecido não pôr o pino em
 * outro lugar.
 */
export async function geocodificarEndereco(
  endereco: string,
  opcoes: OpcoesDaGeocodificacao = {},
): Promise<Coordenadas | null> {
  const fetchImpl = opcoes.fetchImpl ?? fetch;
  const esperar = opcoes.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const texto = limparEndereco(endereco);
  if (!texto) return null;

  const chave = texto.toLowerCase();
  const guardado = cache.get(chave);
  if (guardado && Date.now() - guardado.em < VALIDADE_DO_CACHE_MS) return guardado.coordenadas;

  let coordenadas = coordenadasDe(await buscar(texto, fetchImpl));

  if (!coordenadas) {
    const cep = extrairCep(texto);
    if (cep) {
      await esperar(ESPERA_ENTRE_CONSULTAS_MS);
      const pelaCep = await buscar(formatarCep(cep), fetchImpl);
      if (pelaCep?.display_name?.includes(formatarCep(cep))) {
        coordenadas = coordenadasDe(pelaCep);
      }
    }
  }

  if (coordenadas) {
    if (cache.size >= TETO_DO_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(chave, { em: Date.now(), coordenadas });
  }
  return coordenadas;
}
