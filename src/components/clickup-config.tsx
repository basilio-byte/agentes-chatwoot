"use client";

import { useActionState, useState, useTransition } from "react";
import { Plug, Search } from "lucide-react";
import {
  descobrirWorkspaces,
  salvarConfigClickUp,
  salvarTokenClickUp,
  testarConexaoClickUp,
  type EstadoClickUp,
} from "@/server/actions/clickup";
import { Aviso, Button, Field, Input, Textarea } from "@/components/ui";

export function ClickUpConfigForm({
  teamId,
  defaultListId,
  spaceIds,
  listasNomeadas,
  habilitada,
  temToken,
  hintToken,
  somenteLeitura,
  podeEditarCredencial,
}: {
  teamId: string;
  defaultListId: string;
  spaceIds: string;
  listasNomeadas: string;
  habilitada: boolean;
  temToken: boolean;
  hintToken: string | null;
  somenteLeitura: boolean;
  podeEditarCredencial: boolean;
}) {
  const [estadoConfig, salvarConfig, salvandoConfig] = useActionState<
    EstadoClickUp,
    FormData
  >(salvarConfigClickUp, {});
  const [estadoToken, salvarToken, salvandoToken] = useActionState<
    EstadoClickUp,
    FormData
  >(salvarTokenClickUp, {});

  const [teste, setTeste] = useState<EstadoClickUp | null>(null);
  const [workspaces, setWorkspaces] = useState<
    Array<{ id: string; nome: string }> | null
  >(null);
  const [ocupado, iniciar] = useTransition();

  const erroConfig = (c: string) => estadoConfig.camposComErro?.[c];

  return (
    <div className="space-y-5">
      <form action={salvarToken} className="space-y-3">
        <Field
          label="Token pessoal da API"
          hint={
            temToken
              ? `Salvo: ${hintToken}. Preencha de novo só para rotacionar.`
              : "No ClickUp: foto do perfil → Settings → Apps → API Token. Começa com pk_."
          }
          erro={estadoToken.camposComErro?.apiToken}
        >
          <Input
            name="apiToken"
            type="password"
            placeholder={temToken ? "••••••••" : "pk_..."}
            disabled={!podeEditarCredencial}
            required
          />
        </Field>

        {estadoToken.erro ? <Aviso tone="danger">{estadoToken.erro}</Aviso> : null}
        {estadoToken.ok ? <Aviso>{estadoToken.ok}</Aviso> : null}

        {podeEditarCredencial ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={salvandoToken}>
              {salvandoToken ? "Salvando…" : "Salvar token"}
            </Button>

            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={ocupado || !temToken}
              onClick={() =>
                iniciar(async () => {
                  const r = await descobrirWorkspaces();
                  setWorkspaces(r.workspaces ?? null);
                  setTeste(r);
                })
              }
            >
              <Search size={14} aria-hidden />
              Descobrir workspaces
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">Só o papel OWNER edita credenciais.</p>
        )}
      </form>

      {workspaces?.length ? (
        <div className="rounded-md border border-line p-3 text-sm">
          <p className="mb-1 font-medium">Workspaces deste token</p>
          <ul className="space-y-0.5">
            {workspaces.map((w) => (
              <li key={w.id} className="flex gap-2 text-muted">
                <code className="font-mono">{w.id}</code>
                <span>{w.nome}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form action={salvarConfig} className="space-y-4 border-t border-line pt-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Id do workspace"
            hint="Use o botão acima para descobrir."
            erro={erroConfig("teamId")}
          >
            <Input
              name="teamId"
              defaultValue={teamId}
              disabled={somenteLeitura}
              required
            />
          </Field>

          <Field
            label="Lista padrão (opcional)"
            hint="Onde o agente cria tarefas quando não especificar a lista."
          >
            <Input
              name="defaultListId"
              defaultValue={defaultListId}
              disabled={somenteLeitura}
            />
          </Field>
        </div>

        <Field
          label="Espaços permitidos (opcional)"
          hint="Ids separados por vírgula. Vazio = workspace inteiro. Use para não expor espaços internos ao atendimento."
        >
          <Input
            name="spaceIds"
            defaultValue={spaceIds}
            placeholder="90210, 90211"
            disabled={somenteLeitura}
          />
        </Field>

        <Field
          label="Listas com apelido (opcional)"
          hint="Uma por linha, no formato nome = id. Serve para o prompt dizer 'crie a tarefa em CRM Comercial' em vez de colar o id cru — que muda se a lista for recriada e ninguém consegue revisar."
        >
          <Textarea
            name="listasNomeadas"
            defaultValue={listasNomeadas}
            rows={3}
            placeholder={"CRM Comercial = 901302419821\nSuporte = 901302419900"}
            disabled={somenteLeitura}
            className="font-mono text-[13px]"
          />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={habilitada}
            disabled={somenteLeitura}
            className="size-4"
          />
          Integração ligada
        </label>

        {estadoConfig.erro ? <Aviso tone="danger">{estadoConfig.erro}</Aviso> : null}
        {estadoConfig.ok ? <Aviso>{estadoConfig.ok}</Aviso> : null}

        {!somenteLeitura ? (
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={salvandoConfig}>
              {salvandoConfig ? "Salvando…" : "Salvar configuração"}
            </Button>

            <Button
              type="button"
              variant="secondary"
              disabled={ocupado || !temToken}
              onClick={() => iniciar(async () => setTeste(await testarConexaoClickUp()))}
            >
              <Plug size={14} aria-hidden />
              Testar conexão
            </Button>
          </div>
        ) : null}
      </form>

      {teste?.erro ? <Aviso tone="danger">{teste.erro}</Aviso> : null}
      {teste?.ok && !workspaces ? <Aviso>{teste.ok}</Aviso> : null}
    </div>
  );
}
