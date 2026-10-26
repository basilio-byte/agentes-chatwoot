"use client";

import { startTransition, useActionState, useState } from "react";
import { Copy } from "lucide-react";
import {
  gerarTokenDoColetor,
  salvarConfigOpenClaws,
  type EstadoConfigOpenClaws,
  type EstadoTokenDoColetor,
} from "@/server/actions/openclaws";
import { Aviso, Button, Field, Input, Select } from "@/components/ui";

type Conteiner = { id: string; nome: string | null; compartilhada: boolean };

const DIAS = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

/**
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada, e as caixas de "mesma conta" voltariam marcadas — salvar de novo
 * trocaria a conta de alguém sem ninguém perceber. Mesmo conserto do alerta de
 * saldo e da janela de 24 h.
 */
export function OpenClawsConfigForm({
  conteineres,
  cotaManual,
  resetDia,
  resetHora,
}: {
  conteineres: Conteiner[];
  cotaManual: number | null;
  resetDia: number;
  resetHora: number;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoConfigOpenClaws, FormData>(
    salvarConfigOpenClaws,
    {},
  );

  const [linhas, setLinhas] = useState(conteineres);
  const [cota, setCota] = useState(cotaManual == null ? "" : String(cotaManual));
  const [dia, setDia] = useState(String(resetDia));
  const [hora, setHora] = useState(String(resetHora));

  const enviar = (evento: React.FormEvent<HTMLFormElement>) => {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    startTransition(() => salvar(dados));
  };

  const mudar = (id: string, parcial: Partial<Conteiner>) =>
    setLinhas((atuais) => atuais.map((c) => (c.id === id ? { ...c, ...parcial } : c)));

  return (
    <form onSubmit={enviar} className="space-y-5">
      {linhas.length === 0 ? (
        <Aviso tone="neutral">
          Nenhum OpenClaw chegou ainda. Eles aparecem aqui sozinhos na primeira
          coleta.
        </Aviso>
      ) : (
        <div className="space-y-2">
          {linhas.map((c) => (
            <div
              key={c.id}
              className="grid items-center gap-3 rounded-lg border border-line p-3 sm:grid-cols-[5rem_1fr_auto]"
            >
              <span className="font-mono text-xs text-muted">{c.id}</span>
              <input type="hidden" name="id" value={c.id} />
              <Input
                name="nome"
                aria-label={`Nome da pessoa do OpenClaw ${c.id}`}
                placeholder="Nome da pessoa"
                maxLength={60}
                value={c.nome ?? ""}
                onChange={(e) => mudar(c.id, { nome: e.target.value })}
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="compartilhada"
                  value={c.id}
                  checked={c.compartilhada}
                  onChange={(e) => mudar(c.id, { compartilhada: e.target.checked })}
                  className="size-4 accent-accent"
                />
                Mesma conta Claude
              </label>
            </div>
          ))}
        </div>
      )}

      <Aviso tone="neutral">
        Desmarque <strong>Mesma conta Claude</strong> só para quem usa uma
        credencial própria: esse OpenClaw continua aparecendo com o consumo dele,
        mas não entra na cota dos outros nem na detecção de bloqueio.
      </Aviso>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Cota semanal (US$ equivalentes)"
          hint="Em branco usa a estimada pelos bloqueios."
        >
          <Input
            name="cotaManual"
            inputMode="decimal"
            placeholder="ex.: 1000"
            value={cota}
            onChange={(e) => setCota(e.target.value)}
          />
        </Field>
        <Field label="A cota recomeça no(a)" hint="Medido: domingo, 16h de São Paulo.">
          <Select name="resetDia" value={dia} onChange={(e) => setDia(e.target.value)}>
            {DIAS.map((nome, i) => (
              <option key={nome} value={i}>
                {nome}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Às (hora UTC)" hint="19 UTC = 16h em São Paulo.">
          <Input
            name="resetHora"
            inputMode="numeric"
            value={hora}
            onChange={(e) => setHora(e.target.value)}
          />
        </Field>
      </div>

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

/** Gera o token do coletor e o mostra uma vez. */
export function TokenDoColetor({
  temToken,
  dica,
}: {
  temToken: boolean;
  dica: string | null;
}) {
  const [estado, gerar, gerando] = useActionState<EstadoTokenDoColetor>(
    gerarTokenDoColetor,
    {},
  );
  const [copiado, setCopiado] = useState(false);

  const copiar = async () => {
    if (!estado.token) return;
    try {
      await navigator.clipboard.writeText(estado.token);
      setCopiado(true);
    } catch {
      setCopiado(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {temToken ? (
          <>
            Já existe um token (<span className="font-mono">{dica}</span>). Gerar
            outro <strong>derruba o coletor</strong> até ele receber o novo.
          </>
        ) : (
          <>Nenhum token gerado: o coletor ainda não consegue enviar nada.</>
        )}
      </p>

      {estado.token ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
            <code className="min-w-0 flex-1 text-xs break-all">{estado.token}</code>
            <Button type="button" variant="ghost" onClick={copiar}>
              <Copy size={14} aria-hidden />
              {copiado ? "Copiado" : "Copiar"}
            </Button>
          </div>
        </div>
      ) : null}

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      <Button
        type="button"
        variant={temToken ? "secondary" : "primary"}
        disabled={gerando}
        onClick={() => startTransition(() => gerar())}
      >
        {gerando ? "Gerando…" : temToken ? "Gerar outro token" : "Gerar token"}
      </Button>
    </div>
  );
}
