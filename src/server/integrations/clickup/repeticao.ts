/**
 * Task em dobro na mesma conversa: a regra pura de `clickup_criar_tarefa`.
 *
 * Nasceu da conversa 14454 (04 e 05/10/2026). A venda fechada pelo agente no
 * sábado virou TRÊS tasks no CRM Comercial: o agente criou uma, o cliente
 * respondeu "Sim" a uma mensagem de retomada e ele criou outra — o histórico
 * que o modelo recebe é texto puro e não mostra o que ele já fez —, e na
 * segunda-feira o checkbox acionou o CRM, que procurou pelo telefone, não achou
 * (as duas tinham nascido sem o campo CELULAR) e criou a terceira. Task em
 * dobro no CRM é vendedor, cobrança e contrato em dobro.
 *
 * O prompt pedia para conferir antes de criar, e o modelo não conferiu. Por
 * isso a regra é do sistema: a ferramenta lê as próprias execuções desta
 * conversa, sem modelo, como o checkbox já fazia desde 15/09.
 */

/**
 * Por quanto tempo uma task criada nesta conversa barra outra na mesma lista.
 *
 * Sete dias, e não um: no caso que motivou, entre a venda de sábado e o
 * checkbox de segunda passaram 43 horas. No WhatsApp a conversa do Chatwoot
 * dura meses, e a oportunidade nova de um mês depois tem de poder nascer.
 */
export const DIAS_SEM_REPETIR = 7;

export type TarefaAnterior = {
  id: string;
  url: string | null;
  nome: string | null;
  em: Date;
};

/**
 * As tasks que `clickup_criar_tarefa` criou NESTA lista, da mais recente para a
 * mais antiga, a partir das chamadas gravadas.
 *
 * Só conta `criada: true` — recusa, erro e esta própria barreira não criaram
 * nada. E só conta quem gravou `listaId`: o retorno passou a trazê-lo em
 * 05/10/2026, e comparar pelo nome da lista confundiria duas listas de mesmo
 * nome em pastas diferentes.
 */
export function tarefasNaLista(
  chamadas: { output: unknown; createdAt: Date }[],
  listaId: string,
): TarefaAnterior[] {
  const vistas = new Set<string>();
  return [...chamadas]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .flatMap((chamada) => {
      const saida = chamada.output;
      if (typeof saida !== "object" || saida === null || Array.isArray(saida)) return [];

      const { criada, id, url, nome, listaId: daChamada } = saida as Record<string, unknown>;
      if (criada !== true || typeof id !== "string" || daChamada !== listaId) return [];
      if (vistas.has(id)) return [];
      vistas.add(id);

      return [
        {
          id,
          url: typeof url === "string" ? url : null,
          nome: typeof nome === "string" ? nome : null,
          em: chamada.createdAt,
        },
      ];
    });
}

/**
 * A etiqueta do CRM que marca a venda GANHA. Quem já fechou uma reserva volta a
 * pedir outra pela mesma conversa de WhatsApp: é oportunidade nova, não duplicata.
 */
export const ETIQUETA_DE_VENDA_GANHA = "ganho";

/**
 * Uma task que existiu e não vale mais não barra a nova: apagada (404),
 * arquivada, fechada (perdida, concluída) ou GANHA. Barrar por ela deixaria a
 * equipe sem conseguir registrar a oportunidade por uma semana.
 *
 * ⚠ Ganha NÃO é o mesmo que "ainda em andamento": a duplicata que esta barreira
 * existe para impedir nasce com a primeira task ainda aberta (um lead, uma venda
 * autônoma recém-registrada); a segunda reserva de quem já pagou é outro negócio.
 * Conversa 14342 (05/10/2026): a cliente avulsa reservava toda semana pela mesma
 * conversa, a task anterior estava "ganho", e a equipe tinha de subir a nova à mão.
 */
export function aindaVale(tarefa: {
  archived?: boolean | null;
  status?: { type?: string | null } | null;
  tags?: Array<{ name?: string | null }> | null;
}): boolean {
  if (tarefa.archived) return false;
  if (tarefa.status?.type === "closed") return false;
  const ganha = (tarefa.tags ?? []).some(
    (t) => (t.name ?? "").trim().toLowerCase() === ETIQUETA_DE_VENDA_GANHA,
  );
  return !ganha;
}
