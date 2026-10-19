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
