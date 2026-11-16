import { after, NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { configDaRenovacao } from "@/server/renovacao/config";
import { lerPedidoDasDatas } from "@/server/renovacao/datas";
import { processarDatas } from "@/server/renovacao/datas-processar";
import { tokenDoEnderecoConfere } from "@/server/boas-vindas/regras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * O endereço que a automação 8 do ClickUp ("Atualizar datas renovação - N8N")
 * chama quando uma tarefa de renovação passa para um status de continuidade. É o
 * que o fluxo do n8n atende hoje — ver `renovacao/datas.ts`.
 *
 * Token no caminho, como no gatilho HTTP, no aviso do Conexa e na macro de
 * boas-vindas: o ClickUp não assina o corpo nem deixa pôr cabeçalho em
 * automação, só a URL é configurável.
 *
 * ⚠ **A chamada NÃO é fonte confiável de nada além do id da tarefa.** Quem
 * descobrir o endereço manda o que quiser: o status, o cliente e os contratos
 * vêm do ClickUp e do Conexa AO VIVO, e as duas datas da URL só valem como "o
 * valor de antes". O pior que uma chamada forjada faz é pedir para avançar as
 * datas de uma tarefa que já está num status de continuidade — e o freio por
 * tarefa e a reserva por data seguram a repetição.
 *
 * Responde `200` na hora e trabalha depois (`after`): o ClickUp trata resposta
 * lenta como falha e reenvia. Só `401` e `404` são erro de protocolo.
 */
async function entrar(req: Request, token: string, corpoCru: string) {
  const config = await configDaRenovacao();
  if (!config.tokenHash) {
    return NextResponse.json({ erro: "O endereço das datas da renovação não foi gerado." }, { status: 404 });
  }
  if (!tokenDoEnderecoConfere(token, config.tokenHash)) {
    logger.warn("datas da renovação rejeitadas — token não confere");
    return NextResponse.json({ erro: "Token inválido." }, { status: 401 });
  }

  const url = new URL(req.url);
  const query = Object.fromEntries(url.searchParams.entries());
  let corpo: unknown = null;
  try {
    corpo = corpoCru ? JSON.parse(corpoCru) : null;
  } catch {
    corpo = null;
  }
  const pedido = lerPedidoDasDatas(query, corpo);

  after(async () => {
    try {
      const desfecho = await processarDatas(pedido);
      logger.info({ resultado: desfecho.resultado, tarefa: pedido.tarefaId }, "datas da renovação processadas");
    } catch (erro) {
      logger.error({ erro, tarefa: pedido.tarefaId }, "datas da renovação: erro inesperado");
    }
  });
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return entrar(req, token, await req.text());
}

/** Conferência de setup: abrir o endereço no navegador diz se o token está certo. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const config = await configDaRenovacao();
  if (!config.tokenHash || !tokenDoEnderecoConfere(token, config.tokenHash)) {
    return NextResponse.json({ erro: "Token inválido." }, { status: config.tokenHash ? 401 : 404 });
  }
  return NextResponse.json({ ok: true, configurado: true, modo: config.avancarDatas });
}
