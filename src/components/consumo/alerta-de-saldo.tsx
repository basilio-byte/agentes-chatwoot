"use client";

import { startTransition, useActionState, useState } from "react";
import { Plus, Send, X } from "lucide-react";
import {
  salvarAlertaDeSaldo,
  testarAlertaDeSaldo,
  type EstadoDoAlerta,
  type EstadoDoTeste,
} from "@/server/actions/alerta-de-saldo";
import { Aviso, Button, Field, Input } from "@/components/ui";

type Linha = { chave: number; nome: string; telefone: string };

/**
 * Configuração do alerta de saldo por WhatsApp, na tela de Consumo.
 *
 * Uma linha por pessoa, com nome e telefone lado a lado: é o que a pessoa vai
 * conferir com os olhos antes de salvar, e uma caixa de texto com "nome,
 * telefone" por linha esconderia o erro de digitação no meio da vírgula.
 *
 * ⚠ **O envio é por `onSubmit`, nunca por `<form action>`, e não é estilo.** O
 * React 19 LIMPA o formulário depois de todo envio por `action` — inclusive
 * quando a gravação foi RECUSADA, porque a action devolve o erro em vez de
 * lançar. Com `defaultValue`, um dígito errado num dos telefones apagava tudo o
 * que tinha sido digitado; com os campos controlados, o texto sobrevivia mas o
 * checkbox não, e "Alerta ligado" aparecia desmarcado até a próxima tecla —
 * clicar em Salvar de novo gravava o alerta DESLIGADO sem ninguém perceber.
 * Achado nos dois testes de ponta a ponta de 18/09/2026.
 */
export function AlertaDeSaldoForm({
  ligado,
  limiteUsd,
  caixaId,
  destinatarios,
}: {
  ligado: boolean;
  limiteUsd: string;
  caixaId: string;
  destinatarios: { nome: string; telefone: string }[];
}) {
  const [estado, salvar, salvando] = useActionState<EstadoDoAlerta, FormData>(
    salvarAlertaDeSaldo,
    {},
  );

  const [linhas, setLinhas] = useState<Linha[]>(() => {
    const iniciais = destinatarios.map((d, i) => ({ chave: i, ...d }));
    // Sem ninguém cadastrado, a primeira linha já aparece: um formulário vazio
    // com um botão "adicionar" é um passo a mais para o que todo mundo vai fazer.
    return iniciais.length > 0 ? iniciais : [{ chave: 0, nome: "", telefone: "" }];
  });

  const acrescentar = () =>
    setLinhas((atual) => [
      ...atual,
      { chave: Math.max(-1, ...atual.map((l) => l.chave)) + 1, nome: "", telefone: "" },
    ]);
  const remover = (chave: number) =>
    setLinhas((atual) => atual.filter((l) => l.chave !== chave));
  const editar = (chave: number, campo: "nome" | "telefone", valor: string) =>
    setLinhas((atual) => atual.map((l) => (l.chave === chave ? { ...l, [campo]: valor } : l)));

  const [estaLigado, setLigado] = useState(ligado);
  const [limite, setLimite] = useState(limiteUsd);
  const [caixa, setCaixa] = useState(caixaId);

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
          name="ligado"
          checked={estaLigado}
          onChange={(e) => setLigado(e.target.checked)}
          className="size-4 accent-accent"
        />
        Alerta ligado
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Avisar quando o saldo ficar abaixo de (US$)"
          hint="Saldo zerado avisa de novo na hora, mesmo dentro das 24 h."
        >
          <Input
            name="limiteUsd"
            inputMode="decimal"
            value={limite}
            onChange={(e) => setLimite(e.target.value)}
          />
        </Field>
        <Field
          label="Caixa do Chatwoot"
          hint="Por onde a mensagem sai. A 31 (Seahub_Alternativa) é API não oficial, sem a janela de 24 h do WhatsApp."
        >
          <Input
            name="caixaId"
            inputMode="numeric"
            value={caixa}
            onChange={(e) => setCaixa(e.target.value)}
          />
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium">Quem recebe</legend>
        <p className="text-xs leading-relaxed text-muted">
          Telefone com DDD, como (84) 99999-9999. Digite o número como ele está
          no WhatsApp da pessoa — com ou sem o nono dígito — e confira com o
          teste.
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

/**
 * O botão de teste, num formulário à parte: testa o que está SALVO, e não o
 * que está digitado — senão o teste aprovaria um número que o alerta de
 * verdade nunca usaria.
 */
export function TesteDoAlerta({ podeTestar }: { podeTestar: boolean }) {
  const [estado, testar, testando] = useActionState<EstadoDoTeste, FormData>(
    testarAlertaDeSaldo,
    {},
  );

  return (
    <form action={testar} className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" disabled={testando || !podeTestar}>
          <Send size={14} aria-hidden />
          {testando ? "Enviando…" : "Enviar teste agora"}
        </Button>
        <span className="text-xs text-muted">
          {podeTestar
            ? "Manda uma mensagem de teste para os números salvos. Salve antes, se mudou alguma coisa."
            : "Salve pelo menos um telefone para poder testar."}
        </span>
      </div>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.entregas ? (
        <Aviso tone={estado.entregas.every((e) => e.ok) ? "success" : "warning"}>
          <ul className="space-y-0.5">
            {estado.entregas.map((e) => (
              <li key={e.nome}>
                <strong>{e.nome}</strong>: {e.ok ? e.detalhe : `não saiu — ${e.detalhe}`}
              </li>
            ))}
          </ul>
          <p className="mt-1.5">
            &ldquo;Entregue ao Chatwoot&rdquo; quer dizer que a mensagem entrou
            na caixa. Quem a leva ao WhatsApp é a WAHA: confirme com as pessoas
            que ela chegou.
          </p>
        </Aviso>
      ) : null}
    </form>
  );
}
