/**
 * Rolagem "grudada no fim", como a de qualquer chat.
 *
 * A conversa acompanha sozinha enquanto o leitor está no fim, e para de
 * acompanhar no instante em que ele sobe para reler algo. Rolar sempre seria
 * pior do que não rolar nunca: arrancaria o texto da tela no meio da leitura.
 */

/**
 * Folga em pixels para considerar que ainda se está no fim.
 *
 * Não dá para exigir a igualdade exata: rolagem suave, zoom do navegador e
 * arredondamento de subpixel deixam a conta parar alguns pixels antes.
 */
export const MARGEM_DO_FIM = 48;

export type EstadoDaRolagem = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export function estaNoFim(
  { scrollTop, scrollHeight, clientHeight }: EstadoDaRolagem,
  margem = MARGEM_DO_FIM,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= margem;
}
