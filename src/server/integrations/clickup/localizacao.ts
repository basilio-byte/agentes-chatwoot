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

const TIPOS_DE_VIA =
  "r|rua|av|avenida|tv|trav|travessa|al|alameda|est|estrada|rod|rodovia|pc|pca|praça|praca|lgo|largo|bc|beco";
const TITULOS_DE_RUA =
  "dr|dra|doutor|doutora|prof|profa|professor|professora|eng|engenheiro|engenheira|cel|coronel|gen|general|des|desembargador|pe|padre|mons|monsenhor|cap|capitão|capitao|ten|tenente|min|ministro|dep|deputado|sen|senador|pres|presidente|gov|governador|ver|vereador|maj|major|sgt|sargento|cmte|comandante|alm|almirante|brig|brigadeiro";
/** Título logo depois do tipo da via: "Rua Dr. Costa Ribeiro", "Av. Pres. Café Filho". */
const RE_TITULO_DE_RUA = new RegExp(
  `\\b(${TIPOS_DE_VIA})(\\.?)\\s+(?:${TITULOS_DE_RUA})\\.?\\s+(?=\\S)`,
  "gi",
);

/**
 * O mesmo endereço, escrito do jeito que o mapa costuma ter (10/11/2026, venda
 * da conversa 14286): o Nominatim não achou "Rua Dr. Costa Ribeiro, 34, Pitimbu,
 * Natal/RN, CEP 59069-330" e achou "Rua Costa Ribeiro, 34, Pitimbu, Natal, RN,
 * 59069-330". No OpenStreetMap a rua não leva o título; a barra de "Natal/RN" e
 * a palavra "CEP" também derrubam a busca. Só mexe na forma: não inventa rua,
 * bairro nem cidade, e o texto que vai para o campo continua sendo o digitado.
 */
export function enderecoSimplificado(endereco: string): string {
  return limparEndereco(
    endereco
      .replace(RE_TITULO_DE_RUA, "$1$2 ")
      .replace(/\bCEP\b\s*:?\s*/gi, "")
      .replace(/\bn[º°]\s*(?=\d)/gi, "")
      .replace(/\s*\/\s*/g, ", ")
      .replace(/,(\s*,)+/g, ","),
  );
}

/**
 * A cidade escrita antes da sigla do estado ("Natal, RN", "Natal - RN",
 * "Natal/RN"), ou `null`. Serve para conferir que a busca simplificada não pôs o
 * pino em outra cidade.
 */
export function cidadeDoEndereco(endereco: string): string | null {
  const achados = [
    ...endereco.matchAll(
      /([^,;/\n]+?)\s*[,/-]\s*(?:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b/g,
    ),
  ];
  const cidade = achados.at(-1)?.[1]?.trim();
  return cidade ? cidade : null;
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
