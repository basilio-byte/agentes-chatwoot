/**
 * Quem é o próximo do rodízio.
 *
 * Puro para ser testável sem banco: é a regra que decide quem recebe o próximo
 * cliente, e errar aqui concentra atendimento em uma pessoa sem ninguém notar.
 */

/** Compara ignorando acento e caixa — o prompt escreve "italo", o cadastro "Ítalo". */
function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * O seguinte na lista depois de `ultimo`, circular.
 *
 * Sem registro anterior, ou com um registro que saiu da lista, começa do
 * primeiro — trocar os participantes não pode travar o rodízio.
 */
export function proximoDoRodizio(
  participantes: string[],
  ultimo: string | null | undefined,
): string | null {
  const limpos = participantes.map((p) => p.trim()).filter(Boolean);
  if (limpos.length === 0) return null;
  if (!ultimo) return limpos[0];

  const alvo = normalizar(ultimo);
  const indice = limpos.findIndex((p) => normalizar(p) === alvo);
  if (indice < 0) return limpos[0];

  return limpos[(indice + 1) % limpos.length];
}
