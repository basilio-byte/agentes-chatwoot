import { PrazoStatus } from "@/generated/prisma/enums";
import { MOTIVO } from "./decisao";

/**
 * O que aconteceu com os prazos da equipe, por pessoa.
 *
 * Pedido do usuário em 16/09/2026, junto com a passagem da task do CRM: *"um
 * contador de troca, somando quantas vezes um atendente perdeu o prazo"*, com
 * duas condições — mora no NOSSO sistema, nunca como nota privada na conversa,
 * e só o papel Proprietário enxerga. E, no mesmo dia, a régua que faltava:
 * *"a proporção mostrando realmente quantas conversas foram vencidas em relação
 * às que foram atendidas"*.
 *
 * ⚠ **Contagem crua mente sobre quem atende mais.** Quem recebe trinta
 * conversas e perde três aparecia pior que quem recebe quatro e perde duas,
 * porque a barra comparava uma pessoa com a outra em números absolutos. O que
 * responde à pergunta é a TAXA, e para ter taxa é preciso um denominador
 * honesto.
 *
 * ⚠ **O denominador é o próprio prazo**, e não "todas as conversas da pessoa" —
 * esse número não existe no sistema. Cada prazo de EQUIPE é exatamente uma
 * entrega: o robô passou a conversa para alguém e o relógio começou a correr.
 * A tela diz isso em letras claras, para ninguém ler "recebeu 14" como o total
 * de atendimentos da pessoa naquele mês.
 *
 * ⚠ **`substituído por um prazo novo` NÃO é desfecho e fica fora de tudo.** É o
 * que faz o prazo zerar a cada resposta (`registrarPrazo`): o agente registra de
 * novo e o anterior cai. Contá-lo como conversa recebida faria UMA entrega com
 * três registros virar quatro na conta da pessoa — e, pior, três delas com
 * desfecho "não perdeu", diluindo a taxa de quem mais tem prazo registrado.
 *
 * Módulo puro: recebe as linhas e devolve a contagem. Quem consulta o banco é a
 * página.
 */

/**
 * O que aconteceu quando o relógio chegou ao fim.
 *
 * `perdeu` e `respondeu` são os dois lados da MESMA conferência ao vivo, e por
 * isso são os únicos que entram na taxa: o vigia leu o Chatwoot e viu que
 * ninguém da equipe tinha escrito, ou viu que alguém escreveu. Os demais são
 * casos em que a pergunta "essa pessoa respondeu?" não chegou a ser respondida.
 */
export type Desfecho =
  | "perdeu"
  | "respondeu"
  | "resolvida"
  | "saiu"
  | "sem_conclusao"
  /** Não é desfecho: não conta nem como entrega. */
  | "substituido";

export const ROTULO_DO_DESFECHO: Record<Desfecho, string> = {
  perdeu: "Deixou vencer",
  respondeu: "Respondeu a tempo",
  resolvida: "Conversa resolvida antes",
  saiu: "Saiu das mãos dela antes",
  sem_conclusao: "Sem conclusão",
  substituido: "Substituído por um prazo novo",
};

/** O que o vigia fez quando o prazo venceu. Só existe para `perdeu`. */
export type Acao = "reatribuida" | "devolvida";

export const ROTULO_DA_ACAO: Record<Acao, string> = {
  reatribuida: "passou adiante",
  devolvida: "voltou ao agente",
};

/** Só os campos que a contagem lê de `PrazoDeConversa`. */
export type LinhaDePrazo = {
  donoId: number | null;
  donoNome: string | null;
  agentId: string;
  status: PrazoStatus;
  /** `AcaoDoPrazo` como veio do Json. */
  acao: unknown;
  resultado: string | null;
  chatwootConversationId: number;
  criadoEm: Date;
  finalizadoEm: Date | null;
};

export type Ocorrencia = {
  conversa: number;
  quando: Date;
  acao: Acao | null;
  /** Para onde foi. Nulo quando voltou ao agente. */
  destino: string | null;
};

export type Placar = {
  /** Entregas com desfecho conhecido ou não — tudo menos `substituido`. */
  recebeu: number;
  perdeu: number;
  respondeu: number;
  resolvida: number;
  saiu: number;
  semConclusao: number;
  /**
   * `perdeu / (perdeu + respondeu)`. **Nulo** quando não houve nenhum dos dois:
   * sem base, a tela escreve "—" em vez de um zero que pareceria elogio.
   */
  taxa: number | null;
};

export type ContagemDePessoa = Placar & {
  /** Estável entre linhas da mesma pessoa. Não é para ser exibida. */
  chave: string;
  nome: string;
  reatribuidas: number;
  devolvidas: number;
  ultimaPerda: Ocorrencia | null;
};

export type ContagemDeAgente = Placar & { agentId: string };

/**
 * Um prazo que a pessoa deixou vencer, com a conversa para abrir.
 *
 * A tabela por pessoa só aponta a ÚLTIMA perda; as outras ficavam contadas e
 * sem caminho até a conversa — e conferir a conversa é o que se faz antes de
 * cobrar alguém pelo número.
 */
export type Perda = Ocorrencia & {
  /** O mesmo nome da linha da pessoa na tabela, para as duas baterem. */
  quem: string;
  agentId: string;
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
  totais: Placar;
  /** Qual agente registrou o prazo: diz em que fluxo a perda se concentra. */
  porAgente: ContagemDeAgente[];
  /** Quem assumiu as conversas perdidas, da mais frequente para a menos. */
  destinos: { nome: string; vezes: number }[];
  devolvidasAoAgente: number;
  conversas: { afetadas: number; maisDeUmaVez: number };
  /** Todas as perdas do período, da mais recente para a mais antiga. */
  perdas: Perda[];
  foraDaConta: ForaDaConta[];
};

const normalizar = (texto: string) =>
  texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/**
 * Em que caixa a linha cai.
 *
 * ⚠ Motivo que este código não conhece vira `sem_conclusao`, nunca `perdeu` nem
 * `respondeu`. É a direção segura da falha: uma frase reescrita em
 * `decisao.ts` some da taxa e aparece no bloco "Fora da conta", em vez de virar
 * falta no nome de alguém.
 */
export function desfechoDaLinha(linha: {
  status: PrazoStatus;
  resultado: string | null;
}): Desfecho {
  if (linha.status === PrazoStatus.EXECUTADO) return "perdeu";
  if (linha.status !== PrazoStatus.CANCELADO) return "sem_conclusao";

  switch (linha.resultado) {
    case MOTIVO.equipeEscreveu:
      return "respondeu";
    case MOTIVO.resolvida:
      return "resolvida";
    case MOTIVO.semDono:
    case MOTIVO.naoEhMaisPessoa:
    case MOTIVO.outraPessoaAssumiu:
      return "saiu";
    case MOTIVO.substituido:
      return "substituido";
    default:
      return "sem_conclusao";
  }
}

/**
 * O que o vigia fez, lido do Json da ação.
 *
 * Devolve `null` para ação que este código não conhece — a linha continua
 * contando como falta (o vigia executou), só não entra em nenhuma das duas
 * caixas. Chutar seria a tela afirmar um desfecho que não leu.
 */
export function acaoDaLinha(acao: unknown): Acao | null {
  const tipo = (acao as { tipo?: unknown } | null)?.tipo;
  if (tipo === "reatribuir") return "reatribuida";
  if (tipo === "voltar_para_o_agente") return "devolvida";
  return null;
}

const destinoDaAcao = (acao: unknown): string | null => {
  const alvo = (acao as { atendente?: unknown } | null)?.atendente;
  return typeof alvo === "string" && alvo.trim() ? alvo.trim() : null;
};

/** Quando o prazo terminou. Sem `finalizadoEm`, vale quando ele nasceu. */
const instante = (linha: LinhaDePrazo) => linha.finalizadoEm ?? linha.criadoEm;

const placarVazio = (): Placar => ({
  recebeu: 0,
  perdeu: 0,
  respondeu: 0,
  resolvida: 0,
  saiu: 0,
  semConclusao: 0,
  taxa: null,
});

function somar(placar: Placar, desfecho: Desfecho) {
  if (desfecho === "substituido") return;
  placar.recebeu += 1;
  if (desfecho === "perdeu") placar.perdeu += 1;
  else if (desfecho === "respondeu") placar.respondeu += 1;
  else if (desfecho === "resolvida") placar.resolvida += 1;
  else if (desfecho === "saiu") placar.saiu += 1;
  else placar.semConclusao += 1;
}

/** A base da taxa: só os dois desfechos que respondem "ela respondeu?". */
export const baseDaTaxa = (placar: Placar) => placar.perdeu + placar.respondeu;

function fecharTaxa(placar: Placar) {
  const base = baseDaTaxa(placar);
  placar.taxa = base > 0 ? placar.perdeu / base : null;
}

export function contarPrazosPerdidos(linhas: LinhaDePrazo[]): Contagem {
  // ⚠ Uma passada só para o nome: `donoNome` fica nulo quando quem atendia não
  // estava na lista de atendentes lida naquele instante, e a MESMA pessoa
  // apareceria como "Atendente #7" numa linha e pelo nome na outra — duas
  // pessoas na tela, metade da conta em cada uma.
  const nomePorId = new Map<number, string>();
  for (const linha of linhas) {
    const nome = linha.donoNome?.trim();
    if (linha.donoId != null && nome) nomePorId.set(linha.donoId, nome);
  }

  const porPessoa = new Map<string, ContagemDePessoa>();
  const porAgente = new Map<string, ContagemDeAgente>();
  const destinos = new Map<string, number>();
  const perdasPorConversa = new Map<number, number>();
  const totais = placarVazio();
  const perdas: Perda[] = [];
  const foraDaConta: ForaDaConta[] = [];
  let devolvidasAoAgente = 0;

  for (const linha of linhas) {
    const desfecho = desfechoDaLinha(linha);
    if (desfecho === "substituido") continue;

    const nomeDaLinha = linha.donoNome?.trim() || null;
    const nome =
      (linha.donoId != null ? nomePorId.get(linha.donoId) : null) ??
      nomeDaLinha ??
      (linha.donoId != null ? `Atendente #${linha.donoId}` : "Sem dono registrado");

    const chave =
      linha.donoId != null
        ? `id:${linha.donoId}`
        : nomeDaLinha
          ? `nome:${normalizar(nomeDaLinha)}`
          : "sem-dono";

    const pessoa =
      porPessoa.get(chave) ??
      ({
        ...placarVazio(),
        chave,
        nome,
        reatribuidas: 0,
        devolvidas: 0,
        ultimaPerda: null,
      } satisfies ContagemDePessoa);
    porPessoa.set(chave, pessoa);

    const agente =
      porAgente.get(linha.agentId) ??
      ({ ...placarVazio(), agentId: linha.agentId } satisfies ContagemDeAgente);
    porAgente.set(linha.agentId, agente);

    somar(pessoa, desfecho);
    somar(agente, desfecho);
    somar(totais, desfecho);

    if (desfecho === "sem_conclusao") {
      foraDaConta.push({
        conversa: linha.chatwootConversationId,
        quando: instante(linha),
        status: linha.status,
        quem: nomeDaLinha ? nome : null,
        motivo: linha.resultado,
      });
    }

    if (desfecho !== "perdeu") continue;

    const acao = acaoDaLinha(linha.acao);
    if (acao === "reatribuida") pessoa.reatribuidas += 1;
    if (acao === "devolvida") {
      pessoa.devolvidas += 1;
      devolvidasAoAgente += 1;
    }

    const destino = acao === "reatribuida" ? destinoDaAcao(linha.acao) : null;
    if (destino) destinos.set(destino, (destinos.get(destino) ?? 0) + 1);

    perdasPorConversa.set(
      linha.chatwootConversationId,
      (perdasPorConversa.get(linha.chatwootConversationId) ?? 0) + 1,
    );

    const ocorrencia: Ocorrencia = {
      conversa: linha.chatwootConversationId,
      quando: instante(linha),
      acao,
      destino,
    };
    perdas.push({ ...ocorrencia, quem: nome, agentId: linha.agentId });
    if (!pessoa.ultimaPerda || ocorrencia.quando > pessoa.ultimaPerda.quando) {
      pessoa.ultimaPerda = ocorrencia;
    }
  }

  for (const pessoa of porPessoa.values()) fecharTaxa(pessoa);
  for (const agente of porAgente.values()) fecharTaxa(agente);
  fecharTaxa(totais);

  // Quem mais perdeu vem primeiro, e só depois a taxa: liderar pela taxa poria
  // "1 de 1 = 100%" acima de quem deixou vencer dez vezes.
  const pessoas = [...porPessoa.values()].sort(
    (a, b) =>
      b.perdeu - a.perdeu ||
      (b.taxa ?? -1) - (a.taxa ?? -1) ||
      a.nome.localeCompare(b.nome, "pt-BR"),
  );

  perdas.sort((a, b) => b.quando.getTime() - a.quando.getTime());
  foraDaConta.sort((a, b) => b.quando.getTime() - a.quando.getTime());

  return {
    pessoas,
    totais,
    porAgente: [...porAgente.values()].sort((a, b) => b.perdeu - a.perdeu),
    destinos: [...destinos.entries()]
      .map(([nome, vezes]) => ({ nome, vezes }))
      .sort((a, b) => b.vezes - a.vezes || a.nome.localeCompare(b.nome, "pt-BR")),
    devolvidasAoAgente,
    conversas: {
      afetadas: perdasPorConversa.size,
      maisDeUmaVez: [...perdasPorConversa.values()].filter((n) => n > 1).length,
    },
    perdas,
    foraDaConta,
  };
}
