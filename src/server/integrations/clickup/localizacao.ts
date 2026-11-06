/**
 * Campo de LOCALIZAÇÃO do ClickUp (`type: "location"`), como o "📍 Endereço Sócio".
 *
 * A API não aceita texto: quer `{ location: { lat, lng }, formatted_address }`
 * ("como na Geocoding API do Google"). Provado em 06/11/2026 numa task de teste
 * (HTTP 200, e a leitura devolveu o mesmo valor) que `place_id` NÃO é necessário.
 *
 * Até então o código mandava o texto cru para esse tipo, e a API o recusava — e
 * como campo recusado aborta o lote inteiro, o agente de venda de endereço nem
 * tentava preencher o campo que a regra "EV SB SP" do ClickBot exige.
 *
 * Folha do grafo de módulos: puro, sem importar `campos.ts` (que importa este).
 */

export type Coordenadas = { lat: number; lng: number };

export type ValorDeLocalizacao = {
  location: Coordenadas;
  formatted_address: string;
};

/** Caixa do Brasil, com folga: coordenada fora dela é lixo de geocodificador. */
const LIMITES_DO_BRASIL = { latMin: -34, latMax: 6, lngMin: -74.5, lngMax: -28 };

export function dentroDoBrasil(c: Coordenadas): boolean {
  return (
    Number.isFinite(c.lat) &&
    Number.isFinite(c.lng) &&
    c.lat >= LIMITES_DO_BRASIL.latMin &&
    c.lat <= LIMITES_DO_BRASIL.latMax &&
    c.lng >= LIMITES_DO_BRASIL.lngMin &&
    c.lng <= LIMITES_DO_BRASIL.lngMax
  );
}

/** Os 8 dígitos do primeiro CEP do texto (`59064-500`, `59064500`), ou `null`. */
export function extrairCep(texto: string): string | null {
  const m = /(?<!\d)(\d{5})-?(\d{3})(?!\d)/.exec(texto);
  return m ? `${m[1]}${m[2]}` : null;
}

/** `59064500` → `59064-500`. */
export function formatarCep(cep: string): string {
  return `${cep.slice(0, 5)}-${cep.slice(5)}`;
}

/** O endereço como vai para o campo: sem espaço sobrando, com teto de tamanho. */
export function limparEndereco(texto: string): string {
  return texto.replace(/\s+/g, " ").trim().slice(0, 300);
}

export function ehValorDeLocalizacao(valor: unknown): valor is ValorDeLocalizacao {
  if (typeof valor !== "object" || valor === null) return false;
  const v = valor as { location?: { lat?: unknown; lng?: unknown }; formatted_address?: unknown };
  return (
    typeof v.location?.lat === "number" &&
    typeof v.location?.lng === "number" &&
    dentroDoBrasil({ lat: v.location.lat, lng: v.location.lng }) &&
    typeof v.formatted_address === "string" &&
    v.formatted_address.trim().length > 0
  );
}

/**
 * O corpo da API. O texto é o endereço como o cliente o deu — é ele que a equipe
 * lê e o contrato usa; as coordenadas só põem o pino no mapa, aproximado (na rua,
 * não no número), e por isso nunca substituem o texto.
 */
export function valorDeLocalizacao(endereco: string, c: Coordenadas): ValorDeLocalizacao {
  return {
    location: { lat: Number(c.lat.toFixed(7)), lng: Number(c.lng.toFixed(7)) },
    formatted_address: limparEndereco(endereco),
  };
}
