"use client";

import { startTransition, useActionState, useState } from "react";
import { Plus, X } from "lucide-react";
import { salvarConfigAvisos, type EstadoAvisos } from "@/server/actions/avisos";
import { Aviso, Button, Field, Input } from "@/components/ui";

type Linha = { chave: number; nome: string; telefone: string };

/**
 * Configuração do aviso à equipe, na tela de Integrações. Só aparece para
 * Administrador: os telefones são de pessoas.
 *
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada. Mesmo conserto do alerta de saldo e do presente de aniversário.
 */
export function AvisosConfigForm(props: {
  habilitada: boolean;
  destinatarios: { nome: string; telefone: string }[];
  caixaId: string;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoAvisos, FormData>(
    salvarConfigAvisos,
    {},
  );

  const [ligada, setLigada] = useState(props.habilitada);
  const [caixaId, setCaixaId] = useState(props.caixaId);
  const [linhas, setLinhas] = useState<Linha[]>(() => {
    const iniciais = props.destinatarios.map((d, i) => ({ chave: i, ...d }));
    return iniciais.length > 0 ? iniciais : [{ chave: 0, nome: "", telefone: "" }];
  });

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
        <legend className="text-[13px] font-medium">Quem pode receber o aviso</legend>
        <p className="text-xs leading-relaxed text-muted">
          O agente escolhe entre estes nomes — escreva o nome como ele aparece no
          prompt do agente. Telefone com DDD, como (84) 99999-9999, do jeito que
          está no WhatsApp da pessoa.
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

      <Field
        label="Caixa do aviso"
        hint="Por onde o WhatsApp sai. A 31 não tem a janela de 24 h."
      >
        <Input
          name="caixaId"
          inputMode="numeric"
          value={caixaId}
          onChange={(e) => setCaixaId(e.target.value)}
          className="max-w-32"
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
