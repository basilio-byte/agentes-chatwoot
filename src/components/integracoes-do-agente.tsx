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
  tools: { name: string; description: string; escreve: boolean }[];
  /** Vazio = todas liberadas. */
  permitidas: string[];
};

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
  const [selecionadas, setSelecionadas] = useState<string[]>(
    integracao.permitidas.length === 0 ? todas : integracao.permitidas,
  );
  const [ocupado, iniciar] = useTransition();

  const alternar = (nome: string) =>
    setSelecionadas((atual) =>
      atual.includes(nome)
        ? atual.filter((n) => n !== nome)
        : [...atual, nome],
    );

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <p className="text-xs text-muted">
        Cada ferramenta liberada entra no prompt de toda mensagem. Liberar só o
        necessário reduz custo e a chance do modelo escolher errado.
      </p>

      <ul className="space-y-1.5">
        {integracao.tools.map((t) => (
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
            Selecionar todas
          </Button>
        </div>
      ) : null}
    </div>
  );
}
