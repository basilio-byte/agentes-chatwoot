import { RunSource } from "@/generated/prisma/enums";
import type { ToolContext } from "../types";

/**
 * Quem está do outro lado da conversa é mesmo o cliente do cadastro?
 *
 * ⚠ Pedido do usuário em 22/09/2026, depois de um caso em que bastou dizer o
 * NOME de um cliente cadastrado para a reserva sair: *"abre brecha pra qualquer
 * pessoa reservar em nome de terceiros"*. O prompt do agente de salas já mandava
 * pedir o CPF ou o CNPJ, e nas execuções o agente sempre pediu — mas instrução
 * o modelo pula, e o que ele pula aqui é gasto na conta de outra pessoa: a
 * reserva desconta do pacote de horas DELA, ou vira cobrança no nome dela.
 *
 * A prova é o documento do cadastro escrito pelo CLIENTE nesta conversa. Só a
 * fala de `user` conta: no histórico do Chatwoot, `user` é o que entrou pelo
 * cliente (`message_type` 0), e o que o robô ou a equipe escreveram é
 * `assistant`. Por isso o agente não consegue "provar" repetindo um documento
 * que ele mesmo leu no ERP — e por isso `conexa_ver_cliente` esconde documento
 * e contato enquanto a prova não existe: senão bastaria o agente contar o CPF
 * cadastrado e o impostor copiá-lo de volta.
 *
 * O que isto NÃO é: autenticação. CPF não é segredo. A trava sobe o custo de se
 * passar por outra pessoa de "saber o nome" para "saber o documento", que é a
 * régua que o usuário escolheu.
 */

export type ExigenciaDeIdentidade =
  /** Quem pede é a equipe ou um sistema da Seahub: não há cliente a provar. */
  | { tipo: "livre" }
  /** Há um cliente na conversa: o documento tem de estar numa fala dele. */
  | { tipo: "provar"; falasDoCliente: string[] }
  /** Turno em segundo plano, sobre uma conversa que outra pessoa conduz. */
  | { tipo: "semCliente" };

/**
 * O que cada origem exige.
 *
 * `switch` sem `default`, como em `tipoDeTurno`: origem nova quebra o typecheck
 * em vez de cair num padrão silencioso.
 */
export function exigenciaDeIdentidade(
  ctx: Pick<ToolContext, "source" | "historico" | "mensagem">,
): ExigenciaDeIdentidade {
  const doHistorico = (ctx.historico ?? [])
    .filter((m) => m.role === "user")
    .map((m) => m.content);

  // Sem origem só acontece fora do runner (que sempre a preenche). Na dúvida,
  // a trava fica fechada.
  if (!ctx.source) {
    return { tipo: "provar", falasDoCliente: [...doHistorico, ctx.mensagem ?? ""] };
  }

  switch (ctx.source) {
    case RunSource.CHATWOOT:
    // O playground existe para prever a produção: trava igual.
    case RunSource.PLAYGROUND:
      return { tipo: "provar", falasDoCliente: [...doHistorico, ctx.mensagem ?? ""] };

    // A chamada interna recebe a conversa de quem a acionou no histórico, e o
    // PEDIDO — escrito por outro modelo — na mensagem. O pedido não prova nada.
    case RunSource.INTERNO:
      return { tipo: "provar", falasDoCliente: doHistorico };

    // Mesa: é uma pessoa da equipe logada no painel. Gatilho e agendamento: um
    // sistema da Seahub. Nenhum dos três tem cliente do outro lado.
    case RunSource.MESA:
    case RunSource.TRIGGER:
    case RunSource.SCHEDULE:
      return { tipo: "livre" };

    // A transcrição chega cercada na mensagem, escrita por cliente, equipe e
    // robô misturados — e nenhum desses turnos tem por que agir em nome do
    // cliente.
    case RunSource.CONVERSA_ENCERRADA:
    case RunSource.CONVERSA_MARCADA:
    case RunSource.CONVERSA_PARADA:
      return { tipo: "semCliente" };
  }
}

/** Só os dígitos. */
export function digitos(texto: string | null | undefined): string {
  return (texto ?? "").replace(/\D/g, "");
}

/**
 * Os números escritos no texto, cada um com a pontuação que se usa ao digitar
 * documento (`.`, `-`, `/` e espaço) já retirada.
 *
 * ⚠ Não é "todos os dígitos da mensagem juntos": "dia 24/09, 14h às 18h, 4
 * pessoas" viraria uma fileira de onze dígitos, e uma coincidência dessas não
 * pode provar identidade. Vírgula, letra e quebra de linha separam números.
 */
export function numerosDoTexto(texto: string): string[] {
  return (texto.match(/\d[\d.\-/ ]*\d|\d/g) ?? []).map(digitos);
}

/**
 * O documento aparece numa fala do cliente?
 *
 * Aceita o número colado a outro na mesma fileira ("CPF 01474010466 84999…",
 * separados só por espaço) e o CPF sem o zero da frente, que o cliente costuma
 * omitir.
 */
export function documentoNasFalas(documento: string, falas: string[]): boolean {
  const doc = digitos(documento);
  // Documento curto demais não prova nada — e evita casar "0" com tudo.
  if (doc.length < 11) return false;
  const semZeros = doc.replace(/^0+/, "");
  const alvos = semZeros.length >= 9 && semZeros !== doc ? [doc, semZeros] : [doc];
  return falas.some((fala) =>
    numerosDoTexto(fala).some((numero) => alvos.some((alvo) => numero.includes(alvo))),
  );
}

export type DocumentosDoCadastro = {
  /** CPF (pessoa física) e/ou CNPJ (empresa) do cliente. */
  doCliente: Array<string | undefined>;
  /** As pessoas vinculadas ao cliente — quem reserva em nome da empresa. */
  pessoas?: Array<{ id: number; cpf?: string }>;
};

export type Prova =
  | { comprovado: true; pessoaId?: number }
  | { comprovado: false };

/**
 * O cliente provou ser do cadastro?
 *
 * Vale o documento do cliente ou o CPF de uma pessoa vinculada a ele: quem
 * reserva pela empresa costuma saber o PRÓPRIO CPF, não o CNPJ. Nesse caso a
 * pessoa comprovada é quem vai usar a sala.
 */
export function provarIdentidade(
  cadastro: DocumentosDoCadastro,
  falas: string[],
): Prova {
  if (cadastro.doCliente.some((doc) => doc && documentoNasFalas(doc, falas))) {
    return { comprovado: true };
  }
  const pessoa = (cadastro.pessoas ?? []).find(
    (p) => p.cpf && documentoNasFalas(p.cpf, falas),
  );
  return pessoa ? { comprovado: true, pessoaId: pessoa.id } : { comprovado: false };
}

/** O que o modelo lê quando a escrita é recusada por falta de prova. */
export const RECUSA_SEM_DOCUMENTO = {
  erro: "O cliente não informou nesta conversa o CPF ou o CNPJ deste cadastro — sem isso, nada é feito em nome dele, nem cobrança dele é mostrada.",
  comoSeguir:
    "Peça ao cliente o CPF (ou o CNPJ da empresa) do cadastro e procure o cliente com conexa_buscar_cliente por esse número. NÃO diga ao cliente o documento, o e-mail ou o telefone cadastrados, nem confirme de quem é um cadastro achado pelo nome. Se ele não souber ou não quiser informar, encaminhe para a equipe.",
};

/** A escrita veio de um turno em segundo plano, que não fala com o cliente. */
export const RECUSA_SEM_CLIENTE = {
  erro: "Esta execução não está conversando com o cliente, e reserva ou cobrança em nome de um cliente só sai do atendimento com ele.",
  comoSeguir: "Não tente de novo por aqui: registre o pedido para a equipe.",
};
