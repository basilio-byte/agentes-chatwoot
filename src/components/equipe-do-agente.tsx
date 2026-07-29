"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { DoorOpen, Users } from "lucide-react";
import { definirAgenteDeEntrada } from "@/server/actions/agents";
import { Aviso, Badge, Button, Card, Meta } from "@/components/ui";

export type ColegaDeEquipe = {
  id: string;
  key: string;
  name: string;
  routingDescription: string | null;
  active: boolean;
  isEntry: boolean;
};

export function EquipeDoAgente({
  agenteId,
  agenteKey,
  ehEntrada,
  temDescricaoDeRoteamento,
  colegas,
  editavel,
}: {
  agenteId: string;
  agenteKey: string;
  ehEntrada: boolean;
  temDescricaoDeRoteamento: boolean;
  colegas: ColegaDeEquipe[];
  editavel: boolean;
}) {
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, iniciar] = useTransition();

  const alcancaveis = colegas.filter(
    (c) => c.active && (c.routingDescription ?? "").trim().length > 0,
  );
  const entradaAtual = colegas.find((c) => c.isEntry);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Users size={15} aria-hidden className="text-muted" />
        <h2 className="text-sm font-semibold">Equipe</h2>
        <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
          {agenteKey}
        </code>
        {ehEntrada ? (
          <Badge tone="accent">
            <DoorOpen size={12} aria-hidden /> agente de entrada
          </Badge>
        ) : null}
      </div>

      <p className="text-xs text-muted">
        A chave é como os colegas se referem a este agente ao transferir. Ela não
        muda quando você renomeia o agente — os prompts dos outros continuam
        valendo.
      </p>

      {aviso ? <Aviso>{aviso}</Aviso> : null}

      {!temDescricaoDeRoteamento ? (
        <Aviso>
          Sem o campo <strong>&quot;Quando me transferir uma conversa&quot;</strong>{" "}
          preenchido, este agente não aparece para os colegas — ninguém consegue
          passar uma conversa para ele.
        </Aviso>
      ) : null}

      {!ehEntrada && editavel ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={ocupado}
            onClick={() =>
              iniciar(async () => {
                const r = await definirAgenteDeEntrada(agenteId);
                setAviso(r?.aviso ?? "Este agente passou a ser a entrada.");
              })
            }
          >
            <DoorOpen size={14} aria-hidden />
            Tornar o agente de entrada
          </Button>
          <Meta>
            Hoje é {entradaAtual ? entradaAtual.name : "ninguém"} — só um agente
            pode ser a entrada.
          </Meta>
        </div>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-xs font-medium text-muted">
          Para quem este agente pode transferir ({alcancaveis.length})
        </h3>

        {alcancaveis.length === 0 ? (
          <p className="text-sm text-muted">
            Nenhum colega disponível. Um agente só aparece aqui se estiver ligado
            e tiver a descrição de roteamento preenchida.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {alcancaveis.map((c) => (
              <li key={c.id} className="flex items-start gap-2 px-3 py-2">
                <code className="shrink-0 font-mono text-xs text-accent">
                  {c.key}
                </code>
                <span className="min-w-0">
                  <Link
                    href={`/agentes/${c.id}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {c.name}
                  </Link>
                  {c.isEntry ? <Badge>entrada</Badge> : null}
                  <Meta className="block">{c.routingDescription}</Meta>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
