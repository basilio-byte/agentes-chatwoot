"use client";

import { startTransition, useActionState, useState } from "react";
import {
  definirMotorDoAgenteAction,
  salvarMotorGlobalAction,
  type EstadoDoMotor,
} from "@/server/actions/motor";
import { Aviso, Button, Field, Select } from "@/components/ui";

type Modelo = { id: string; nome: string };

/**
 * Envio por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois do envio mesmo quando a gravação é recusada, e um select
 * limpo volta para a PRIMEIRA opção — a chave geral voltaria para "OpenRouter"
 * sem ninguém pedir. Mesma lição do alerta de saldo (18/09/2026).
 */
function useEnvio(
  acao: (estado: EstadoDoMotor, dados: FormData) => Promise<EstadoDoMotor>,
) {
  const [estado, despachar, enviando] = useActionState<EstadoDoMotor, FormData>(acao, {});
  const enviar = (evento: React.FormEvent<HTMLFormElement>) => {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    startTransition(() => despachar(dados));
  };
  return { estado, enviar, enviando };
}

/**
 * Um `<select>` com valor sem opção correspondente exibe a primeira e ENVIA
 * ela (regra do projeto). O modelo gravado entra na lista mesmo que o proxy não
 * o anuncie mais, marcado, em vez de ser trocado em silêncio no próximo salvar.
 */
function comOGravado(modelos: Modelo[], gravado: string | null): Modelo[] {
  if (!gravado || modelos.some((m) => m.id === gravado)) return modelos;
  return [{ id: gravado, nome: `${gravado} (o proxy não anuncia mais)` }, ...modelos];
}

export function MotorDosAgentesForm({
  ligado,
  modeloPadrao,
  modelos,
  configurado,
  somenteLeitura,
}: {
  ligado: boolean;
  modeloPadrao: string;
  modelos: Modelo[];
  configurado: boolean;
  somenteLeitura: boolean;
}) {
  const { estado, enviar, enviando } = useEnvio(salvarMotorGlobalAction);
  const [motor, setMotor] = useState(ligado ? "CLAUDE_MAX" : "OPENROUTER");
  const [modelo, setModelo] = useState(modeloPadrao);
  const bloqueado = somenteLeitura || !configurado;

  return (
    <form onSubmit={enviar} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Chave geral"
          hint="Vale para todo agente que segue a chave geral. Agente fixado num motor não muda."
        >
          <Select value={motor} onChange={(e) => setMotor(e.target.value)} disabled={bloqueado}>
            <option value="OPENROUTER">OpenRouter</option>
            <option value="CLAUDE_MAX">Claude MAX (proxy da assinatura)</option>
          </Select>
        </Field>
        <Field
          label="Modelo padrão no Claude MAX"
          hint="Para quem não escolheu um modelo próprio na tela do agente."
        >
          <Select
            name="modeloPadrao"
            value={modelo}
            onChange={(e) => setModelo(e.target.value)}
            disabled={bloqueado}
          >
            {comOGravado(modelos, modeloPadrao).map((m) => (
              <option key={m.id} value={m.id}>
                {m.nome}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {motor === "CLAUDE_MAX" ? <input type="hidden" name="claudeMaxLigado" value="on" /> : null}

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      {bloqueado ? null : (
        <div className="flex justify-end">
          <Button type="submit" disabled={enviando}>
            {enviando ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      )}
    </form>
  );
}

export function MotorDoAgenteForm({
  agentId,
  motor: motorGravado,
  modeloClaudeMax,
  modeloPadrao,
  modelos,
  configurado,
  somenteLeitura,
}: {
  agentId: string;
  motor: string;
  modeloClaudeMax: string | null;
  modeloPadrao: string;
  modelos: Modelo[];
  configurado: boolean;
  somenteLeitura: boolean;
}) {
  const { estado, enviar, enviando } = useEnvio(definirMotorDoAgenteAction.bind(null, agentId));
  const [motor, setMotor] = useState(motorGravado);
  const [modelo, setModelo] = useState(modeloClaudeMax ?? "");

  return (
    <form onSubmit={enviar} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Motor deste agente">
          <Select
            name="motor"
            value={motor}
            onChange={(e) => setMotor(e.target.value)}
            disabled={somenteLeitura}
          >
            <option value="PADRAO">Segue a chave geral</option>
            <option value="OPENROUTER">Sempre OpenRouter</option>
            <option value="CLAUDE_MAX" disabled={!configurado && motorGravado !== "CLAUDE_MAX"}>
              Sempre Claude MAX
            </option>
          </Select>
        </Field>
        <Field
          label="Modelo no Claude MAX"
          hint="O modelo da OpenRouter, no formulário abaixo, continua valendo: é para ele que a chamada volta se o proxy falhar."
        >
          <Select
            name="modeloClaudeMax"
            value={modelo}
            onChange={(e) => setModelo(e.target.value)}
            disabled={somenteLeitura}
          >
            <option value="">Padrão geral ({modeloPadrao})</option>
            {comOGravado(modelos, modeloClaudeMax).map((m) => (
              <option key={m.id} value={m.id}>
                {m.nome}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      {somenteLeitura ? null : (
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" disabled={enviando}>
            {enviando ? "Salvando…" : "Salvar motor"}
          </Button>
        </div>
      )}
    </form>
  );
}
