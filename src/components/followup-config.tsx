"use client";

import { useActionState } from "react";
import { salvarConfigFollowup, type EstadoFollowup } from "@/server/actions/followup-reserva";
import { Aviso, Button, Field, Input, Select, Textarea } from "@/components/ui";

export type ValoresFollowup = {
  modo: "sombra" | "ligado";
  horasAntesDoInicio: string;
  minutosAposReserva: string;
  horaDeInicio: string;
  horaDeFim: string;
  texto: string;
};

export function FollowupConfigForm({
  valores,
  habilitada,
  somenteLeitura,
}: {
  valores: ValoresFollowup;
  habilitada: boolean;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoFollowup, FormData>(
    salvarConfigFollowup,
    {},
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
        Follow-up ligado
      </label>

      <Field
        label="Modo"
        hint="Em sombra, a rodada confere tudo e registra o que faria, sem mandar nada. Ligado manda a mensagem ao cliente."
      >
        <Select name="modo" defaultValue={valores.modo} disabled={somenteLeitura}>
          <option value="sombra">Sombra — só registra</option>
          <option value="ligado">Ligado — manda ao cliente</option>
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Horas antes do início"
          hint="O mais perto do horário que a mensagem sai. Sai antes se a janela de 24 h do WhatsApp fosse fechar."
        >
          <Input
            name="horasAntesDoInicio"
            inputMode="decimal"
            defaultValue={valores.horasAntesDoInicio}
            disabled={somenteLeitura}
          />
        </Field>
        <Field
          label="Minutos depois de reservar"
          hint="Nunca antes disto: o cliente acabou de receber a confirmação."
        >
          <Input
            name="minutosAposReserva"
            inputMode="numeric"
            defaultValue={valores.minutosAposReserva}
            disabled={somenteLeitura}
          />
        </Field>
        <Field label="Envio a partir de (hora)" hint="Horário de São Paulo.">
          <Input
            name="horaDeInicio"
            inputMode="numeric"
            defaultValue={valores.horaDeInicio}
            disabled={somenteLeitura}
          />
        </Field>
        <Field label="Envio até antes de (hora)" hint="Às 20h, por exemplo, a última sai às 19h59.">
          <Input
            name="horaDeFim"
            inputMode="numeric"
            defaultValue={valores.horaDeFim}
            disabled={somenteLeitura}
          />
        </Field>
      </div>

      <Field
        label="Mensagem ao cliente"
        hint="Marcadores: {nome} (primeiro nome; sem nome, “Oi, {nome}!” vira “Oi!”), {sala}, {data}, {inicio}, {fim}, {valor} e {link}, que é obrigatório."
      >
        <Textarea name="texto" rows={11} defaultValue={valores.texto} disabled={somenteLeitura} />
      </Field>

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
