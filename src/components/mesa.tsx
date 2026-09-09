"use client";

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  CircleAlert,
  ExternalLink,
  FileText,
  Paperclip,
  Play,
  Trash2,
  X,
} from "lucide-react";

import { Aviso, Badge, Button, Card, Meta, Textarea } from "@/components/ui";
import { cn, formatarDuracao, formatarUsd } from "@/lib/utils";

/**
 * Mesa do agente — dois passos, um envio só.
 *
 * O parente mais próximo é o playground, e boa parte da linguagem visual vem de
 * lá. O que NÃO vem é o histórico: aqui cada execução é única e não existe
 * turno anterior. A separação em dois passos também é de propósito — o operador
 * lê o texto extraído antes de pagar o turno, e é a única defesa **visível**
 * contra um documento que tente dar ordens ao agente: o ataque aparece escrito
 * na tela, em vez de chegar direto ao modelo.
 */

/** O passo 2 aceita no máximo três ids — o limite é do contrato da rota. */
const MAX_ARQUIVOS = 3;

type Estado = "lendo" | "lido" | "recusado";

type Leitura = {
  /** Chave local do cartão. Não é o `analiseId`: o cartão existe antes dele. */
  id: number;
  nome: string;
  tamanhoBytes: number;
  estado: Estado;
  /** Só em `lido`. É isto — e nunca o texto — que volta ao servidor. */
  analiseId?: string;
  kind?: string;
  texto?: string;
  /** Só em `recusado`: a frase que explica por que não deu. */
  motivo?: string;
};

type Resultado = {
  resposta: string;
  runId: string;
  iteracoes: number;
  atingiuLimiteDeIteracoes: boolean;
  custoUsd: number | null;
  latenciaMs: number;
  toolCalls: { toolName: string; isError: boolean; durationMs: number }[];
};

type Falha = { mensagem: string; esperaSegundos?: number };

const ROTULO_DO_KIND: Record<string, string> = {
  IMAGE: "imagem",
  AUDIO: "áudio",
  DOCUMENT: "documento",
  UNSUPPORTED: "não lido",
};

export function Mesa({
  agentId,
  accept,
  podeLerArquivo,
  podeFotografar,
  tamanhoMaximoMb,
  tiposAceitos,
  linkDeExecucoes,
}: {
  agentId: string;
  /** Extensões literais montadas no servidor a partir dos tipos ligados. */
  accept: string;
  /** Falso quando a leitura de mídia está desligada — sobra o campo de texto. */
  podeLerArquivo: boolean;
  podeFotografar: boolean;
  tamanhoMaximoMb: number;
  tiposAceitos: string[];
  linkDeExecucoes: string;
}) {
  const [itens, setItens] = useState<Leitura[]>([]);
  const [pedido, setPedido] = useState("");
  const [executando, setExecutando] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [falha, setFalha] = useState<Falha | null>(null);
  /** Aviso da própria tela (limite de arquivos), separado da falha do servidor. */
  const [recado, setRecado] = useState<string | null>(null);
  const [espera, setEspera] = useState(0);
  const [decorridoMs, setDecorridoMs] = useState(0);
  const [arrastando, setArrastando] = useState(false);

  const proximoId = useRef(1);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  /**
   * `dragenter`/`dragleave` disparam também ao cruzar os filhos da área. Sem
   * contar a profundidade, a moldura pisca a cada elemento que o cursor passa.
   */
  const profundidade = useRef(0);

  const lidos = itens.filter((i) => i.estado === "lido");
  const lendo = itens.some((i) => i.estado === "lendo");
  const podeExecutar =
    !executando && !lendo && espera === 0 && (lidos.length > 0 || pedido.trim().length > 0);

  // Contagem regressiva do freio de gasto. O botão volta sozinho: obrigar a
  // pessoa a adivinhar quando pode tentar de novo é o que faz ela martelar.
  useEffect(() => {
    if (espera <= 0) return;
    const t = setTimeout(() => setEspera((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [espera]);

  /**
   * Cronômetro do turno.
   *
   * A execução leva dezenas de segundos e não há como saber a porcentagem —
   * barra que finge saber seria mentira. O tempo decorrido é honesto: mede o
   * que de fato está acontecendo, e cresce, então a tela nunca parece travada.
   */
  useEffect(() => {
    if (!executando) return;
    // O zero é posto em `executar`, junto do `setExecutando(true)`: zerar aqui
    // seria um `setState` síncrono dentro do efeito, que encadeia renderização.
    const inicio = Date.now();
    const t = setInterval(() => setDecorridoMs(Date.now() - inicio), 500);
    return () => clearInterval(t);
  }, [executando]);

  function atualizar(id: number, mudanca: Partial<Leitura>) {
    setItens((atual) =>
      atual.map((i) => (i.id === id ? { ...i, ...mudanca } : i)),
    );
  }

  async function receber(arquivos: File[]) {
    if (arquivos.length === 0) return;
    setRecado(null);
    setFalha(null);

    // Integração ligada, mas os três tipos desmarcados na configuração: subir
    // qualquer coisa só renderia "tipo de mídia desligado" depois do upload.
    if (tiposAceitos.length === 0) {
      setRecado(
        "Nenhum tipo de arquivo está ligado na configuração de leitura de mídia — imagem, áudio e documento estão os três desmarcados. Enquanto isso não mudar, só o campo de texto funciona.",
      );
      return;
    }

    const vagas = MAX_ARQUIVOS - itens.length;
    if (vagas <= 0) {
      setRecado(
        `A mesa trabalha com no máximo ${MAX_ARQUIVOS} arquivos por execução. Tire um da lista para colocar outro.`,
      );
      return;
    }
    if (arquivos.length > vagas) {
      setRecado(
        `Só cabem mais ${vagas} ${vagas === 1 ? "arquivo" : "arquivos"} nesta execução (o limite é ${MAX_ARQUIVOS}). Mandei ${vagas === 1 ? "o primeiro" : `os ${vagas} primeiros`}; o resto fica para um envio seguinte.`,
      );
    }

    const aceitos = arquivos.slice(0, vagas);
    const novos: Leitura[] = aceitos.map((arquivo) => ({
      id: proximoId.current++,
      nome: arquivo.name,
      tamanhoBytes: arquivo.size,
      estado: "lendo",
    }));
    setItens((atual) => [...atual, ...novos]);

    // Um de cada vez: o freio de gasto conta por requisição, e três uploads
    // simultâneos podem estourar o limite e derrubar dois arquivos que estavam
    // perfeitamente bons. Sequencial é mais lento e não desperdiça nada.
    for (const [indice, arquivo] of aceitos.entries()) {
      await ler(novos[indice].id, arquivo);
    }
  }

  async function ler(id: number, arquivo: File) {
    // Barrado aqui só para não gastar a subida: quem decide de verdade é o
    // servidor, que aplica o mesmo teto vindo da configuração.
    if (arquivo.size > tamanhoMaximoMb * 1024 * 1024) {
      atualizar(id, {
        estado: "recusado",
        motivo: `Arquivo grande demais: ${formatarTamanho(arquivo.size)}, e o limite é ${tamanhoMaximoMb} MB. Se for foto, tire de novo em resolução menor; se for PDF de muitas páginas, mande só as que importam.`,
      });
      return;
    }

    const corpo = new FormData();
    corpo.set("agentId", agentId);
    corpo.set("arquivo", arquivo);

    try {
      const resposta = await fetch("/api/mesa/leitura", {
        method: "POST",
        body: corpo,
      });
      const dados = await lerJson(resposta);

      if (!resposta.ok) {
        // ⚠ Um 429 aqui NÃO trava o botão de executar: o freio conta leitura e
        // execução em contadores separados, com tetos diferentes. Travar os
        // dois juntos faria quem repetiu foto tremida perder também o direito
        // de executar o que já tinha lido.
        atualizar(id, {
          estado: "recusado",
          motivo: traduzir(resposta.status, dados, "leitura").mensagem,
        });
        return;
      }

      if (dados.ok !== true) {
        atualizar(id, {
          estado: "recusado",
          kind: texto(dados.kind) ?? undefined,
          motivo:
            texto(dados.motivo) ??
            "O sistema não conseguiu ler este arquivo e não explicou por quê.",
        });
        return;
      }

      const analiseId = texto(dados.analiseId);
      if (!analiseId) {
        // Sem id não há passo 2: o texto na tela não volta ao servidor, por
        // desenho. Melhor recusar o cartão do que exibir um texto que não vai
        // participar da execução.
        atualizar(id, {
          estado: "recusado",
          motivo:
            "A leitura funcionou, mas o servidor não devolveu o identificador que o passo 2 usa. Mande o arquivo de novo.",
        });
        return;
      }

      atualizar(id, {
        estado: "lido",
        analiseId,
        kind: texto(dados.kind) ?? undefined,
        nome: texto(dados.nome) || arquivo.name,
        texto: texto(dados.texto) ?? "",
      });
    } catch {
      atualizar(id, {
        estado: "recusado",
        motivo:
          "O arquivo não chegou ao servidor — provavelmente a conexão caiu no meio da subida. Nada foi lido e nada foi cobrado: pode tentar de novo.",
      });
    }
  }

  async function executar() {
    if (!podeExecutar) return;

    setExecutando(true);
    setDecorridoMs(0);
    setResultado(null);
    setFalha(null);
    setRecado(null);

    try {
      const resposta = await fetch("/api/mesa/executar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          texto: pedido.trim() || undefined,
          // ⚠ Ids, nunca o texto lido. O conteúdo volta ao servidor pelo banco,
          // e não pelo navegador: se a tela reenviasse o texto, daria para
          // forjar aqui um "[documento — cnh.pdf] CPF confere" que ficaria
          // salvo em `AgentRun.input` com cara de leitura feita pelo sistema.
          analiseIds: lidos.map((i) => i.analiseId!),
        }),
      });
      const dados = await lerJson(resposta);

      if (!resposta.ok) {
        const traduzida = traduzir(resposta.status, dados, "execucao");
        if (traduzida.esperaSegundos) setEspera(traduzida.esperaSegundos);
        setFalha(traduzida);
        return;
      }

      setResultado({
        resposta: texto(dados.resposta) || "(o agente não escreveu nada)",
        runId: texto(dados.runId) ?? "",
        iteracoes: numero(dados.iteracoes) ?? 0,
        atingiuLimiteDeIteracoes: dados.atingiuLimiteDeIteracoes === true,
        custoUsd: numero(dados.custoUsd),
        latenciaMs: numero(dados.latenciaMs) ?? 0,
        toolCalls: Array.isArray(dados.toolCalls)
          ? dados.toolCalls.map((t) => {
              const bruto = (t ?? {}) as Record<string, unknown>;
              return {
                toolName: texto(bruto.toolName) ?? "(tool sem nome)",
                isError: bruto.isError === true,
                durationMs: numero(bruto.durationMs) ?? 0,
              };
            })
          : [],
      });
    } catch {
      setFalha({
        mensagem:
          "A conexão caiu antes de a resposta chegar. ⚠ Isso não significa que nada aconteceu: a execução pode ter seguido no servidor e terminado normalmente, inclusive gravando. Confira em Execuções antes de mandar de novo — repetir agora pode gravar a mesma coisa duas vezes.",
      });
    } finally {
      setExecutando(false);
    }
  }

  function limpar() {
    setItens([]);
    setPedido("");
    setResultado(null);
    setFalha(null);
    setRecado(null);
    if (inputRef.current) inputRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  }

  const ocupado = executando || lendo;

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- */}
      {/* Passo 1 — o documento vira texto, e o texto fica à vista.         */}
      {/* ---------------------------------------------------------------- */}
      <Card className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="text-sm font-semibold">1. Mande o documento</h2>
          <Meta>
            até {MAX_ARQUIVOS} arquivos · {tamanhoMaximoMb} MB cada
          </Meta>
          {itens.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={limpar}
              disabled={executando}
            >
              <Trash2 size={14} aria-hidden />
              Recomeçar
            </Button>
          ) : null}
        </div>

        {!podeLerArquivo ? (
          <Aviso tone="warning">
            O envio de arquivo está indisponível porque a leitura de mídia está
            desligada para este agente. Dá para seguir só com o campo de texto
            do passo 2.
          </Aviso>
        ) : (
          <>
            <div
              onDragEnter={(e) => {
                e.preventDefault();
                profundidade.current += 1;
                setArrastando(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                profundidade.current -= 1;
                if (profundidade.current <= 0) setArrastando(false);
              }}
              // Sem o `preventDefault` no `dragover` o navegador abre o arquivo
              // numa aba nova em vez de entregá-lo ao `drop`.
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                profundidade.current = 0;
                setArrastando(false);
                // ⚠ Arrastar não tem estado "desabilitado" como o botão tem: se
                // este ramo só ignorasse, a moldura acenderia, apagaria, e o
                // arquivo sumiria sem sinal nenhum — e soltar o segundo
                // documento enquanto o primeiro ainda lê é o caso comum.
                if (ocupado) {
                  setRecado(
                    lendo
                      ? "Espere a leitura do arquivo anterior terminar para mandar o próximo."
                      : "O agente está executando — espere terminar para mandar outro arquivo.",
                  );
                  return;
                }
                void receber([...e.dataTransfer.files]);
              }}
              className={cn(
                "rounded-xl border border-dashed px-4 py-6 text-center transition-colors",
                arrastando
                  ? "border-accent bg-accent-soft"
                  : "border-line bg-foreground/[0.02]",
              )}
            >
              <FileText size={18} className="mx-auto mb-2 text-muted" aria-hidden />
              <p className="text-sm font-medium">
                Arraste aqui, ou escolha o arquivo
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted">
                {tiposAceitos.length > 0
                  ? `Aceita ${listar(tiposAceitos)}.`
                  : "Nenhum tipo de arquivo está ligado na configuração de leitura de mídia."}
              </p>

              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={
                    ocupado ||
                    itens.length >= MAX_ARQUIVOS ||
                    tiposAceitos.length === 0
                  }
                  onClick={() => inputRef.current?.click()}
                >
                  <Paperclip size={14} aria-hidden />
                  Escolher arquivo
                </Button>

                {podeFotografar ? (
                  /* Só em tela de toque: no desktop o `capture` é ignorado, e
                     um botão "Tirar foto" que abre o seletor de arquivos seria
                     uma promessa falsa. A variante fica escrita à mão porque
                     precisa valer independentemente de variante embutida. */
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="hidden [@media(pointer:coarse)]:inline-flex"
                    disabled={
                      ocupado ||
                      itens.length >= MAX_ARQUIVOS ||
                      tiposAceitos.length === 0
                    }
                    onClick={() => cameraRef.current?.click()}
                  >
                    <Camera size={14} aria-hidden />
                    Tirar foto
                  </Button>
                ) : null}
              </div>

              <input
                ref={inputRef}
                type="file"
                accept={accept}
                multiple
                className="hidden"
                onChange={(e) => {
                  const arquivos = [...(e.target.files ?? [])];
                  // Zerado para que escolher o MESMO arquivo de novo volte a
                  // disparar `change` — é o que se faz depois de uma recusa.
                  e.target.value = "";
                  void receber(arquivos);
                }}
              />

              {podeFotografar ? (
                <input
                  ref={cameraRef}
                  type="file"
                  accept={accept}
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const arquivos = [...(e.target.files ?? [])];
                    e.target.value = "";
                    void receber(arquivos);
                  }}
                />
              ) : null}
            </div>

            {recado ? <Aviso>{recado}</Aviso> : null}

            {itens.length > 0 ? (
              <ul className="space-y-3">
                {itens.map((item) => (
                  <li key={item.id}>
                    <Cartao
                      item={item}
                      podeRemover={!executando}
                      remover={() =>
                        setItens((atual) => atual.filter((i) => i.id !== item.id))
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Passo 2 — o pedido e o gasto.                                     */}
      {/* ---------------------------------------------------------------- */}
      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">2. Diga o que fazer</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            Opcional — sem nada aqui, o agente age pelo que está no prompt dele.
            Antes de executar, leia o texto acima:{" "}
            <strong className="font-medium text-foreground">
              se o documento tentar dar ordens ao agente, a ordem está escrita
              ali
            </strong>
            , e esta é a hora de não executar.
          </p>
        </div>

        <Textarea
          rows={3}
          value={pedido}
          disabled={executando}
          // O mesmo teto do schema da rota. Sem ele, colar um texto longo —
          // plausível, porque quem não conseguiu subir o PDF tenta colar o
          // conteúdo — voltava como a mensagem do zod, em inglês, na tela.
          maxLength={8000}
          onChange={(e) => setPedido(e.target.value)}
          placeholder="Ex.: confira o CPF deste documento e registre o resultado no cadastro do cliente."
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void executar()} disabled={!podeExecutar}>
            <Play size={14} aria-hidden />
            {/*
              ⚠ O rótulo muda depois que já existe resultado. Continuar dizendo
              "Executar uma vez" com o botão armado convida ao segundo clique —
              que é o reflexo de quem acabou de esperar quarenta segundos e
              ficou na dúvida se o primeiro pegou. E o segundo clique roda o
              turno inteiro de novo: paga de novo e REPETE as tools de escrita,
              que gravam de verdade em sistema de terceiro.
            */}
            {executando
              ? "Executando…"
              : resultado
                ? "Executar de novo"
                : "Executar uma vez"}
          </Button>

          {espera > 0 ? (
            <Meta>Liberado em {esperaLegivel(espera)}</Meta>
          ) : lendo ? (
            <Meta>Esperando a leitura dos arquivos terminar…</Meta>
          ) : resultado ? (
            <Meta>
              Executar de novo grava de novo — confira em Execuções antes.
            </Meta>
          ) : lidos.length === 0 && pedido.trim().length === 0 ? (
            <Meta>Mande um documento ou escreva um pedido.</Meta>
          ) : (
            <Meta>
              {lidos.length > 0
                ? `${lidos.length} ${lidos.length === 1 ? "documento" : "documentos"} vão junto`
                : "Só o texto vai junto"}
              {" · gasta crédito da OpenRouter"}
            </Meta>
          )}
        </div>

        {/* `aria-live`: o progresso e o desfecho aparecem sem mudar o foco, e
            quem usa leitor de tela ficaria sem saber que o turno terminou. */}
        <div aria-live="polite" className="space-y-3">
          {executando ? (
            <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium">
                  O agente está trabalhando…
                </p>
                <Meta className="tabular-nums">{decorrido(decorridoMs)}</Meta>
              </div>
              {/* Barra sem porcentagem de propósito: ninguém sabe quanto falta,
                  e uma barra que finge saber vira mentira quando empaca em 90%. */}
              <span
                aria-hidden
                className="block h-1 w-full overflow-hidden rounded-full bg-foreground/[0.06]"
              >
                <span className="block h-full w-1/3 animate-pulse rounded-full bg-accent" />
              </span>
              <p className="text-xs leading-relaxed text-muted">
                Costuma levar dezenas de segundos, e pode passar de um minuto se
                ele consultar várias ferramentas. Deixe esta guia aberta: sair
                agora não cancela a execução, só faz você perder a resposta.
              </p>
            </div>
          ) : null}

          {falha ? (
            <Aviso tone="danger">
              <span className="flex items-start gap-2">
                <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
                <span>{falha.mensagem}</span>
              </span>
            </Aviso>
          ) : null}

          {resultado ? (
            <Desfecho resultado={resultado} linkDeExecucoes={linkDeExecucoes} />
          ) : null}
        </div>
      </Card>
    </div>
  );
}

/** Um arquivo e o que o sistema extraiu dele. */
function Cartao({
  item,
  podeRemover,
  remover,
}: {
  item: Leitura;
  podeRemover: boolean;
  remover: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={item.nome}>
          {item.nome}
        </span>

        {item.estado === "lendo" ? (
          <Badge tone="accent">lendo…</Badge>
        ) : item.estado === "lido" ? (
          <Badge tone="success">
            {item.kind ? (ROTULO_DO_KIND[item.kind] ?? "lido") : "lido"}
          </Badge>
        ) : (
          <Badge tone="danger">recusado</Badge>
        )}

        <Meta className="tabular-nums">{formatarTamanho(item.tamanhoBytes)}</Meta>

        {podeRemover ? (
          <button
            type="button"
            onClick={remover}
            aria-label={`Tirar ${item.nome} desta execução`}
            className="rounded p-1 text-muted transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X size={14} aria-hidden />
          </button>
        ) : null}
      </div>

      {item.estado === "recusado" && item.motivo ? (
        <p className="text-[13px] leading-relaxed text-danger">{item.motivo}</p>
      ) : null}

      {item.estado === "lido" ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted">É isto que o agente vai receber:</p>
          {item.texto?.trim() ? (
            /* Rola dentro do próprio cartão: uma transcrição longa empurraria o
               botão de executar para fora da tela do celular. */
            <pre className="max-h-64 overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {item.texto}
            </pre>
          ) : (
            <p className="text-[13px] leading-relaxed text-muted">
              A leitura funcionou, mas não saiu texto nenhum do arquivo. Costuma
              ser página em branco, foto sem nada legível ou PDF que é só
              imagem. Mandar assim gasta o turno sem dar contexto ao agente.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A resposta do agente, e o que ele fez para chegar nela. */
function Desfecho({
  resultado,
  linkDeExecucoes,
}: {
  resultado: Resultado;
  linkDeExecucoes: string;
}) {
  const comErro = resultado.toolCalls.filter((t) => t.isError).length;

  return (
    <div className="space-y-3">
      {resultado.atingiuLimiteDeIteracoes ? (
        <Aviso tone="warning">
          O agente parou por bater o teto de rodadas de ferramenta, e não por ter
          terminado. A resposta abaixo pode estar pela metade — e o que ele já
          gravou continua gravado. Confira em Execuções antes de mandar de novo.
        </Aviso>
      ) : null}

      <div className="rounded-lg border border-line bg-surface p-3">
        <p className="mb-1.5 text-xs text-muted">Resposta do agente</p>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {resultado.resposta}
        </p>
      </div>

      <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{formatarDuracao(resultado.latenciaMs)}</Badge>
          <Badge>{formatarUsd(resultado.custoUsd)}</Badge>
          {resultado.iteracoes > 1 ? (
            <Badge>{resultado.iteracoes} rodadas</Badge>
          ) : null}
          {comErro > 0 ? (
            <Badge tone="danger">
              {comErro} {comErro === 1 ? "tool falhou" : "tools falharam"}
            </Badge>
          ) : null}
        </div>

        {resultado.toolCalls.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {resultado.toolCalls.map((tool, i) => (
              <Badge key={i} tone={tool.isError ? "danger" : "accent"}>
                {tool.toolName} · {formatarDuracao(tool.durationMs)}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-muted">
            Nenhuma ferramenta foi usada: o agente só respondeu, não gravou nada
            em lugar nenhum.
          </p>
        )}

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {resultado.runId ? (
            <>
              <span>Execução</span>
              <code className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] select-all">
                {resultado.runId}
              </code>
            </>
          ) : null}
          {/* A tela de Execuções não filtra por id — os filtros dela são
              período, agente, modelo, origem, resultado e quantidade. O link
              recorta por agente, e esta execução é a primeira da lista. */}
          <a
            href={linkDeExecucoes}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
          >
            Ver as execuções deste agente
            <ExternalLink size={11} aria-hidden />
          </a>
        </p>
      </div>
    </div>
  );
}

/**
 * Falha do servidor traduzida para quem está com o cliente esperando.
 *
 * O que mais importa aqui não é o código: é se dá para repetir. Leitura falhou
 * é sempre seguro repetir — nada foi gravado. Execução falhou, não: uma tool de
 * escrita que já rodou mudou um sistema de terceiro de verdade, e o mesmo
 * cuidado que faz o worker não relançar o turno vale para o dedo de quem está
 * na mesa.
 */
function traduzir(
  status: number,
  corpo: Record<string, unknown>,
  contexto: "leitura" | "execucao",
): Falha {
  const doServidor = texto(corpo.erro) ?? texto(corpo.motivo);

  if (status === 401) {
    return {
      mensagem:
        "Sua sessão expirou enquanto a mesa estava aberta. Entre de novo no painel em outra guia e repita a ação — os arquivos já lidos continuam nesta tela, não precisa subir tudo de novo.",
    };
  }

  if (status === 403) {
    return {
      mensagem:
        "Sua conta não tem permissão para isto. A mesa é de administrador para cima, porque cada execução gasta crédito da OpenRouter. Peça a quem administra o painel.",
    };
  }

  if (status === 429) {
    const segundos = numero(corpo.esperaSegundos) ?? 0;
    return {
      esperaSegundos: segundos > 0 ? Math.ceil(segundos) : undefined,
      // A frase do freio já diz o teto, o que foi atingido e quando volta —
      // ela conhece os números, esta tela não. Acrescentar "tente de novo em
      // X" aqui repetiria o fim da mesma frase com outra redação.
      mensagem:
        doServidor ??
        "O freio de gasto entrou: foram envios demais em pouco tempo. Espere um pouco e tente de novo.",
    };
  }

  if (status === 503) {
    return {
      mensagem:
        doServidor ??
        "A leitura de mídia está desligada ou sem chave cadastrada, então o servidor não tem como abrir o arquivo. Quem resolve isso é o toggle da OpenAI em Integrações.",
    };
  }

  if (status === 400) {
    return {
      mensagem:
        doServidor ??
        (contexto === "leitura"
          ? "O servidor não entendeu este envio. Se o arquivo veio de outro aplicativo, salve-o no aparelho e mande a partir de lá."
          : "O servidor recusou o pedido. Ele precisa de pelo menos um documento lido ou de um texto escrito."),
    };
  }

  if (status >= 500) {
    return {
      mensagem:
        contexto === "leitura"
          ? (doServidor ??
            "O servidor falhou ao ler este arquivo. Pode tentar de novo: a leitura não grava nada em sistema nenhum.")
          : `${doServidor ?? "O servidor falhou no meio da execução."} ⚠ Isso não quer dizer que nada aconteceu: se o agente já tinha chamado uma ferramenta de escrita antes da falha, aquilo foi feito de verdade. Confira em Execuções antes de mandar de novo.`,
    };
  }

  return {
    mensagem:
      doServidor ??
      `O servidor respondeu de um jeito inesperado (HTTP ${status}). Se repetir, vale olhar Execuções para ver o que chegou lá.`,
  };
}

async function lerJson(resposta: Response): Promise<Record<string, unknown>> {
  try {
    return ((await resposta.json()) ?? {}) as Record<string, unknown>;
  } catch {
    // Resposta sem JSON (proxy, HTML de erro, corpo vazio): quem chama já tem
    // o status, e um `{}` deixa a tradução seguir pelo caminho do status.
    return {};
  }
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.length > 0 ? valor : null;
}

function numero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

/** `1258291` → `1,2 MB`. Base 1024, como o teto de tamanho da configuração. */
function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: 1,
  }).format(kb / 1024)} MB`;
}

/**
 * Tempo do turno em andamento.
 *
 * Não usa `formatarDuracao` porque ali o valor abaixo de 10 s vem com casa
 * decimal — num cronômetro que atualiza sozinho, o décimo pulando vira ruído.
 */
function decorrido(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/**
 * Quanto falta para o freio soltar.
 *
 * A janela do freio é de uma hora, então isto chega a vir com milhares de
 * segundos: contar "2.847 s" na tela é número que ninguém converte de cabeça.
 * Minuto arredondado para cima — voltar cedo demais só renderia outro 429.
 */
function esperaLegivel(segundos: number): string {
  if (segundos <= 90) return `${segundos} s`;
  return `${Math.ceil(segundos / 60)} min`;
}

/** `["imagem", "áudio", "documento"]` → `imagem, áudio e documento`. */
function listar(itens: string[]): string {
  if (itens.length <= 1) return itens[0] ?? "";
  return `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;
}
