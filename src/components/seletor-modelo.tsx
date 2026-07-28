"use client";

import { useMemo, useState } from "react";
import { Check, Search, Wrench, Brain, AlertTriangle } from "lucide-react";
import {
  DICAS_EFFORT,
  EFFORTS,
  formatarPrecoMTok,
  type Effort,
  type ModeloCatalogo,
} from "@/server/agents/catalogo";
import { Badge, Button, Field, Input, Select } from "@/components/ui";
import { cn } from "@/lib/utils";

const MAX_RESULTADOS = 60;

/**
 * Escolha de modelo da OpenRouter.
 *
 * O `effort` fica aqui junto porque só faz sentido em modelo com raciocínio —
 * a habilitação do campo depende do modelo selecionado.
 */
export function SeletorModelo({
  modelos,
  modeloInicial,
  effortInicial,
  somenteLeitura = false,
}: {
  modelos: ModeloCatalogo[];
  modeloInicial: string;
  effortInicial: string;
  somenteLeitura?: boolean;
}) {
  const [selecionado, setSelecionado] = useState(modeloInicial);
  const [effort, setEffort] = useState<Effort>(effortInicial as Effort);
  const [busca, setBusca] = useState("");
  const [aberto, setAberto] = useState(false);

  const atual = modelos.find((m) => m.id === selecionado) ?? null;

  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    const base = termo
      ? modelos.filter(
          (m) =>
            m.id.toLowerCase().includes(termo) ||
            m.nome.toLowerCase().includes(termo),
        )
      : modelos;
    return base.slice(0, MAX_RESULTADOS);
  }, [busca, modelos]);

  const totalFiltrado = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return modelos.length;
    return modelos.filter(
      (m) =>
        m.id.toLowerCase().includes(termo) ||
        m.nome.toLowerCase().includes(termo),
    ).length;
  }, [busca, modelos]);

  return (
    <div className="space-y-4">
      <input type="hidden" name="model" value={selecionado} />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Modelo</span>
          {!somenteLeitura ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAberto((v) => !v)}
            >
              {aberto ? "Fechar lista" : "Trocar modelo"}
            </Button>
          ) : null}
        </div>

        <div className="rounded-md border border-line p-3">
          {atual ? (
            <>
              <p className="text-sm font-medium">{atual.nome}</p>
              <p className="font-mono text-xs text-muted">{atual.id}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge>
                  {formatarPrecoMTok(atual.precoEntradaMTok)} /{" "}
                  {formatarPrecoMTok(atual.precoSaidaMTok)} por MTok
                </Badge>
                <Badge>{(atual.contexto / 1000).toFixed(0)}k contexto</Badge>
                {atual.suportaTools ? (
                  <Badge tone="success">tools</Badge>
                ) : (
                  <Badge tone="danger">sem tools</Badge>
                )}
                {atual.suportaReasoning ? <Badge tone="accent">reasoning</Badge> : null}
              </div>
            </>
          ) : (
            <>
              <p className="font-mono text-sm">{selecionado}</p>
              <p className="text-xs text-muted">
                Fora do catálogo carregado — pode ser um slug antigo ou a lista
                não foi obtida agora.
              </p>
            </>
          )}
        </div>

        {atual && !atual.suportaTools ? (
          <p className="flex items-start gap-1.5 text-xs text-danger">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
            Este modelo não aceita tools. As integrações ligadas para o agente
            serão ignoradas.
          </p>
        ) : null}
      </div>

      {aberto && !somenteLeitura ? (
        <div className="space-y-2 rounded-md border border-line p-3">
          <div className="relative">
            <Search
              size={14}
              className="absolute top-3 left-3 text-muted"
              aria-hidden
            />
            <Input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por nome ou slug (ex.: gemini, deepseek, gpt)"
              className="pl-8"
              autoFocus
            />
          </div>

          <p className="text-xs text-muted">
            {totalFiltrado} modelo(s)
            {totalFiltrado > MAX_RESULTADOS
              ? ` — mostrando os ${MAX_RESULTADOS} primeiros, refine a busca`
              : ""}
          </p>

          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {filtrados.map((modelo) => (
              <li key={modelo.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelecionado(modelo.id);
                    setAberto(false);
                    setBusca("");
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-accent-soft",
                    modelo.id === selecionado && "bg-accent-soft",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{modelo.nome}</span>
                    <span className="block truncate font-mono text-xs text-muted">
                      {modelo.id}
                    </span>
                  </span>

                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                    {modelo.suportaTools ? (
                      <Wrench size={12} aria-label="suporta tools" />
                    ) : null}
                    {modelo.suportaReasoning ? (
                      <Brain size={12} aria-label="suporta reasoning" />
                    ) : null}
                    <span className="tabular-nums">
                      {formatarPrecoMTok(modelo.precoEntradaMTok)}/
                      {formatarPrecoMTok(modelo.precoSaidaMTok)}
                    </span>
                    {modelo.id === selecionado ? (
                      <Check size={14} className="text-accent" aria-hidden />
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Field
        label="Effort (profundidade do raciocínio)"
        hint={
          atual && !atual.suportaReasoning
            ? "Este modelo não tem raciocínio configurável — o valor fica salvo, mas não é enviado nas chamadas."
            : DICAS_EFFORT[effort]
        }
      >
        {/* Não desabilitar por falta de reasoning: campo desabilitado não vai no
            FormData e a validação rejeitaria o formulário inteiro. */}
        <Select
          name="effort"
          value={effort}
          onChange={(e) => setEffort(e.target.value as Effort)}
          disabled={somenteLeitura}
        >
          {EFFORTS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
