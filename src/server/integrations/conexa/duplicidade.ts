/**
 * O cadastro que já existe com este CPF ou CNPJ na unidade — a trava contra o
 * cliente duplicado.
 *
 * Pedido do Diego (19/10/2026), com o caso 5976/5977. Aconteceu três vezes, e
 * sempre igual: o agente de Salas cadastrava o cliente num turno e, minutos
 * depois, no turno seguinte da MESMA conversa, cadastrava de novo — o histórico
 * que o modelo recebe é texto puro e não mostra o que ele fez. A reserva e a
 * cobrança caíam no segundo cadastro, e o primeiro ficava órfão. A descrição da
 * ferramenta já mandava procurar antes; instrução o modelo pula, então quem
 * confere é o código.
 *
 * - **Só a mesma unidade barra.** Unidade é EMPRESA no Conexa (SEAHUB e
 *   SEATECH): o mesmo cliente nas duas é cadastro legítimo.
 * - **Ativo primeiro**: com dois cadastros já duplicados, o ativo é o que serve.
 */
export type CadastroExistente = { id: number; ativo: boolean };

export function cadastroExistente(
  itens: Array<Record<string, unknown>>,
  companyId: number,
): CadastroExistente | null {
  const daUnidade = itens
    .filter((c) => Number(c.companyId) === companyId)
    .map((c) => ({ id: Number(c.customerId ?? c.id), ativo: c.isActive !== false }))
    .filter((c) => Number.isInteger(c.id) && c.id > 0);
  if (daUnidade.length === 0) return null;
  // O mais antigo entre os ativos: num par já duplicado, é o mesmo critério para
  // toda chamada, e a escolha não muda de um turno para o outro.
  const ordenados = [...daUnidade].sort((a, b) => Number(b.ativo) - Number(a.ativo) || a.id - b.id);
  return ordenados[0];
}

/**
 * O contrato ATIVO que o cliente já tem no mesmo plano — a trava contra o
 * contrato duplicado.
 *
 * ⚠ **Aqui o duplicado não é um cadastro órfão: é uma segunda cobrança
 * recorrente no cliente.** O risco é concreto e já está escrito no prompt dos
 * agentes de contrato: *"Para tentar novamente, atualize o status da task para
 * Onboarding"* — ou seja, a equipe é instruída a repetir o acionamento. Na
 * ZapSign repetir gera um documento a mais, que alguém apaga; no ERP gera
 * faturamento.
 *
 * - **Casa pelo PLANO, não só pelo cliente.** Um cliente legitimamente tem mais
 *   de um contrato (endereço fiscal e sala, duas unidades, dois endereços), e
 *   barrar por cliente impediria a segunda venda de verdade.
 * - **Só ATIVO barra.** Contrato encerrado é história; o cliente que volta
 *   contrata de novo.
 * - **Na dúvida, barra.** Dois contratos do mesmo plano no mesmo cliente podem
 *   existir (dois endereços do mesmo produto), e nesse caso quem cria é uma
 *   pessoa. Recusar custa uma mensagem; cobrar duas vezes custa o cliente.
 */
export type ContratoExistente = { id: number; planoId: number; inicio: string | null };

export function contratoExistente(
  itens: Array<Record<string, unknown>>,
  planId: number,
): ContratoExistente | null {
  const doPlano = itens
    .filter((c) => c.isActive !== false && Number(c.planId) === planId)
    .map((c) => ({
      id: Number(c.contractId ?? c.id),
      planoId: Number(c.planId),
      inicio: typeof c.startDate === "string" ? c.startDate.slice(0, 10) : null,
    }))
    .filter((c) => Number.isInteger(c.id) && c.id > 0);
  if (doPlano.length === 0) return null;

  // O mais antigo: num par já duplicado, é o mesmo critério em toda chamada.
  return [...doPlano].sort((a, b) => a.id - b.id)[0];
}

/**
 * O link da tela de contratos do cliente no Conexa — o mesmo formato que o
 * campo `CONEXA LINK` das tarefas do ClickUp já usa, e que o nosso próprio
 * espelho de contato escreve (`contato/regras.ts`).
 *
 * ⚠ **Montado pelo sistema, nunca pelo modelo.** O link vai para o comentário
 * da task que uma pessoa vai clicar; endereço inventado leva a lugar nenhum e
 * parece certo.
 *
 * `baseUrl` é a da API (`https://x.conexa.app/index.php/api/v2`); o que vale
 * aqui é só a origem.
 */
export function linkDoClienteNoConexa(baseUrl: string, clienteId: number): string | null {
  try {
    const { origin } = new URL(baseUrl);
    return `${origin}/index.php?r=vendaRecorrente/gerenciarContratos&idCliente=${clienteId}`;
  } catch {
    return null;
  }
}
