import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { podeEditar } from "@/server/auth-guard";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { capacidadeDeMidia } from "@/server/integrations/openai/credenciais";
import { criarClienteOpenAI } from "@/server/integrations/openai/client";
import { lerArquivoEnviado } from "@/server/integrations/openai/upload";
import { consumirFreio, motivoEmPortugues } from "@/server/mesa/freio";

export const runtime = "nodejs";

/**
 * Passo 1 da mesa: o arquivo vira texto, e nada mais acontece.
 *
 * ⚠ **Route handler, e não server action**, por três motivos que só aparecem em
 * produção. (1) Server action tem teto de 1 MB de corpo, e `next.config` não
 * mexe nisso — a foto de um documento passa disso sem esforço. (2) Server action
 * carrega um id que **caduca no deploy**, e esta é uma página feita para ficar
 * aberta em outra guia: a pessoa voltaria à aba depois do almoço e receberia o
 * erro de ação desconhecida, que já mordeu este projeto em 04/09/2026. (3) O
 * `proxy.ts` não intercepta `/api`, então o corpo chega inteiro.
 *
 * Separado da execução de propósito: quem envia LÊ o texto extraído antes de
 * decidir gastar o turno. É a única defesa visível contra um documento que
 * tente dar ordens ao agente — o ataque aparece escrito na tela.
 */
export async function POST(req: Request) {
  const sessao = await auth();
  if (!sessao?.user) {
    return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });
  }

  // Mesmo critério do playground: ler um arquivo chama a OpenAI e a OpenAI
  // cobra. "Leitura" que gasta crédito contradiz o nome do papel, e a tela de
  // Usuários promete o contrário em letras claras.
  if (!podeEditar(sessao.user.role)) {
    return NextResponse.json(
      { erro: "Seu papel é de leitura — ler um arquivo aqui gasta crédito." },
      { status: 403 },
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ erro: "Requisição inválida." }, { status: 400 });
  }

  const agentId = String(form.get("agentId") ?? "");
  const arquivo = form.get("arquivo");

  if (!agentId) {
    return NextResponse.json({ erro: "Requisição sem agente." }, { status: 400 });
  }
  if (!(arquivo instanceof File) || arquivo.size === 0) {
    return NextResponse.json(
      { erro: "Escolha um arquivo para ler." },
      { status: 400 },
    );
  }

  const freio = await consumirFreio("leitura", sessao.user.id);
  if (!freio.pode) {
    return NextResponse.json(
      {
        erro: motivoEmPortugues(freio, "leitura"),
        esperaSegundos: freio.esperaSegundos,
      },
      { status: 429 },
    );
  }

  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { id: true, archivedAt: true },
  });
  if (!agente || agente.archivedAt) {
    return NextResponse.json(
      { erro: "Este agente não está mais disponível." },
      { status: 400 },
    );
  }

  // ⚠ A capacidade é conferida por AGENTE, não globalmente: a leitura de mídia
  // tem toggle global E por agente, e o segundo é o que decide aqui. Sem ela,
  // o arquivo não vira texto e a mesa não serve para nada — então isto é 503 e
  // não uma leitura que devolve vazio.
  const capacidade = await capacidadeDeMidia(agente.id);
  if (!capacidade.ligada || !capacidade.apiKey) {
    return NextResponse.json(
      {
        erro: `Não dá para ler arquivo com este agente: ${capacidade.motivo ?? "leitura de mídia indisponível"}.`,
      },
      { status: 503 },
    );
  }

  try {
    const bytes = Buffer.from(await arquivo.arrayBuffer());

    const leitura = await lerArquivoEnviado({
      bytes,
      nome: arquivo.name,
      tamanhoBytes: arquivo.size,
      // `File.type` é o que o navegador declara, e às vezes ele não declara
      // nada — daí o `|| null`, que o tipo exige de propósito.
      mimeType: arquivo.type || null,
      config: capacidade.config,
      cliente: criarClienteOpenAI(capacidade.config, capacidade.apiKey),
      agentId: agente.id,
    });

    return NextResponse.json({
      ok: leitura.texto != null,
      analiseId: leitura.chave,
      nome: leitura.nome,
      kind: leitura.kind,
      texto: leitura.texto,
      motivo: leitura.motivo,
    });
  } catch (erro) {
    // `lerArquivoEnviado` promete não lançar; se lançou, é defeito nosso e não
    // pode virar mensagem crua na tela — pode carregar pedaço de credencial.
    logger.error({ erro, agentId }, "leitura da mesa falhou de forma inesperada");
    return NextResponse.json(
      { erro: "Não consegui ler este arquivo agora. Tente de novo." },
      { status: 500 },
    );
  }
}
