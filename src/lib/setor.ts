/**
 * Setor: a área da Seahub a que um agente (ou um documento de apoio) pertence.
 *
 * Texto livre, de propósito — quem decide se existe "Comercial" ou "Vendas" é a
 * equipe, sem pedir deploy. O preço da liberdade é a grafia: "comercial",
 * "Comercial " e "COMERCIAL" são o mesmo setor para quem lê e três para o
 * filtro. Por isso a gravação RECONCILIA com a grafia que já existe, e a lista
 * de opções junta o que escapou — o filtro nunca mostra duas vezes a mesma área.
 *
 * Puro e testado. Serve às telas (cliente e servidor) e às ações.
 */

export const LIMITE_DO_SETOR = 40;

/** O valor do filtro, na URL, que quer dizer "agentes sem setor definido". */
export const SEM_SETOR = "sem-setor";

type Valor = string | null | undefined;

/** Tira as pontas e junta os espaços repetidos. Não-texto vira vazio. */
export function limparSetor(bruto: unknown): string {
  if (typeof bruto !== "string") return "";
  return bruto.replace(/\s+/g, " ").trim();
}

/** Com o que dois setores se comparam: sem caixa, sem acento, sem espaço sobrando. */
export function chaveDoSetor(setor: string): string {
  return limparSetor(setor)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * O setor a gravar. Vazio vira `null`; um setor que já existe com outra caixa ou
 * acento reaproveita a grafia que existe — a primeira que alguém escolheu vence.
 */
export function reconciliarSetor(
  bruto: unknown,
  existentes: readonly Valor[],
): string | null {
  const limpo = limparSetor(bruto);
  if (!limpo) return null;

  const chave = chaveDoSetor(limpo);
  const igual = existentes.find(
    (e) => typeof e === "string" && e.trim() && chaveDoSetor(e) === chave,
  );
  return igual ? limparSetor(igual) : limpo;
}

/**
 * As opções do filtro: cada setor uma vez, em ordem alfabética.
 *
 * Quando a mesma área aparece com duas grafias (linha gravada antes da
 * reconciliação, ou à mão no banco), vale a que tem mais uso — e, no empate, a
 * primeira em ordem alfabética, para a lista não mudar de um carregamento para
 * outro.
 */
export function listarSetores(valores: readonly Valor[]): string[] {
  const porChave = new Map<string, Map<string, number>>();

  for (const valor of valores) {
    if (typeof valor !== "string") continue;
    const limpo = limparSetor(valor);
    if (!limpo) continue;

    const chave = chaveDoSetor(limpo);
    const grafias = porChave.get(chave) ?? new Map<string, number>();
    grafias.set(limpo, (grafias.get(limpo) ?? 0) + 1);
    porChave.set(chave, grafias);
  }

  return [...porChave.values()]
    .map((grafias) => {
      const [escolhida] = [...grafias.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"),
      );
      return escolhida[0];
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
}

/** O setor de uma linha bate com o filtro da URL? */
export function bateComOFiltro(
  setor: Valor,
  filtro: string | null | undefined,
): boolean {
  if (!filtro) return true;
  const limpo = typeof setor === "string" ? limparSetor(setor) : "";
  if (filtro === SEM_SETOR) return limpo === "";
  return limpo !== "" && chaveDoSetor(limpo) === chaveDoSetor(filtro);
}
