"use client";

import { startTransition, useActionState, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  salvarConfigAniversario,
  type EstadoAniversario,
} from "@/server/actions/aniversario";
import { Aviso, Button, Field, Input, Textarea } from "@/components/ui";

type Linha = { chave: number; nome: string; telefone: string };

/**
 * Configuração do presente de aniversário, na tela de Integrações. Só aparece
 * para Administrador: os telefones são de pessoas.
 *
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada. Mesmo conserto do alerta de saldo e dos Materiais.
 */
export function AniversarioConfigForm(props: {
  habilitada: boolean;
  avisar: { nome: string; telefone: string }[];
  caixaDoAviso: string;
  atendente: string;
  prazoHoras: string;
  diasDepois: string;
  confirmacao: string;
  entrega: string;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoAniversario, FormData>(
    salvarConfigAniversario,
    {},
  );

  const [ligada, setLigada] = useState(props.habilitada);
  const [linhas, setLinhas] = useState<Linha[]>(() => {
    const iniciais = props.avisar.map((d, i) => ({ chave: i, ...d }));
    return iniciais.length > 0 ? iniciais : [{ chave: 0, nome: "", telefone: "" }];
  });
  const [campos, setCampos] = useState({
    caixaDoAviso: props.caixaDoAviso,
    atendente: props.atendente,
    prazoHoras: props.prazoHoras,
    diasDepois: props.diasDepois,
    confirmacao: props.confirmacao,
    entrega: props.entrega,
  });
  const mudar = (campo: keyof typeof campos) => (valor: string) =>
    setCampos((atual) => ({ ...atual, [campo]: valor }));

  const acrescentar = () =>
    setLinhas((atual) => [
      ...atual,
      { chave: Math.max(-1, ...atual.map((l) => l.chave)) + 1, nome: "", telefone: "" },
    ]);
  const remover = (chave: number) => setLinhas((atual) => atual.filter((l) => l.chave !== chave));
  const editar = (chave: number, campo: "nome" | "telefone", valor: string) =>
    setLinhas((atual) => atual.map((l) => (l.chave === chave ? { ...l, [campo]: valor } : l)));

  const enviar = (evento: React.FormEvent<HTMLFormElement>) => {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    startTransition(() => salvar(dados));
  };

  return (
    <form onSubmit={enviar} className="space-y-5">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          checked={ligada}
          onChange={(e) => setLigada(e.target.checked)}
          className="size-4 accent-accent"
        />
        Integração ligada
      </label>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium">Quem recebe o aviso por WhatsApp</legend>
        <p className="text-xs leading-relaxed text-muted">
          Quem lança e fatura o pacote no Conexa. Telefone com DDD, como (84)
          99999-9999, do jeito que está no WhatsApp da pessoa.
        </p>
        <div className="space-y-2">
          {linhas.map((linha, i) => (
            <div key={linha.chave} className="flex items-center gap-2">
              <Input
                name="nome"
                placeholder="Nome"
                aria-label={`Nome da pessoa ${i + 1}`}
                value={linha.nome}
                onChange={(e) => editar(linha.chave, "nome", e.target.value)}
                className="min-w-0 flex-1"
              />
              <Input
                name="telefone"
                placeholder="(84) 99999-9999"
                inputMode="tel"
                aria-label={`Telefone da pessoa ${i + 1}`}
                value={linha.telefone}
                onChange={(e) => editar(linha.chave, "telefone", e.target.value)}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => remover(linha.chave)}
                aria-label={`Tirar a pessoa ${i + 1}`}
                title="Tirar"
                className="shrink-0 px-2"
              >
                <X size={14} aria-hidden />
              </Button>
            </div>
          ))}
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={acrescentar}>
          <Plus size={14} aria-hidden />
          Adicionar pessoa
        </Button>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Quem assume a conversa"
          hint="Quando o prazo vence ou a reserva não dá certo. O nome como está no Chatwoot."
        >
          <Input
            name="atendente"
            value={campos.atendente}
            onChange={(e) => mudar("atendente")(e.target.value)}
          />
        </Field>
        <Field
          label="Caixa do aviso"
          hint="Por onde o WhatsApp à equipe sai. A 31 não tem a janela de 24 h."
        >
          <Input
            name="caixaDoAviso"
            inputMode="numeric"
            value={campos.caixaDoAviso}
            onChange={(e) => mudar("caixaDoAviso")(e.target.value)}
          />
        </Field>
        <Field
          label="Prazo para liberar o pacote (horas)"
          hint="Sem o pacote pago até lá, a conversa vai para quem assume. Nunca passa de 30 min antes da reserva."
        >
          <Input
            name="prazoHoras"
            inputMode="numeric"
            value={campos.prazoHoras}
            onChange={(e) => mudar("prazoHoras")(e.target.value)}
          />
        </Field>
        <Field
          label="Vale até quantos dias depois do aniversário"
          hint="O e-mail sai no dia; o pedido vem depois."
        >
          <Input
            name="diasDepois"
            inputMode="numeric"
            value={campos.diasDepois}
            onChange={(e) => mudar("diasDepois")(e.target.value)}
          />
        </Field>
      </div>

      <Field
        label="Confirmação ao cliente"
        hint="Sai quando a reserva é feita. {sala}, {data}, {inicio} e {fim} viram os dados da reserva."
      >
        <Textarea
          name="confirmacao"
          rows={3}
          value={campos.confirmacao}
          onChange={(e) => mudar("confirmacao")(e.target.value)}
        />
      </Field>
      <Field
        label="Aviso ao cliente quando a conversa vai para a equipe"
        hint="Sai antes de atribuir, quando o prazo vence ou a reserva não dá certo."
      >
        <Textarea
          name="entrega"
          rows={2}
          value={campos.entrega}
          onChange={(e) => mudar("entrega")(e.target.value)}
        />
      </Field>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      <div className="flex justify-end">
        <Button type="submit" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </form>
  );
}
