/**
 * Quem vai usar a sala: a PESSOA vinculada ao cliente que o Conexa exige na
 * reserva.
 *
 * ⚠ A documentação lista `personId` no corpo de `POST /room/booking` sem dizer
 * que é obrigatório, e a ferramenta o tratava como opcional. O Conexa recusa:
 * `400 "Person Id cannot be blank"`. Achado em 21/09/2026 na PRIMEIRA reserva
 * tentada por um agente em produção — o cliente tinha exatamente uma pessoa
 * vinculada, e o agente de salas nem tinha a ferramenta que lista pessoas.
 *
 * Por isso a escolha é do código quando não há o que escolher: uma pessoa
 * ativa só, é ela. Mais de uma, ou uma lista que não veio inteira, não vira
 * palpite — quem usa a sala define o acesso, e a reserva no nome errado é de
 * outra pessoa entrando no prédio.
 */

export type PessoaDoCliente = { id: number; nome?: string; ativa?: boolean };

export type EscolhaDoSolicitante =
  | { tipo: "uma"; id: number }
  | { tipo: "nenhuma" }
  | { tipo: "varias"; opcoes: Array<{ id: number; nome?: string }>; listaCompleta: boolean };

/** Um item de `GET /persons`: o id vem em `personId` ou em `id`. */
export function pessoaDaApi(item: Record<string, unknown>): PessoaDoCliente {
  const id = Number(item.personId ?? item.id);
  const nome = typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined;
  const ativa =
    typeof item.isActive === "boolean"
      ? item.isActive
      : item.isActive === 0 || item.isActive === "0"
        ? false
        : undefined;
  return { id, ...(nome ? { nome } : {}), ...(ativa === undefined ? {} : { ativa }) };
}

/**
 * Pessoa sem a marca de ativa conta como ativa: a listagem pode não trazer o
 * campo, e recusar por falta dele travaria toda reserva.
 */
export function escolherSolicitante(
  pessoas: PessoaDoCliente[],
  listaCompleta: boolean,
): EscolhaDoSolicitante {
  const ativas = pessoas.filter(
    (p) => Number.isInteger(p.id) && p.id > 0 && p.ativa !== false,
  );
  if (ativas.length === 1 && listaCompleta) return { tipo: "uma", id: ativas[0].id };
  if (ativas.length === 0 && listaCompleta) return { tipo: "nenhuma" };
  return {
    tipo: "varias",
    opcoes: ativas.map((p) => ({ id: p.id, ...(p.nome ? { nome: p.nome } : {}) })),
    listaCompleta,
  };
}
