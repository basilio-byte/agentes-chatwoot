/**
 * Resolver de atendente humano: do nome que o agente conhece para o id que a
 * API exige.
 *
 * Puro e testado porque o erro aqui é caro: atribuir a conversa à pessoa errada
 * manda o cliente para quem não sabe do assunto, e ninguém percebe até o
 * atendimento travar.
 */

import { ausenciaVigente, type OpcoesDeAusencia } from "./ausencias";

export type Atendente = {
  id: number;
  name?: string;
  email?: string;
  availability_status?: string;
};

/** Tira acento e caixa, para casar "italo" com "Ítalo". */
function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export type ResultadoAtendente =
  | {
      tipo: "achado";
      atendente: Atendente;
      /**
       * Nome de quem foi pedido e está ausente: a conversa foi para
       * `atendente`, que o substitui (ver `ausencias.ts`).
       */
      substituiuA?: string;
    }
  | { tipo: "ambiguo"; candidatos: string[] }
  | { tipo: "nenhum"; disponiveis: string[] };

/**
 * Casa por id, e-mail, nome inteiro e primeiro nome — nessa ordem.
 *
 * Devolve ambiguidade em vez de escolher: com dois "Ana" na equipe, chutar
 * significa metade das conversas indo para a pessoa errada.
 *
 * Com `opcoes`, quem está ausente (e dentro da data) é trocado pelo substituto
 * — uma troca só, sem encadear. ⚠ Na dúvida mantém quem foi pedido: substituto
 * que não existe ou é ambíguo não pode virar conversa sem dono.
 */
export function resolverAtendente(
  termo: string,
  atendentes: Atendente[],
  opcoes?: OpcoesDeAusencia,
): ResultadoAtendente {
  const pedido = resolverSemAusencia(termo, atendentes);
  if (!opcoes || pedido.tipo !== "achado") return pedido;

  for (const ausencia of opcoes.ausencias) {
    if (!ausenciaVigente(ausencia, opcoes.hoje)) continue;

    const ausente = resolverSemAusencia(ausencia.nome, atendentes);
    if (ausente.tipo !== "achado" || ausente.atendente.id !== pedido.atendente.id) continue;

    const substituto = resolverSemAusencia(ausencia.substituto, atendentes);
    if (substituto.tipo !== "achado" || substituto.atendente.id === pedido.atendente.id) {
      return pedido;
    }
    return {
      tipo: "achado",
      atendente: substituto.atendente,
      substituiuA: pedido.atendente.name?.trim() || ausencia.nome,
    };
  }
  return pedido;
}

function resolverSemAusencia(
  termo: string,
  atendentes: Atendente[],
): ResultadoAtendente {
  const nomes = atendentes.map((a) => a.name ?? a.email ?? String(a.id));
  const alvo = normalizar(termo);
  if (!alvo) return { tipo: "nenhum", disponiveis: nomes };

  const porId = atendentes.find((a) => String(a.id) === termo.trim());
  if (porId) return { tipo: "achado", atendente: porId };

  const porEmail = atendentes.filter(
    (a) => normalizar(a.email ?? "") === alvo,
  );
  if (porEmail.length === 1) {
    return { tipo: "achado", atendente: porEmail[0] };
  }

  const exatos = atendentes.filter((a) => normalizar(a.name ?? "") === alvo);
  if (exatos.length === 1) return { tipo: "achado", atendente: exatos[0] };
  if (exatos.length > 1) {
    return { tipo: "ambiguo", candidatos: exatos.map((a) => a.name ?? "") };
  }

  // Primeiro nome: o prompt diz "Arthur", o cadastro diz "Arthur Menezes".
  const porPrimeiroNome = atendentes.filter(
    (a) => normalizar(a.name ?? "").split(" ")[0] === alvo,
  );
  if (porPrimeiroNome.length === 1) {
    return { tipo: "achado", atendente: porPrimeiroNome[0] };
  }
  if (porPrimeiroNome.length > 1) {
    return {
      tipo: "ambiguo",
      candidatos: porPrimeiroNome.map((a) => a.name ?? ""),
    };
  }

  return { tipo: "nenhum", disponiveis: nomes };
}
