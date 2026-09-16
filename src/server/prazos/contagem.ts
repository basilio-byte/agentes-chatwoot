import { PrazoStatus } from "@/generated/prisma/enums";

/**
 * Quantas vezes cada pessoa deixou um prazo da equipe vencer.
 *
 * Pedido do usuário em 16/09/2026, junto com a passagem da task do CRM: *"um
 * contador de troca, somando quantas vezes um atendente perdeu o prazo"*, com
 * duas condições — mora no NOSSO sistema, nunca como nota privada na conversa,
 * e só o papel Proprietário enxerga.
 *
 * ⚠ **Nota privada era o lugar errado por construção.** A nota fica na
 * conversa: para somar, alguém teria de abrir as conversas uma a uma, e o
 * número apareceria para a equipe inteira dentro do atendimento — inclusive
 * para quem está sendo contado. Aqui o dado já existe em `PrazoDeConversa`,
 * gravado a cada vencimento; esta tela só o lê.
 *
 * Módulo puro: recebe as linhas e devolve a contagem. Quem consulta o banco é a
 * página.
 *
 * ⚠ **Só `EXECUTADO` conta como falta confirmada.** É o único estado em que o
 * vigia leu o Chatwoot ao vivo e concluiu que ninguém da equipe tinha escrito:
 * `CANCELADO` quer dizer justamente que alguém respondeu, e `DESCARTADO` que o
 * sistema não chegou a conferir. `FALHOU` é o caso que mais tenta: pode ser uma
 * falta de verdade cuja troca deu errado, mas também pode ser o prazo morrendo
 * antes da conferência (formato inesperado, Chatwoot fora do ar) — e o registro
 * não distingue os dois. Somar os dois casos no nome de uma pessoa seria
 * transformar falha nossa em falta dela, então eles saem em bloco à parte, sem
 * dono.
 */

/** O que o vigia fez quando o prazo venceu. */
export type Desfecho = "reatribuida" | "devolvida";

export const ROTULO_DO_DESFECHO: Record<Desfecho, string> = {
  reatribuida: "Passou para outra pessoa",
  devolvida: "Voltou para o agente",
};

/** Só os campos que a contagem lê de `PrazoDeConversa`. */
export type LinhaDePrazo = {
  donoId: number | null;
  donoNome: string | null;
  status: PrazoStatus;
  /** `AcaoDoPrazo` como veio do Json. */
  acao: unknown;
  resultado: string | null;
  minutos: number;
  chatwootConversationId: number;
  criadoEm: Date;
  finalizadoEm: Date | null;
};

export type Ocorrencia = {
  conversa: number;
  quando: Date;
  desfecho: Desfecho | null;
  minutos: number;
};

export type ContagemDePessoa = {
  /** Estável entre linhas da mesma pessoa. Não é para ser exibida. */
  chave: string;
  nome: string;
  total: number;
  reatribuidas: number;
  devolvidas: number;
  /** A mais recente, para a tela poder linkar a conversa. */
  ultima: Ocorrencia | null;
};

export type ForaDaConta = {
  conversa: number;
  quando: Date;
  status: PrazoStatus;
  quem: string | null;
  motivo: string | null;
};

export type Contagem = {
  pessoas: ContagemDePessoa[];
  /** Soma das faltas confirmadas. */
  total: number;
  /** Vencimentos que não viraram falta de ninguém, e por quê. */
  foraDaConta: ForaDaConta[];
};

const normalizar = (texto: string) =>
  texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

/**
 * O que aconteceu no vencimento, lido do Json da ação.
 *
 * Devolve `null` para ação que este código não conhece — a linha continua
 * contando como falta (o vigia executou), só não entra em nenhuma das duas
 * colunas. Chutar uma coluna seria pior: a tela afirmaria um desfecho que não
 * leu.
 */
export function desfechoDaAcao(acao: unknown): Desfecho | null {
  const tipo = (acao as { tipo?: unknown } | null)?.tipo;
  if (tipo === "reatribuir") return "reatribuida";
  if (tipo === "voltar_para_o_agente") return "devolvida";
  return null;
}

/** Quando o prazo terminou. Sem `finalizadoEm`, vale quando ele nasceu. */
const instante = (linha: LinhaDePrazo) => linha.finalizadoEm ?? linha.criadoEm;

export function contarPrazosPerdidos(linhas: LinhaDePrazo[]): Contagem {
  // ⚠ Uma passada só para o nome: `donoNome` fica nulo quando quem atendia não
  // estava na lista de atendentes lida naquele instante, e a MESMA pessoa
  // apareceria como "atendente #7" numa linha e pelo nome na outra — duas
  // pessoas na tela, metade da conta em cada uma.
  const nomePorId = new Map<number, string>();
  for (const linha of linhas) {
    const nome = linha.donoNome?.trim();
    if (linha.donoId != null && nome) nomePorId.set(linha.donoId, nome);
  }

  const porPessoa = new Map<string, ContagemDePessoa>();
  const foraDaConta: ForaDaConta[] = [];

  for (const linha of linhas) {
    const nome = linha.donoNome?.trim() || null;

    if (linha.status !== PrazoStatus.EXECUTADO) {
      foraDaConta.push({
        conversa: linha.chatwootConversationId,
        quando: instante(linha),
        status: linha.status,
        quem: linha.donoId != null ? (nomePorId.get(linha.donoId) ?? nome) : nome,
        motivo: linha.resultado,
      });
      continue;
    }

    const chave =
      linha.donoId != null
        ? `id:${linha.donoId}`
        : nome
          ? `nome:${normalizar(nome)}`
          : "sem-dono";

    const pessoa =
      porPessoa.get(chave) ??
      ({
        chave,
        nome:
          (linha.donoId != null ? nomePorId.get(linha.donoId) : null) ??
          nome ??
          (linha.donoId != null
            ? `Atendente #${linha.donoId}`
            : "Sem dono registrado"),
        total: 0,
        reatribuidas: 0,
        devolvidas: 0,
        ultima: null,
      } satisfies ContagemDePessoa);

    const desfecho = desfechoDaAcao(linha.acao);
    pessoa.total += 1;
    if (desfecho === "reatribuida") pessoa.reatribuidas += 1;
    if (desfecho === "devolvida") pessoa.devolvidas += 1;

    const quando = instante(linha);
    if (!pessoa.ultima || quando > pessoa.ultima.quando) {
      pessoa.ultima = {
        conversa: linha.chatwootConversationId,
        quando,
        desfecho,
        minutos: linha.minutos,
      };
    }

    porPessoa.set(chave, pessoa);
  }

  const pessoas = [...porPessoa.values()].sort(
    (a, b) => b.total - a.total || a.nome.localeCompare(b.nome, "pt-BR"),
  );

  foraDaConta.sort((a, b) => b.quando.getTime() - a.quando.getTime());

  return {
    pessoas,
    total: pessoas.reduce((soma, p) => soma + p.total, 0),
    foraDaConta,
  };
}
