import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { formatarCliente } from "@/server/integrations/conexa/formatacao";
import { abrirConexa } from "@/server/integrations/conexa/sistema";
import { lerEmail } from "@/server/email-do-contato/regras";
import type { FatosDoCliente } from "./regras";

/**
 * O que o sistema já sabe do cliente desta conversa, sem perguntar ao modelo.
 *
 * - **O cliente do Conexa é o que um agente JÁ usou nesta conversa**, lido das
 *   `ToolCall` (`clienteId` na entrada, ou na saída de criar cliente e de criar
 *   reserva) — nunca procurado por nome nem telefone, que acharia outra pessoa.
 * - **A sala é a que o Conexa gravou** na última reserva, não a que se pediu.
 * - Nunca lança: sem fatos, o resto do cadastro segue com o que tem.
 */
export async function fatosDoClienteDaConversa(
  conversationId: string | undefined,
): Promise<FatosDoCliente> {
  const fatos: FatosDoCliente = {};
  if (!conversationId) return fatos;

  try {
    const chamadas = await db.toolCall.findMany({
      where: {
        toolName: { startsWith: "conexa_" },
        isError: false,
        run: { conversationId },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { toolName: true, input: true, output: true },
    });

    let clienteId: number | undefined;
    for (const c of chamadas) {
      clienteId ??= clienteDaChamada(c.input, c.output);
      if (!fatos.sala && c.toolName === "conexa_criar_reserva") {
        const reserva = (c.output as { reserva?: { sala?: unknown } } | null)?.reserva;
        if (typeof reserva?.sala === "string" && reserva.sala.trim()) fatos.sala = reserva.sala.trim();
      }
    }
    if (!clienteId) return fatos;

    const conexa = await abrirConexa("cadastro");
    if ("erro" in conexa) return fatos;

    const cliente = formatarCliente(await conexa.cliente.obterCliente(clienteId));
    if (cliente.nome) fatos.nome = cliente.nome;
    if (cliente.cpf) fatos.cpf = cliente.cpf.replace(/\D/g, "");
    if (cliente.cnpj) fatos.cnpj = cliente.cnpj.replace(/\D/g, "");
    if (cliente.celular) fatos.celular = cliente.celular;

    for (const e of cliente.emails ?? []) {
      const lido = lerEmail(String(e));
      if (lido.tipo === "um") {
        fatos.email = lido.email;
        break;
      }
    }
  } catch (erro) {
    logger.warn(
      { erro: erro instanceof Error ? erro.message.slice(0, 200) : String(erro) },
      "cadastro: não li os dados do cliente no Conexa",
    );
  }
  return fatos;
}

function clienteDaChamada(input: unknown, output: unknown): number | undefined {
  const i = (input ?? {}) as { clienteId?: unknown };
  const o = (output ?? {}) as { clienteId?: unknown; reserva?: { cliente?: unknown } };
  for (const v of [i.clienteId, o.clienteId, o.reserva?.cliente]) {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  }
  return undefined;
}
