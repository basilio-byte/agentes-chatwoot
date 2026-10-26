import { z } from "zod";
import { ID_DE_CONTEINER } from "./config";

/**
 * O lote que o coletor do servidor dos OpenClaws manda.
 *
 * **Um lote é uma janela inteira e se substitui por inteiro**: para os
 * contêineres listados em `conteineres` e as horas de [desde, ate), o que o
 * banco tinha é apagado e o que veio é gravado. Mandar o mesmo lote duas vezes
 * dá o mesmo resultado, e uma hora que ficou sem uso some em vez de sobrar
 * velha. Por isso o coletor lista TODOS os contêineres que leu, mesmo os sem
 * linha na janela — ausência de linha é "não houve uso", não "não sei".
 */

export const MAX_DE_LINHAS_POR_LOTE = 5000;
export const MAX_DE_DIAS_POR_LOTE = 45;

const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;

const inteiro = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const contagem = z.number().int().min(1).max(1_000_000);
const hora = z.iso.datetime();
const idDoConteiner = z.string().regex(ID_DE_CONTEINER);

const usoSchema = z
  .object({
    hora,
    conteiner: idDoConteiner,
    agente: z.string().regex(/^[\w.-]{1,64}$/),
    tipo: z.string().regex(/^[\w.:-]{1,40}$/),
    modelo: z.string().min(1).max(120),
    chamadas: contagem,
    entrada: inteiro,
    saida: inteiro,
    cacheLeitura: inteiro,
    cacheEscrita: inteiro,
  })
  .strict();

const limiteSchema = z
  .object({
    hora,
    conteiner: idDoConteiner,
    categoria: z.enum(["rate_limit", "prompt_too_long", "outro"]),
    quantidade: contagem,
  })
  .strict();

const janelaDaCotaSchema = z
  .object({
    chave: z.string().regex(/^[\w:.-]{1,60}$/),
    // Pode passar de 100 em plano com uso extra liberado.
    utilizacao: z.number().min(0).max(1000),
    resetaEm: hora.nullable().optional(),
  })
  .strict();

/**
 * A leitura REAL da cota, feita pelo coletor com o login completo da conta.
 * Opcional: o coletor sem esse login (ou com ele vencido) manda o lote sem ela, e
 * o painel segue na cota estimada pelos bloqueios.
 */
const cotaSchema = z
  .object({
    lidaEm: hora,
    plano: z.string().max(40).nullable().optional(),
    janelas: z.array(janelaDaCotaSchema).min(1).max(12),
  })
  .strict();

const loteSchema = z
  .object({
    desde: hora,
    ate: hora,
    conteineres: z.array(idDoConteiner).min(1).max(20),
    uso: z.array(usoSchema).max(MAX_DE_LINHAS_POR_LOTE),
    limites: z.array(limiteSchema).max(MAX_DE_LINHAS_POR_LOTE),
    cota: cotaSchema.optional(),
  })
  .strict();

export type UsoDoLote = {
  hora: Date;
  conteiner: string;
  agente: string;
  tipo: string;
  modelo: string;
  chamadas: number;
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cacheEscrita: number;
};

export type LimiteDoLote = {
  hora: Date;
  conteiner: string;
  categoria: "rate_limit" | "prompt_too_long" | "outro";
  quantidade: number;
};

export type CotaDoLote = {
  /** Truncada ao minuto: é a metade da chave única da leitura. */
  lidaEm: Date;
  plano: string | null;
  janelas: { chave: string; utilizacao: number; resetaEm: Date | null }[];
};

export type Lote = {
  desde: Date;
  ate: Date;
  conteineres: string[];
  uso: UsoDoLote[];
  limites: LimiteDoLote[];
  cota: CotaDoLote | null;
};

/** Leitura datada de mais de um dia atrás não descreve o presente: recusar evita regravar o passado. */
const MAX_DE_IDADE_DA_LEITURA_MS = 24 * HORA_MS;
const MINUTO_MS = 60_000;

export type ResultadoDaValidacao =
  | { ok: true; lote: Lote }
  | { ok: false; erro: string };

const naHoraCheia = (d: Date) => d.getTime() % HORA_MS === 0;

/**
 * Confere o corpo e as regras que o schema sozinho não diz: horas cheias dentro
 * da janela, contêineres declarados, nenhuma linha repetida. Recusar é barato;
 * gravar uma linha fora da janela deixaria um resto que nenhum lote seguinte
 * apagaria.
 */
export function validarLote(bruto: unknown, agora: Date = new Date()): ResultadoDaValidacao {
  const lido = loteSchema.safeParse(bruto);
  if (!lido.success) {
    const primeiro = lido.error.issues[0];
    const onde = primeiro?.path.length ? primeiro.path.join(".") : "corpo";
    return { ok: false, erro: `Lote inválido em ${onde}: ${primeiro?.message ?? "formato"}.` };
  }
  const { desde: d, ate: a, conteineres, uso, limites, cota } = lido.data;
  const desde = new Date(d);
  const ate = new Date(a);

  if (!naHoraCheia(desde) || !naHoraCheia(ate)) {
    return { ok: false, erro: "`desde` e `ate` precisam ser horas cheias." };
  }
  if (ate.getTime() <= desde.getTime()) {
    return { ok: false, erro: "`ate` precisa ser depois de `desde`." };
  }
  if (ate.getTime() - desde.getTime() > MAX_DE_DIAS_POR_LOTE * DIA_MS) {
    return { ok: false, erro: `A janela passa de ${MAX_DE_DIAS_POR_LOTE} dias; mande em lotes menores.` };
  }
  // Janela no futuro apagaria e regravaria horas que ainda não aconteceram.
  if (ate.getTime() > agora.getTime() + 2 * HORA_MS) {
    return { ok: false, erro: "`ate` está no futuro." };
  }

  const declarados = new Set(conteineres);
  if (declarados.size !== conteineres.length) {
    return { ok: false, erro: "Contêiner repetido em `conteineres`." };
  }

  const dentro = (h: Date) =>
    naHoraCheia(h) && h.getTime() >= desde.getTime() && h.getTime() < ate.getTime();

  const chavesDeUso = new Set<string>();
  const usoLido: UsoDoLote[] = [];
  for (const [i, linha] of uso.entries()) {
    const h = new Date(linha.hora);
    if (!dentro(h)) return { ok: false, erro: `uso[${i}]: hora fora da janela ou não cheia.` };
    if (!declarados.has(linha.conteiner)) {
      return { ok: false, erro: `uso[${i}]: contêiner ${linha.conteiner} não está em \`conteineres\`.` };
    }
    const chave = [h.getTime(), linha.conteiner, linha.agente, linha.tipo, linha.modelo].join("|");
    if (chavesDeUso.has(chave)) return { ok: false, erro: `uso[${i}]: linha repetida.` };
    chavesDeUso.add(chave);
    usoLido.push({ ...linha, hora: h });
  }

  const chavesDeLimite = new Set<string>();
  const limitesLidos: LimiteDoLote[] = [];
  for (const [i, linha] of limites.entries()) {
    const h = new Date(linha.hora);
    if (!dentro(h)) return { ok: false, erro: `limites[${i}]: hora fora da janela ou não cheia.` };
    if (!declarados.has(linha.conteiner)) {
      return { ok: false, erro: `limites[${i}]: contêiner ${linha.conteiner} não está em \`conteineres\`.` };
    }
    const chave = [h.getTime(), linha.conteiner, linha.categoria].join("|");
    if (chavesDeLimite.has(chave)) return { ok: false, erro: `limites[${i}]: linha repetida.` };
    chavesDeLimite.add(chave);
    limitesLidos.push({ ...linha, hora: h });
  }

  let cotaLida: CotaDoLote | null = null;
  if (cota) {
    const lidaEm = new Date(Math.floor(new Date(cota.lidaEm).getTime() / MINUTO_MS) * MINUTO_MS);
    if (lidaEm.getTime() > agora.getTime() + 10 * MINUTO_MS) {
      return { ok: false, erro: "cota.lidaEm está no futuro." };
    }
    if (agora.getTime() - lidaEm.getTime() > MAX_DE_IDADE_DA_LEITURA_MS) {
      return { ok: false, erro: "cota.lidaEm tem mais de um dia: leitura velha não entra." };
    }
    const chaves = new Set(cota.janelas.map((j) => j.chave));
    if (chaves.size !== cota.janelas.length) {
      return { ok: false, erro: "cota.janelas tem janela repetida." };
    }
    cotaLida = {
      lidaEm,
      plano: cota.plano?.trim() || null,
      janelas: cota.janelas.map((j) => ({
        chave: j.chave,
        utilizacao: j.utilizacao,
        resetaEm: j.resetaEm ? new Date(j.resetaEm) : null,
      })),
    };
  }

  return {
    ok: true,
    lote: { desde, ate, conteineres, uso: usoLido, limites: limitesLidos, cota: cotaLida },
  };
}

/** O que o coletor vê na tela depois de cada lote. */
export function resumoDoLote(lote: Lote): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
  const cota = lote.cota ? `, cota real de ${lote.cota.janelas.length} janela(s)` : "";
  return `${lote.uso.length} linhas de uso e ${lote.limites.length} de recusa, ${fmt(lote.desde)} a ${fmt(lote.ate)} UTC${cota}`;
}
