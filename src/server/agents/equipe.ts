/**
 * Regras da equipe de agentes: quem atende, quem pode receber e como o destino
 * de uma transferência é resolvido.
 *
 * Puras e sem banco de propósito — são a diferença entre o cliente falar com o
 * especialista certo e a conversa cair no agente errado, então precisam de
 * teste direto.
 */

export type MembroDaEquipe = {
  id: string;
  key: string;
  name: string;
  routingDescription?: string | null;
};

export type AgenteRoteavel = MembroDaEquipe & {
  active: boolean;
  isEntry: boolean;
};

/**
 * Quem atende esta mensagem, em ordem de precedência:
 *
 *   1. O dono da conversa — um agente que já assumiu continua com ela.
 *   2. O agente de entrada — o primeiro atendimento determinístico.
 *   3. A porta — o agente do bot que recebeu a mensagem.
 *
 * O passo 3 é o que garante que sempre existe alguém: sem entrada configurada,
 * ou com a entrada desligada, o atendimento continua em vez de virar silêncio.
 */
export function resolverAgenteAtivo(
  equipe: AgenteRoteavel[],
  { donoId, portaId }: { donoId?: string | null; portaId: string },
): AgenteRoteavel | null {
  const ativos = equipe.filter((a) => a.active);

  const dono = donoId ? ativos.find((a) => a.id === donoId) : undefined;
  if (dono) return dono;

  const entrada = ativos.find((a) => a.isEntry);
  if (entrada) return entrada;

  return ativos.find((a) => a.id === portaId) ?? null;
}

/**
 * Colegas que aparecem no prompt de um agente.
 *
 * Só agentes ativos e com descrição de roteamento: sem a descrição, o modelo
 * não tem como decidir se aquele colega serve, e listar um agente "cego" só
 * gasta token e convida a transferência errada.
 */
export function montarRoster(
  equipe: AgenteRoteavel[],
  agenteAtualId: string,
): MembroDaEquipe[] {
  return equipe
    .filter(
      (a) =>
        a.id !== agenteAtualId &&
        a.active &&
        (a.routingDescription ?? "").trim().length > 0,
    )
    .map(({ id, key, name, routingDescription }) => ({
      id,
      key,
      name,
      routingDescription,
    }));
}

/** Bloco de texto que apresenta os colegas ao modelo. */
export function blocoDeRoster(
  roster: MembroDaEquipe[],
  nomeDoAgente: string,
): string {
  if (roster.length === 0) return "";

  const linhas = roster
    .map((a) => `- ${a.key} — ${a.name}: ${a.routingDescription?.trim()}`)
    .join("\n");

  return [
    "",
    "--- COLEGAS PARA QUEM VOCÊ PODE TRANSFERIR ---",
    `Você (${nomeDoAgente}) faz parte de uma equipe de agentes especializados.`,
    "Se o assunto for responsabilidade de um colega abaixo, use a tool",
    "'transferir_para_agente' informando a chave dele.",
    "Quem recebe assume o atendimento por inteiro e continua na hora — então",
    "passe um resumo do que já foi conversado e do que falta.",
    "Transfira só quando fizer sentido, e não devolva para quem acabou de te",
    "passar a conversa sem um motivo novo.",
    "",
    linhas,
  ].join("\n");
}

export type ResultadoDestino =
  | { tipo: "achado"; destino: MembroDaEquipe }
  | { tipo: "nenhum"; chavesValidas: string[] };

/**
 * Resolve o que o modelo escreveu em `destino` para um colega concreto.
 *
 * Aceita chave, id e nome porque o modelo às vezes copia o rótulo em vez da
 * chave. Quando não acha, quem chama devolve as chaves válidas — o modelo se
 * corrige sozinho no mesmo turno em vez de desistir da transferência.
 */
export function resolverDestino(
  termo: string,
  roster: MembroDaEquipe[],
): ResultadoDestino {
  const alvo = termo.trim().toLowerCase();
  const chavesValidas = roster.map((a) => a.key);

  if (!alvo) return { tipo: "nenhum", chavesValidas };

  const achado =
    roster.find((a) => a.key.toLowerCase() === alvo) ??
    roster.find((a) => a.id.toLowerCase() === alvo) ??
    roster.find((a) => a.name.toLowerCase() === alvo);

  return achado
    ? { tipo: "achado", destino: achado }
    : { tipo: "nenhum", chavesValidas };
}

/**
 * Bastão que o agente recebe ao assumir a conversa.
 *
 * Vai como mensagem `system` logo antes da fala do cliente — nunca dentro do
 * systemPrompt, que precisa ficar idêntico entre requisições para o cache do
 * provedor valer.
 */
export function mensagemDeBastao(bastao: {
  deNome?: string | null;
  motivo?: string | null;
  resumo?: string | null;
}): string | null {
  const partes = [
    bastao.deNome ? `Você assumiu este atendimento, que veio de ${bastao.deNome}.` : null,
    bastao.motivo ? `Motivo da transferência: ${bastao.motivo}` : null,
    bastao.resumo ? `Resumo do que já aconteceu: ${bastao.resumo}` : null,
  ].filter(Boolean);

  if (partes.length === 0) return null;

  return [
    ...partes,
    "O cliente já foi avisado da transferência. Continue de onde parou: não se",
    "reapresente, não repita o que já foi perguntado e não peça de novo o que já foi informado.",
  ].join("\n");
}
