"use client";

import { useActionState } from "react";
import type { EstadoFormulario } from "@/server/actions/agents";
import { MODELO_PADRAO, type ModeloCatalogo } from "@/server/agents/catalogo";
import { SeletorModelo } from "@/components/seletor-modelo";
import { Aviso, Button, Card, Field, Input, Textarea } from "@/components/ui";

export type ValoresAgente = {
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  effort: string;
  maxTokens: number;
  maxToolIterations: number;
};

const PADRAO: ValoresAgente = {
  name: "",
  description: "",
  systemPrompt:
    "Você é um atendente da Seahub Coworking. Responda em português do Brasil, com objetividade e cordialidade.\n\nRegras:\n- Só afirme o que você tem certeza. Se não souber, diga que vai verificar e transfira para um humano.\n- Nunca invente valores, prazos ou disponibilidade.\n- Respostas curtas: no máximo 3 parágrafos.",
  model: MODELO_PADRAO,
  effort: "medium",
  maxTokens: 4096,
  maxToolIterations: 8,
};

export function AgenteForm({
  acao,
  modelos,
  valores = PADRAO,
  rotuloEnvio,
  somenteLeitura = false,
}: {
  acao: (
    estado: EstadoFormulario,
    formData: FormData,
  ) => Promise<EstadoFormulario>;
  modelos: ModeloCatalogo[];
  valores?: ValoresAgente;
  rotuloEnvio: string;
  somenteLeitura?: boolean;
}) {
  const [estado, submeter, pendente] = useActionState<
    EstadoFormulario,
    FormData
  >(acao, {});
  const erroDe = (campo: string) => estado.camposComErro?.[campo];

  return (
    <form action={submeter} className="space-y-5">
      <Card className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome" hint={erroDe("name")}>
            <Input
              name="name"
              defaultValue={valores.name}
              required
              disabled={somenteLeitura}
            />
          </Field>

          <Field label="Descrição (opcional)" hint={erroDe("description")}>
            <Input
              name="description"
              defaultValue={valores.description}
              disabled={somenteLeitura}
            />
          </Field>
        </div>

        <Field
          label="Prompt do agente"
          hint={
            erroDe("systemPrompt") ??
            "Define o comportamento. Evite datas ou identificadores dinâmicos aqui — isso invalida o cache do provedor e encarece cada mensagem."
          }
        >
          <Textarea
            name="systemPrompt"
            defaultValue={valores.systemPrompt}
            rows={16}
            required
            disabled={somenteLeitura}
            className="font-mono text-[13px]"
          />
        </Field>
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Modelo e custo</h2>
          <p className="text-xs text-muted">
            Catálogo da OpenRouter. Os preços vêm da API deles.
          </p>
        </div>

        {erroDe("model") ? <Aviso tone="danger">{erroDe("model")}</Aviso> : null}

        <SeletorModelo
          modelos={modelos}
          modeloInicial={valores.model}
          effortInicial={valores.effort}
          somenteLeitura={somenteLeitura}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Máximo de tokens por resposta"
            hint={
              erroDe("maxTokens") ??
              "Inclui o raciocínio, nos modelos que raciocinam."
            }
          >
            <Input
              name="maxTokens"
              type="number"
              min={256}
              max={200000}
              defaultValue={valores.maxTokens}
              disabled={somenteLeitura}
            />
          </Field>

          <Field
            label="Máximo de rodadas de tool"
            hint={
              erroDe("maxToolIterations") ??
              "Teto de segurança: impede loop infinito de chamadas."
            }
          >
            <Input
              name="maxToolIterations"
              type="number"
              min={1}
              max={20}
              defaultValue={valores.maxToolIterations}
              disabled={somenteLeitura}
            />
          </Field>
        </div>
      </Card>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}

      {!somenteLeitura ? (
        <Button type="submit" disabled={pendente}>
          {pendente ? "Salvando…" : rotuloEnvio}
        </Button>
      ) : null}
    </form>
  );
}
