"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Copy, ExternalLink, Square } from "lucide-react";
import {
  detalharExecucao,
  pararExecucao,
  type DetalheDaExecucao,
  type EstadoDaParada,
  type FalhaAoDetalhar,
  type ToolCallDetalhada,
} from "@/server/actions/execucoes";
import { Aviso, Badge, Button, Card, Meta } from "@/components/ui";
import {
  AVISO_DESATUALIZADO,
  ehFluxoDeControle,
  ehVersaoDesatualizada,
} from "@/lib/erro-de-acao";
import {
  cn,
  formatarData,
  formatarDuracao,
  formatarNumero,
  formatarUsd,
} from "@/lib/utils";

export type ResumoDaExecucao = {
  id: string;
  status: string;
  source: string;
  model: string | null;
  createdAt: Date;
  latencyMs: number | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  input: string;
  output: string | null;
  error: string | null;
  agente: { id: string; nome: string };
  tools: { toolName: string; isError: boolean }[];
};

/**
 * A ação devolve o detalhe OU uma falha nomeada.
 *
 * ⚠ Mora aqui, e não junto da ação: num arquivo "use server" toda exportação
 * precisa ser função assíncrona, e este reconhecedor é síncrono. O `tsc` deixa
 * passar — quem reprova é o build do Next.
 */
function ehFalhaAoDetalhar(
  r: DetalheDaExecucao | FalhaAoDetalhar | null,
): r is FalhaAoDetalhar {
  return r !== null && "erro" in r;
}

const ROTULO_DA_FONTE: Record<string, string> = {
  CHATWOOT: "Chatwoot",
  TRIGGER: "Gatilho",
  PLAYGROUND: "Playground",
  SCHEDULE: "Agendamento",
};

const PAPEL: Record<string, { rotulo: string; classe: string }> = {
  system: { rotulo: "sistema", classe: "text-muted" },
  user: { rotulo: "cliente", classe: "text-accent" },
  assistant: { rotulo: "agente", classe: "text-foreground" },
  tool: { rotulo: "retorno de tool", classe: "text-muted" },
};

/** Bloco de texto longo: rola por dentro em vez de esticar a página. */
function Bloco({
  children,
  mono = false,
  className,
}: {
  children: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-[12px] leading-relaxed whitespace-pre-wrap",
        mono && "font-mono",
        className,
      )}
    >
      {children}
    </pre>
  );
}

function BotaoCopiar({ texto, rotulo }: { texto: string; rotulo: string }) {
  const [copiado, setCopiado] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(texto);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 1500);
        } catch {
          // Sem permissão de área de transferência: o texto está na tela e dá
          // para selecionar. Falhar em silêncio é melhor que um alerta.
        }
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <Copy size={11} aria-hidden />
      {copiado ? "copiado" : rotulo}
    </button>
  );
}

function Chamada({ tool }: { tool: ToolCallDetalhada }) {
  const [aberta, setAberta] = useState(false);

  return (
    <li className="rounded-lg border border-line">
      <button
        type="button"
        onClick={() => setAberta((a) => !a)}
        aria-expanded={aberta}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <ChevronDown
          size={13}
          aria-hidden
          className={cn("shrink-0 text-muted transition", aberta && "rotate-180")}
        />
        <code className="font-mono text-xs">{tool.toolName}</code>
        {tool.isError ? <Badge tone="danger">erro</Badge> : null}
        <Meta className="ml-auto shrink-0">
          {formatarDuracao(tool.durationMs)}
        </Meta>
      </button>

      {aberta ? (
        <div className="space-y-2 border-t border-line p-3">
          <div className="flex items-center justify-between">
            <Meta>Parâmetros</Meta>
            <BotaoCopiar texto={tool.input} rotulo="copiar" />
          </div>
          <Bloco mono>{tool.input || "—"}</Bloco>

          <div className="flex items-center justify-between">
            <Meta>Retorno</Meta>
            <BotaoCopiar texto={tool.output} rotulo="copiar" />
          </div>
          <Bloco mono className={tool.isError ? "text-danger" : undefined}>
            {tool.output || "—"}
          </Bloco>
        </div>
      ) : null}
    </li>
  );
}

function Detalhe({
  detalhe,
  resumo,
  linkDaConversa,
}: {
  detalhe: DetalheDaExecucao;
  resumo: ResumoDaExecucao;
  linkDaConversa: string | null;
}) {
  const [verTranscricao, setVerTranscricao] = useState(false);

  const numeros: [string, React.ReactNode][] = [
    ["Modelo", resumo.model ?? "não registrado"],
    ["Custo", formatarUsd(resumo.costUsd)],
    ["Latência", formatarDuracao(resumo.latencyMs)],
    ["Rodadas de tool", formatarNumero(detalhe.iterations)],
    ["Tokens de entrada", formatarNumero(detalhe.inputTokens)],
    ["Tokens de saída", formatarNumero(detalhe.outputTokens)],
    ["Lidos do cache", formatarNumero(detalhe.cacheReadTokens)],
    [
      "Terminou em",
      detalhe.finishedAt ? formatarData(detalhe.finishedAt) : "não terminou",
    ],
  ];

  return (
    <div className="space-y-4 border-t border-line pt-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {numeros.map(([rotulo, valor]) => (
          <div key={rotulo} className="min-w-0">
            <dt className="text-[11px] text-muted">{rotulo}</dt>
            <dd className="truncate text-[13px] tabular-nums" title={String(valor)}>
              {valor}
            </dd>
          </div>
        ))}
      </dl>

      {detalhe.conversa ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          Conversa:{" "}
          <span className="text-foreground">
            {detalhe.conversa.contactName ?? "contato sem nome"}
          </span>
          <Link href="/conversas" className="underline">
            ver em Conversas
          </Link>
          {linkDaConversa ? (
            <a
              href={linkDaConversa}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline"
            >
              abrir no Chatwoot
              <ExternalLink size={11} aria-hidden />
            </a>
          ) : null}
        </p>
      ) : null}

      {detalhe.error ? (
        <div className="space-y-1">
          <Meta>Erro</Meta>
          <Bloco className="text-danger">{detalhe.error}</Bloco>
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Meta>Entrada completa</Meta>
          <BotaoCopiar texto={detalhe.input} rotulo="copiar" />
        </div>
        <Bloco>{detalhe.input}</Bloco>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Meta>Resposta completa</Meta>
          <BotaoCopiar texto={detalhe.output ?? ""} rotulo="copiar" />
        </div>
        <Bloco>
          {detalhe.output || "O agente não produziu texto neste turno."}
        </Bloco>
      </div>

      {detalhe.toolCalls.length > 0 ? (
        <div className="space-y-1.5">
          <Meta>
            Tools chamadas ({detalhe.toolCalls.length}) — abra para ver
            parâmetros e retorno
          </Meta>
          <ul className="space-y-1.5">
            {detalhe.toolCalls.map((t) => (
              <Chamada key={t.id} tool={t} />
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => setVerTranscricao((v) => !v)}
          aria-expanded={verTranscricao}
          className="inline-flex items-center gap-1.5 text-xs text-muted transition hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ChevronDown
            size={13}
            aria-hidden
            className={cn("transition", verTranscricao && "rotate-180")}
          />
          Transcrição enviada ao modelo ({detalhe.mensagens.length} mensagens)
        </button>

        {verTranscricao ? (
          <div className="space-y-2">
            {detalhe.transcricaoCortada ? (
              <Aviso tone="warning">
                Um ou mais blocos foram cortados por tamanho para não travar a
                página. O conteúdo completo continua no banco.
              </Aviso>
            ) : null}

            <ol className="space-y-2">
              {detalhe.mensagens.map((m, i) => {
                const papel = PAPEL[m.papel] ?? {
                  rotulo: m.papel,
                  classe: "text-muted",
                };
                return (
                  <li key={i} className="space-y-1">
                    <p
                      className={cn(
                        "text-[11px] font-medium tracking-wide uppercase",
                        papel.classe,
                      )}
                    >
                      {papel.rotulo}
                      {m.toolsPedidas.length > 0
                        ? ` · pediu ${m.toolsPedidas.join(", ")}`
                        : ""}
                    </p>
                    {m.conteudo ? (
                      <Bloco className="max-h-56">{m.conteudo}</Bloco>
                    ) : (
                      <p className="text-xs text-muted italic">
                        sem texto — só a chamada de tool
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Um cartão de execução, com expansão sob demanda.
 *
 * Fechado, ele responde "o que aconteceu"; aberto, responde "por que o bot
 * respondeu isso" — e para essa segunda pergunta é preciso ver TUDO: entrada e
 * resposta inteiras, cada tool com parâmetros e retorno, e a transcrição que
 * foi realmente enviada ao modelo. Isso é grande demais para vir de graça em
 * cinquenta cartões, então só desce ao abrir.
 */
export function Execucao({
  resumo,
  linkDaConversa,
  editavel,
}: {
  resumo: ResumoDaExecucao;
  /** Montado no servidor, que é quem conhece a URL da instância do Chatwoot. */
  linkDaConversa: string | null;
  /** Parar interrompe um atendimento com cliente do outro lado: só quem edita. */
  editavel: boolean;
}) {
  const painelId = useId();
  const [aberto, setAberto] = useState(false);
  const [detalhe, setDetalhe] = useState<DetalheDaExecucao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  // Separado do texto do erro porque muda a AÇÃO oferecida: recarregar resolve,
  // "tentar de novo" não resolve nunca.
  const [desatualizado, setDesatualizado] = useState(false);
  const [carregando, iniciar] = useTransition();

  function alternar() {
    const abrindo = !aberto;
    setAberto(abrindo);
    // Busca uma vez só: fechar e reabrir não paga a viagem de novo, e o
    // conteúdo de uma execução terminada não muda mais.
    if (!abrindo || detalhe || carregando) return;

    iniciar(async () => {
      try {
        const resultado = await detalharExecucao(resumo.id);
        if (!resultado) {
          setErro("Esta execução não existe mais — pode ter sido apagada.");
          return;
        }
        // A ação devolve a falha NOMEADA, com o código que também foi para o
        // log do servidor — em produção o Next mascara a mensagem de um erro
        // lançado, e sem isto a causa ficaria invisível dos dois lados.
        if (ehFalhaAoDetalhar(resultado)) {
          setDesatualizado(false);
          setErro(resultado.erro);
          return;
        }
        setDetalhe(resultado);
        setErro(null);
        setDesatualizado(false);
      } catch (e) {
        // ⚠ `redirect()` e `notFound()` chegam aqui como exceção. Engoli-los
        // era metade do defeito de 04/09/2026: sessão expirada virava "tente de
        // novo", e o operador nunca era levado ao login.
        if (ehFluxoDeControle(e)) throw e;

        // A aba está com o JavaScript de uma build anterior e chamou uma ação
        // que não existe mais. Tentar de novo NUNCA resolve — só recarregar —,
        // e foi por isso que isto passou por "problema de armazenamento".
        if (ehVersaoDesatualizada(e)) {
          setDesatualizado(true);
          setErro(AVISO_DESATUALIZADO.semPerda);
          return;
        }

        setDesatualizado(false);
        setErro(
          e instanceof Error && e.message
            ? `Não foi possível carregar o detalhe: ${e.message}`
            : "Não foi possível carregar o detalhe. Tente de novo.",
        );
      }
    });
  }

  const [parada, setParada] = useState<EstadoDaParada | null>(null);
  const [parando, pararTransicao] = useTransition();

  const erroDeExecucao = resumo.status === "ERROR";
  const rodando = resumo.status === "RUNNING";
  // Interrompida não é erro nem sucesso: foi decisão de alguém, e pintar de
  // vermelho mandaria procurar defeito onde não há.
  const tomDoStatus = erroDeExecucao
    ? ("danger" as const)
    : rodando
      ? ("accent" as const)
      : resumo.status === "CANCELED"
        ? ("neutral" as const)
        : ("success" as const);

  return (
    <Card className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={tomDoStatus}>{resumo.status}</Badge>
        <Badge>{ROTULO_DA_FONTE[resumo.source] ?? resumo.source}</Badge>
        <Link
          href={`/agentes/${resumo.agente.id}`}
          className="font-medium hover:underline"
        >
          {resumo.agente.nome}
        </Link>
        <span className="text-muted">
          {formatarData(resumo.createdAt)} ·{" "}
          {formatarDuracao(resumo.latencyMs)} · {formatarUsd(resumo.costUsd)} ·{" "}
          {formatarNumero(resumo.inputTokens + resumo.outputTokens)} tokens
        </span>
        {resumo.model ? (
          <Meta className="truncate font-mono" title={resumo.model}>
            {resumo.model}
          </Meta>
        ) : null}

        {rodando && editavel ? (
          <Button
            variant="danger"
            size="sm"
            className="ml-auto"
            disabled={parando}
            onClick={() =>
              pararTransicao(async () => setParada(await pararExecucao(resumo.id)))
            }
          >
            <Square size={12} aria-hidden />
            {parando ? "Parando…" : "Parar"}
          </Button>
        ) : null}

        <button
          type="button"
          onClick={alternar}
          aria-expanded={aberto}
          aria-controls={painelId}
          className={cn(
            !(rodando && editavel) && "ml-auto",
            "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted transition hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          )}
        >
          {aberto ? "Fechar" : "Ver tudo"}
          <ChevronDown
            size={13}
            aria-hidden
            className={cn("transition", aberto && "rotate-180")}
          />
        </button>
      </div>

      {parada?.ok ? <Aviso tone="success">{parada.ok}</Aviso> : null}
      {parada?.erro ? <Aviso tone="danger">{parada.erro}</Aviso> : null}

      {/* Fechado, o cartão continua sendo a lista que já existia: duas linhas
          de entrada, duas de resposta e as tools em etiqueta. */}
      {!aberto ? (
        <>
          <p className="line-clamp-2 text-sm">
            <span className="text-muted">Entrada: </span>
            {resumo.input}
          </p>

          {resumo.error ? (
            <p className="line-clamp-2 text-sm text-danger">{resumo.error}</p>
          ) : (
            <p className="line-clamp-2 text-sm text-muted">{resumo.output}</p>
          )}

          {resumo.tools.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {resumo.tools.map((tool, i) => (
                <Badge key={i} tone={tool.isError ? "danger" : "accent"}>
                  {tool.toolName}
                </Badge>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      <div id={painelId} hidden={!aberto}>
        {carregando && !detalhe ? (
          <p className="border-t border-line pt-4 text-sm text-muted">
            Carregando o detalhe…
          </p>
        ) : null}

        {erro ? (
          <div className="space-y-2 border-t border-line pt-4">
            <Aviso tone={desatualizado ? "warning" : "danger"}>{erro}</Aviso>
            {/* Aqui recarregar não custa nada — não há texto digitado para
                perder, ao contrário do formulário do agente. */}
            {desatualizado ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => window.location.reload()}
              >
                Recarregar a página
              </Button>
            ) : null}
          </div>
        ) : null}

        {detalhe ? (
          <Detalhe
            detalhe={detalhe}
            resumo={resumo}
            linkDaConversa={linkDaConversa}
          />
        ) : null}
      </div>
    </Card>
  );
}
