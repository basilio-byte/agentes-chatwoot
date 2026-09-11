/**
 * O que um prompt cita que o agente não consegue fazer.
 *
 * Nasceu do CRM de Atendimentos, em 11/09/2026: o prompt, portado do n8n,
 * mandava enviar `custom_fields` e `assignee` — nomes que não existem aqui. O
 * validador descarta chave desconhecida em silêncio, e a tarefa nascia com
 * `criada: true`, zero campos e sem responsável, por semanas. E citava
 * ferramentas ("busque o histórico", "registre a task no Chatwoot") que o
 * catálogo nunca teve.
 *
 * Aqui é conferência mecânica, sem modelo: o que PARECE nome de ferramenta e
 * está no catálogo mas não ligado para o agente, e os nomes de parâmetro que já
 * causaram estrago conhecido. Não pega tudo — pega o que já aconteceu.
 */

/** Nome de ferramenta: minúsculas com pelo menos um `_` (`clickup_criar_tarefa`). */
const PARECE_FERRAMENTA = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * Parâmetros com nome de outro sistema que já foram descartados em silêncio
 * aqui. A chave é o que o prompt escreveu; o valor, o nome real.
 */
export const PARAMETROS_DE_OUTRO_SISTEMA: Record<string, string> = {
  custom_fields: "camposPersonalizados (em clickup_criar_tarefa), com campo e valor",
  assignee: "responsavel (nome ou e-mail)",
  assignees: "responsavel (nome ou e-mail)",
  conversation_id: "nenhum — as ferramentas do Chatwoot usam a conversa do próprio turno",
};

export type CitacoesDoPrompt = {
  /** Citadas e ligadas para este agente. */
  ligadas: string[];
  /** Existem no catálogo, mas NÃO estão ligadas para este agente. */
  naoLigadas: string[];
  /** Nomes de parâmetro de outro sistema, com o nome certo ao lado. */
  parametrosSuspeitos: { citado: string; certo: string }[];
};

export function conferirCitacoes(
  prompt: string,
  catalogo: ReadonlySet<string>,
  efetivas: ReadonlySet<string>,
): CitacoesDoPrompt {
  const citadas = new Set(prompt.match(PARECE_FERRAMENTA) ?? []);

  const ligadas = [...citadas].filter((n) => efetivas.has(n)).sort();
  const naoLigadas = [...citadas]
    .filter((n) => catalogo.has(n) && !efetivas.has(n))
    .sort();

  const parametrosSuspeitos = Object.entries(PARAMETROS_DE_OUTRO_SISTEMA)
    .filter(([citado]) => new RegExp(`\\b${citado}\\b`).test(prompt))
    .map(([citado, certo]) => ({ citado, certo }));

  return { ligadas, naoLigadas, parametrosSuspeitos };
}
