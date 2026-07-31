"use client";

import { useState, useTransition } from "react";
import { ChevronDown, Plug } from "lucide-react";
import Link from "next/link";
import {
  alternarIntegracaoDoAgente,
  definirToolsPermitidas,
  type EstadoIntegracaoAgente,
} from "@/server/actions/integracoes-do-agente";
import type { IntegrationProvider } from "@/generated/prisma/enums";
import { Aviso, Badge, Button, Card, Meta } from "@/components/ui";
import { cn } from "@/lib/utils";

export type IntegracaoDoAgente = {
  provider: IntegrationProvider;
  label: string;
  descricao: string;
  /** Toggle global, em Integrações. */
  ligadaGlobalmente: boolean;
  configurada: boolean;
  /** Toggle deste agente. */
  ligadaNoAgente: boolean;
  tools: {
    name: string;
    description: string;
    escreve: boolean;
    categoria: string;
    /** Quanto a tool ocupa no prompt de cada mensagem, aproximado. */
    tokens: number;
  }[];
  /** Vazio = todas liberadas. */
  permitidas: string[];
};

type Grupo = { categoria: string; tools: IntegracaoDoAgente["tools"] };

function formatarTokens(total: number) {
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
}

/** Preserva a ordem em que as categorias aparecem no catálogo. */
function agrupar(tools: IntegracaoDoAgente["tools"]): Grupo[] {
  const grupos: Grupo[] = [];
  for (const tool of tools) {
    const existente = grupos.find((g) => g.categoria === tool.categoria);
    if (existente) existente.tools.push(tool);
    else grupos.push({ categoria: tool.categoria, tools: [tool] });
  }
  return grupos;
}

export function IntegracoesDoAgente({
  agentId,
  integracoes,
  editavel,
}: {
  agentId: string;
  integracoes: IntegracaoDoAgente[];
  editavel: boolean;
}) {
  const [resultado, setResultado] = useState<EstadoIntegracaoAgente | null>(null);
  const [ocupado, iniciar] = useTransition();
  const [aberta, setAberta] = useState<string | null>(null);

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Integrações deste agente</h2>
        <p className="text-xs text-muted">
          O agente só enxerga as ferramentas de uma integração se ela estiver
          ligada aqui <strong>e</strong> em{" "}
          <Link href="/integracoes" className="underline">
            Integrações
          </Link>
          .
        </p>
      </div>

      {resultado?.erro ? <Aviso tone="danger">{resultado.erro}</Aviso> : null}
      {resultado?.ok ? <Aviso tone="success">{resultado.ok}</Aviso> : null}

      {integracoes.length === 0 ? (
        <p className="text-sm text-muted">
          Nenhuma integração disponível ainda.
        </p>
      ) : (
        <div className="space-y-2">
          {integracoes.map((i) => {
            const ativa = i.ligadaNoAgente && i.ligadaGlobalmente;
            const liberadas =
              i.permitidas.length === 0 ? i.tools.length : i.permitidas.length;

            return (
              <div
                key={i.provider}
                className="rounded-lg border border-line p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Plug
                    size={14}
                    aria-hidden
                    className={ativa ? "text-success" : "text-muted/50"}
                  />
                  <span className="text-sm font-medium">{i.label}</span>

                  {!i.configurada ? (
                    <Badge>não configurada</Badge>
                  ) : !i.ligadaGlobalmente ? (
                    <Badge tone="danger">desligada globalmente</Badge>
                  ) : i.ligadaNoAgente ? (
                    <Badge tone="success">ativa</Badge>
                  ) : (
                    <Badge>desligada para este agente</Badge>
                  )}

                  <div className="ml-auto flex items-center gap-2">
                    {ativa && i.tools.length > 0 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setAberta(aberta === i.provider ? null : i.provider)
                        }
                      >
                        {liberadas} de {i.tools.length} ferramentas
                        <ChevronDown
                          size={13}
                          aria-hidden
                          className={cn(
                            "transition",
                            aberta === i.provider && "rotate-180",
                          )}
                        />
                      </Button>
                    ) : null}

                    {editavel ? (
                      <Button
                        variant={i.ligadaNoAgente ? "secondary" : "primary"}
                        size="sm"
                        disabled={ocupado || !i.configurada}
                        onClick={() =>
                          iniciar(async () =>
                            setResultado(
                              await alternarIntegracaoDoAgente(
                                agentId,
                                i.provider,
                              ),
                            ),
                          )
                        }
                      >
                        {i.ligadaNoAgente ? "Desligar" : "Ligar"}
                      </Button>
                    ) : null}
                  </div>
                </div>

                <Meta className="mt-1 block">{i.descricao}</Meta>

                {/* Desligar o Chatwoot não cala o agente — ele continua
                    respondendo. Só tira dele as ferramentas de transferência,
                    e essa consequência não é adivinhável pelo nome. */}
                {i.provider === "CHATWOOT" && !i.ligadaNoAgente ? (
                  <Aviso tone="danger">
                    Sem o Chatwoot ligado, este agente <strong>responde mas
                    não transfere</strong>: fica sem como passar a conversa a um
                    colega nem escalar para um atendente humano.
                  </Aviso>
                ) : null}

                {aberta === i.provider ? (
                  <SelecaoDeTools
                    agentId={agentId}
                    integracao={i}
                    editavel={editavel}
                    onPronto={setResultado}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function SelecaoDeTools({
  agentId,
  integracao,
  editavel,
  onPronto,
}: {
  agentId: string;
  integracao: IntegracaoDoAgente;
  editavel: boolean;
  onPronto: (r: EstadoIntegracaoAgente) => void;
}) {
  const todas = integracao.tools.map((t) => t.name);
  const grupos = agrupar(integracao.tools);

  const [selecionadas, setSelecionadas] = useState<string[]>(
    integracao.permitidas.length === 0 ? todas : integracao.permitidas,
  );
  // Fechados por padrão: com dezenas de ferramentas, a contagem por categoria
  // já mostra o estado sem precisar abrir tudo.
  const [abertos, setAbertos] = useState<string[]>([]);
  const [ocupado, iniciar] = useTransition();

  const alternar = (nome: string) =>
    setSelecionadas((atual) =>
      atual.includes(nome)
        ? atual.filter((n) => n !== nome)
        : [...atual, nome],
    );

  const alternarGrupo = (grupo: Grupo, marcar: boolean) =>
    setSelecionadas((atual) => {
      const nomes = grupo.tools.map((t) => t.name);
      const sem = atual.filter((n) => !nomes.includes(n));
      return marcar ? [...sem, ...nomes] : sem;
    });

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <p className="text-xs text-muted">
        Cada ferramenta liberada entra no prompt de <strong>toda</strong>{" "}
        mensagem. Liberar só o necessário reduz custo e a chance do modelo
        escolher errado.
      </p>

      {editavel ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={ocupado}
            onClick={() =>
              iniciar(async () =>
                onPronto(
                  await definirToolsPermitidas(
                    agentId,
                    integracao.provider,
                    selecionadas,
                  ),
                ),
              )
            }
          >
            {ocupado ? "Salvando…" : "Salvar ferramentas"}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelecionadas(todas)}
            disabled={ocupado}
          >
            Marcar todas
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelecionadas([])}
            disabled={ocupado}
          >
            Desmarcar todas
          </Button>

          <span className="ml-auto text-xs text-muted">
            {selecionadas.length} de {todas.length} · ~
            {formatarTokens(
              integracao.tools
                .filter((t) => selecionadas.includes(t.name))
                .reduce((soma, t) => soma + t.tokens, 0),
            )}{" "}
            tokens por mensagem
          </span>
        </div>
      ) : null}

      <div className="divide-y divide-line rounded-lg border border-line">
        {grupos.map((grupo) => {
          const nomes = grupo.tools.map((t) => t.name);
          const marcadas = nomes.filter((n) => selecionadas.includes(n)).length;
          const aberto = abertos.includes(grupo.categoria);

          return (
            <div key={grupo.categoria}>
              <div className="flex items-center gap-2 px-3 py-2">
                <input
                  type="checkbox"
                  className="size-3.5 shrink-0"
                  aria-label={`Todas as ferramentas de ${grupo.categoria}`}
                  checked={marcadas === nomes.length}
                  ref={(el) => {
                    if (el) el.indeterminate = marcadas > 0 && marcadas < nomes.length;
                  }}
                  disabled={!editavel}
                  onChange={(e) => alternarGrupo(grupo, e.target.checked)}
                />

                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() =>
                    setAbertos((atual) =>
                      aberto
                        ? atual.filter((c) => c !== grupo.categoria)
                        : [...atual, grupo.categoria],
                    )
                  }
                >
                  <span className="text-sm font-medium">{grupo.categoria}</span>
                  <span className="text-xs text-muted">
                    ({marcadas}/{nomes.length})
                  </span>
                  <ChevronDown
                    size={14}
                    aria-hidden
                    className={cn(
                      "ml-auto shrink-0 text-muted transition",
                      aberto && "rotate-180",
                    )}
                  />
                </button>
              </div>

              {aberto ? (
                <ul className="space-y-1.5 px-3 pb-3 pl-8">
                  {grupo.tools.map((t) => (
                    <li key={t.name}>
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-3.5 shrink-0"
                          checked={selecionadas.includes(t.name)}
                          disabled={!editavel}
                          onChange={() => alternar(t.name)}
                        />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <code className="font-mono text-xs">{t.name}</code>
                            {t.escreve ? <Badge tone="accent">escreve</Badge> : null}
                          </span>
                          <Meta className="block">{t.description}</Meta>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
