"use client";

import { useActionState } from "react";
import { salvarConfigNps, type EstadoNps } from "@/server/actions/nps";
import { Aviso, Button, Field, Input, Textarea } from "@/components/ui";

export type ValoresNps = {
  checkbox: string;
  caixas: string;
  listasDaNota: string;
  campoDaNota: string;
  campoDoTelefone: string;
  horasAteLembrete: string;
  horasAteEncerrar: string;
  minutosAposNota: string;
  horasEntrePesquisas: string;
  textoAgradecimento: string;
  textoConvite: string;
  textoPergunta: string;
  textoLembrete: string;
  textoNotaBaixa: string;
  textoNotaAlta: string;
  automatica: boolean;
};

export function NpsConfigForm({
  valores,
  habilitada,
  somenteLeitura,
}: {
  valores: ValoresNps;
  habilitada: boolean;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoNps, FormData>(
    salvarConfigNps,
    {},
  );

  const texto = (
    nome: Exclude<keyof ValoresNps, "automatica">,
    label: string,
    linhas: number,
    hint?: string,
  ) => (
    <Field label={label} hint={hint}>
      <Textarea
        name={nome}
        rows={linhas}
        defaultValue={valores[nome]}
        disabled={somenteLeitura}
      />
    </Field>
  );

  return (
    <form action={salvar} className="space-y-5">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={habilitada}
          disabled={somenteLeitura}
          className="size-4 accent-accent"
        />
        Pesquisa ligada
      </label>

      <div className="space-y-1">
        {/* Diz ao servidor que esta tela mostrou a caixa: formulário antigo, sem
            ela, não desliga a pesquisa automática por engano. */}
        <input type="hidden" name="automaticaNaTela" value="1" />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="automatica"
            defaultChecked={valores.automatica}
            disabled={somenteLeitura}
            className="size-4 accent-accent"
          />
          Também no fim dos atendimentos feitos só pelo robô
        </label>
        <p className="pl-6 text-xs text-muted">
          Quem decide quando é o agente: depois de concluir o pedido, ele registra o
          prazo do cliente com a ação “pesquisa”. Desligada aqui, esse prazo só
          resolve a conversa.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Checkbox que manda a pesquisa"
          hint="A chave do atributo da conversa, como está no Chatwoot."
        >
          <Input name="checkbox" defaultValue={valores.checkbox} disabled={somenteLeitura} />
        </Field>
        <Field label="Caixas" hint="O número de cada caixa do Chatwoot, separados por vírgula.">
          <Input name="caixas" defaultValue={valores.caixas} disabled={somenteLeitura} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Horas até o lembrete" hint="Sem nota, o lembrete sai uma vez.">
          <Input
            name="horasAteLembrete"
            inputMode="decimal"
            defaultValue={valores.horasAteLembrete}
            disabled={somenteLeitura}
          />
        </Field>
        <Field label="Horas até resolver sem nota" hint="Contadas a partir do lembrete.">
          <Input
            name="horasAteEncerrar"
            inputMode="decimal"
            defaultValue={valores.horasAteEncerrar}
            disabled={somenteLeitura}
          />
        </Field>
        <Field
          label="Minutos até resolver depois da nota"
          hint="Contados da última mensagem do cliente: cada complemento recomeça o prazo."
        >
          <Input
            name="minutosAposNota"
            inputMode="numeric"
            defaultValue={valores.minutosAposNota}
            disabled={somenteLeitura}
          />
        </Field>
        <Field
          label="Intervalo por telefone (horas)"
          hint="O mesmo telefone não recebe a pesquisa de novo neste intervalo. 0 desliga."
        >
          <Input
            name="horasEntrePesquisas"
            inputMode="numeric"
            defaultValue={valores.horasEntrePesquisas}
            disabled={somenteLeitura}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {texto(
          "listasDaNota",
          "Listas do CRM onde gravar a nota",
          2,
          "Apelido cadastrado no ClickUp ou id da lista, uma por linha.",
        )}
        <div className="space-y-4">
          <Field label="Campo da nota">
            <Input name="campoDaNota" defaultValue={valores.campoDaNota} disabled={somenteLeitura} />
          </Field>
          <Field label="Campo do telefone">
            <Input
              name="campoDoTelefone"
              defaultValue={valores.campoDoTelefone}
              disabled={somenteLeitura}
            />
          </Field>
        </div>
      </div>

      <div className="space-y-4 border-t border-line pt-4">
        <p className="text-sm text-muted">
          Os textos saem nesta ordem: os três primeiros juntos, ao marcar o
          checkbox; o lembrete, se não houver nota; a resposta, conforme a nota.
        </p>
        {texto("textoAgradecimento", "1. Agradecimento", 3)}
        {texto("textoConvite", "2. Convite", 2)}
        {texto("textoPergunta", "3. Pergunta", 7)}
        {texto("textoLembrete", "Lembrete", 5)}
        {texto("textoNotaBaixa", "Resposta à nota de 1 a 3", 4)}
        {texto("textoNotaAlta", "Resposta à nota 4 ou 5", 4)}
      </div>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      {!somenteLeitura ? (
        <Button size="sm" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar"}
        </Button>
      ) : null}
    </form>
  );
}
