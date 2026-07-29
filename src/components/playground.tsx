"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Trash2 } from "lucide-react";
import { Aviso, Badge, Button, Card, Input } from "@/components/ui";
import { formatarUsd } from "@/lib/utils";
import { estaNoFim } from "@/lib/rolagem";

type Turno = {
  role: "user" | "assistant";
  content: string;
  meta?: {
    latenciaMs: number;
    custoUsd: number;
    iteracoes: number;
    tools: { nome: string; isError: boolean; durationMs: number }[];
  };
};

/**
 * Playground: conversa direto com o agente, sem passar pelo Chatwoot.
 * Serve para validar prompt e comportamento antes de ligar em produção.
 */
export function Playground({
  agentId,
  agenteAtivo,
}: {
  agentId: string;
  agenteAtivo: boolean;
}) {
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listaRef = useRef<HTMLDivElement>(null);
  /** Enquanto verdadeiro, mensagem nova traz a conversa para o fim sozinha. */
  const grudado = useRef(true);

  const irParaOFim = useCallback(() => {
    const lista = listaRef.current;
    if (!lista) return;

    // Quem pediu menos animação no sistema não deve levar um salto animado.
    const suave = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    lista.scrollTo({
      top: lista.scrollHeight,
      behavior: suave ? "smooth" : "auto",
    });
  }, []);

  // Roda tanto na resposta quanto no "Pensando…", que também empurra o conteúdo.
  useEffect(() => {
    if (grudado.current) irParaOFim();
  }, [turnos, enviando, irParaOFim]);

  /** Só depois do primeiro envio — focar no carregamento da página incomoda. */
  const jaEnviou = useRef(false);

  // O campo fica desabilitado enquanto o agente pensa, e o navegador tira o
  // foco de campo desabilitado. Sem isto, cada teste exige clicar no campo.
  useEffect(() => {
    if (!enviando && jaEnviou.current) inputRef.current?.focus();
  }, [enviando]);

  async function enviar(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const mensagem = inputRef.current?.value.trim();
    if (!mensagem || enviando) return;

    // Mandar mensagem é intenção explícita de continuar a conversa: volta para
    // o fim mesmo que se estivesse lendo algo mais acima.
    grudado.current = true;
    jaEnviou.current = true;

    const historico = turnos.map(({ role, content }) => ({ role, content }));
    setTurnos((atual) => [...atual, { role: "user", content: mensagem }]);
    if (inputRef.current) inputRef.current.value = "";
    setEnviando(true);
    setErro(null);

    try {
      const resposta = await fetch("/api/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, mensagem, historico }),
      });
      const dados = await resposta.json();

      if (!resposta.ok) {
        setErro(dados.erro ?? "Falha ao executar o agente.");
        return;
      }

      setTurnos((atual) => [
        ...atual,
        {
          role: "assistant",
          content: dados.resposta || "(resposta vazia)",
          meta: {
            latenciaMs: dados.latenciaMs,
            custoUsd: dados.custoUsd,
            iteracoes: dados.iteracoes,
            tools: (dados.toolCalls ?? []).map(
              (t: { nome: string; isError: boolean; durationMs: number }) => ({
                nome: t.nome,
                isError: t.isError,
                durationMs: t.durationMs,
              }),
            ),
          },
        },
      ]);
    } catch {
      setErro("Não foi possível falar com o servidor.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Card className="flex h-[600px] flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Playground</h2>
          <p className="text-xs text-muted">
            Conversa direta com o agente — não passa pelo Chatwoot.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setTurnos([]);
            setErro(null);
            grudado.current = true;
          }}
          disabled={turnos.length === 0}
        >
          <Trash2 size={14} aria-hidden />
          Limpar
        </Button>
      </header>

      {!agenteAtivo ? (
        <Aviso>
          Este agente está desligado. O playground funciona mesmo assim — é para
          isso que ele existe.
        </Aviso>
      ) : null}

      <div
        ref={listaRef}
        onScroll={(e) => {
          grudado.current = estaNoFim(e.currentTarget);
        }}
        className="flex-1 space-y-3 overflow-y-auto pr-1"
      >
        {turnos.length === 0 ? (
          <p className="pt-16 text-center text-sm text-muted">
            Mande uma mensagem como se fosse um cliente.
          </p>
        ) : null}

        {turnos.map((turno, indice) => (
          <div
            key={indice}
            className={
              turno.role === "user"
                ? "ml-auto max-w-[80%] rounded-lg bg-accent-soft px-3 py-2 text-sm"
                : "mr-auto max-w-[85%] space-y-2"
            }
          >
            <p className="whitespace-pre-wrap rounded-lg border border-line bg-background px-3 py-2 text-sm">
              {turno.content}
            </p>

            {turno.meta ? (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <Badge>{turno.meta.latenciaMs} ms</Badge>
                <Badge>{formatarUsd(turno.meta.custoUsd)}</Badge>
                {turno.meta.iteracoes > 1 ? (
                  <Badge>{turno.meta.iteracoes} rodadas</Badge>
                ) : null}
                {turno.meta.tools.map((tool, i) => (
                  <Badge key={i} tone={tool.isError ? "danger" : "accent"}>
                    {tool.nome} · {tool.durationMs}ms
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ))}

        {enviando ? (
          <p className="mr-auto text-sm text-muted">Pensando…</p>
        ) : null}
      </div>

      {erro ? <Aviso tone="danger">{erro}</Aviso> : null}

      <form onSubmit={enviar} className="flex gap-2">
        <Input
          ref={inputRef}
          placeholder="Mensagem do cliente…"
          disabled={enviando}
        />
        <Button type="submit" disabled={enviando}>
          <Send size={14} aria-hidden />
          Enviar
        </Button>
      </form>
    </Card>
  );
}
