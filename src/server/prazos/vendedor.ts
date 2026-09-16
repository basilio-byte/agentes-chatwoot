/**
 * De quem atende no Chatwoot para a opção do campo `VENDEDOR` do CRM.
 *
 * ⚠ Os dois vocabulários não batem. As opções do dropdown são nomes curtos
 * (Alan, Kelly, Diego, Nathã…), e no Chatwoot a pessoa é "Wellen Kelly" — cuja
 * opção é **"Kelly"**, não "Wellen". Mapear por primeiro nome erraria justamente
 * em quem mais recebe rodízio, e erraria em silêncio: o campo aceitaria o valor
 * errado e a venda apareceria no nome de outra pessoa.
 *
 * Por isso a regra é casar QUALQUER palavra do nome contra as opções e exigir
 * **uma única** correspondência. Nenhuma ou mais de uma não vira palpite: vira
 * recusa, e quem chamou registra o motivo.
 */

/** Palavra curta demais para identificar alguém ("de", "da", "e"). */
const MINIMO_DE_LETRAS = 3;

const normalizar = (texto: string) =>
  texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const palavras = (texto: string) =>
  normalizar(texto)
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= MINIMO_DE_LETRAS);

export function opcaoDoVendedor(
  nomeNoChatwoot: string,
  opcoes: string[],
): { opcao: string } | { erro: string; candidatas?: string[] } {
  const doNome = new Set(palavras(nomeNoChatwoot));
  if (doNome.size === 0) {
    return { erro: `"${nomeNoChatwoot}" não tem nome utilizável para casar com o campo VENDEDOR.` };
  }

  const casadas = opcoes.filter((opcao) =>
    palavras(opcao).some((palavra) => doNome.has(palavra)),
  );
  const distintas = [...new Set(casadas)];

  if (distintas.length === 1) return { opcao: distintas[0] };

  if (distintas.length === 0) {
    return {
      erro: `Nenhuma opção do campo VENDEDOR corresponde a "${nomeNoChatwoot}".`,
      candidatas: opcoes,
    };
  }
  return {
    erro: `"${nomeNoChatwoot}" casa com mais de uma opção do campo VENDEDOR, então não dá para escolher.`,
    candidatas: distintas,
  };
}
