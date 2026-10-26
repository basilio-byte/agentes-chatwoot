import { z } from "zod";
import { RESET_PADRAO, type Reset } from "./ciclo";

/**
 * Os contêineres (um OpenClaw por pessoa) que o painel conhece.
 *
 * O nome da pessoa mora AQUI, no banco, editado na tela — nunca no código. Quem
 * aparece é o que o coletor encontrou no servidor: um contêiner novo entra na
 * lista sozinho, sem nome, e a pessoa que cuida do painel o nomeia.
 */
export const ID_DE_CONTEINER = /^[a-z0-9]{2,16}$/;

const conteinerSchema = z.object({
  id: z.string().regex(ID_DE_CONTEINER),
  nome: z.string().trim().max(60).nullable().default(null),
  /**
   * Gasta da MESMA conta Claude que os outros? Medido em 26/10/2026: o OpenClaw
   * do Guilherme seguiu respondendo enquanto os outros levavam 429, então ele
   * está noutra credencial. Aparece na tela, mas não entra na cota dos demais
   * nem na detecção de bloqueio.
   */
  compartilhada: z.boolean().default(true),
});

export type ConteinerConfigurado = z.infer<typeof conteinerSchema>;

/** Lista inválida ou ausente vira vazia: a tela continua abrindo. */
export function lerConteineres(bruto: unknown): ConteinerConfigurado[] {
  const lista = z.array(conteinerSchema).safeParse(bruto);
  if (!lista.success) return [];
  // Id repetido vale pela primeira ocorrência.
  const vistos = new Set<string>();
  const unicos: ConteinerConfigurado[] = [];
  for (const c of lista.data) {
    if (vistos.has(c.id)) continue;
    vistos.add(c.id);
    unicos.push(c);
  }
  return unicos;
}

export function nomeDoConteiner(
  id: string,
  conteineres: readonly ConteinerConfigurado[],
): string {
  const nome = conteineres.find((c) => c.id === id)?.nome?.trim();
  return nome ? nome : `OpenClaw ${id}`;
}

/**
 * Os ids que gastam da conta compartilhada. Contêiner desconhecido conta como
 * compartilhado: errar para esse lado superestima o consumo da conta, e errar
 * para o outro esconderia um bloqueio.
 */
export function idsDaContaCompartilhada(
  conteineres: readonly ConteinerConfigurado[],
  idsConhecidos: Iterable<string>,
): Set<string> {
  const fora = new Set(
    conteineres.filter((c) => !c.compartilhada).map((c) => c.id),
  );
  return new Set([...idsConhecidos].filter((id) => !fora.has(id)));
}

/** Acrescenta à lista os ids que ela ainda não tem, sem mexer nos que já tem. */
export function mesclarConteineres(
  atuais: readonly ConteinerConfigurado[],
  ids: readonly string[],
): ConteinerConfigurado[] {
  const lista = [...atuais];
  for (const id of ids) {
    if (!lista.some((c) => c.id === id)) {
      lista.push({ id, nome: null, compartilhada: true });
    }
  }
  return lista;
}

export function resetValido(dia: unknown, hora: unknown): Reset {
  const d = Number(dia);
  const h = Number(hora);
  return Number.isInteger(d) && d >= 0 && d <= 6 && Number.isInteger(h) && h >= 0 && h <= 23
    ? { diaSemana: d, horaUtc: h }
    : RESET_PADRAO;
}

export const NOMES_DOS_DIAS = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
] as const;
