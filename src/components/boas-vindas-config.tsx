"use client";

import { startTransition, useActionState, useState, useTransition } from "react";
import { Check, Copy, PlugZap, RefreshCw } from "lucide-react";
import {
  gerarEnderecoDaMacro,
  salvarConfigBoasVindas,
  salvarTokenDaNotificaMe,
  testarBoasVindas,
  type EstadoBoasVindas,
} from "@/server/actions/boas-vindas";
import { Aviso, Button, Field, Input } from "@/components/ui";
import { formatarData } from "@/lib/utils";

/**
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada, e o checkbox voltaria desmarcado — salvar de novo desligaria a
 * função sem ninguém perceber. Mesmo conserto da janela e do alerta de saldo.
 */
export function BoasVindasConfigForm({
  habilitada,
  canalId,
  template,
  parametro,
  idioma,
  caixaDoCliente,
  minutosSemReenvio,
  tetoPorHora,
  somenteLeitura,
}: {
  habilitada: boolean;
  canalId: string;
  template: string;
  parametro: string;
  idioma: string;
  caixaDoCliente: string;
  minutosSemReenvio: string;
  tetoPorHora: string;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoBoasVindas, FormData>(
    salvarConfigBoasVindas,
    {},
  );

  const [ligada, setLigada] = useState(habilitada);
  const [canal, setCanal] = useState(canalId);
  const [modelo, setModelo] = useState(template);
  const [param, setParam] = useState(parametro);
  const [lingua, setLingua] = useState(idioma);
  const [caixa, setCaixa] = useState(caixaDoCliente);
  const [minutos, setMinutos] = useState(minutosSemReenvio);
  const [teto, setTeto] = useState(tetoPorHora);

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
          disabled={somenteLeitura}
          className="size-4 accent-accent"
        />
        Envio ligado
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Canal da NotificaMe" hint="O número oficial de onde o template sai (id do canal).">
          <Input
            name="canalId"
            value={canal}
            onChange={(e) => setCanal(e.target.value)}
            disabled={somenteLeitura}
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Template" hint="Nome do template aprovado na NotificaMe.">
          <Input
            name="template"
            value={modelo}
            onChange={(e) => setModelo(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
        <Field label="Parâmetro do nome" hint="O {{…}} do corpo do template que recebe o nome do contato.">
          <Input
            name="parametro"
            value={param}
            onChange={(e) => setParam(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
        <Field label="Idioma" hint="Código do idioma do template (pt_BR).">
          <Input
            name="idioma"
            value={lingua}
            onChange={(e) => setLingua(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
        <Field
          label="Caixa do cliente"
          hint="A caixa do WhatsApp oficial: é nela que o cliente responde, e onde a nota e a atribuição valem."
        >
          <Input
            name="caixaDoCliente"
            inputMode="numeric"
            value={caixa}
            onChange={(e) => setCaixa(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
        <Field
          label="Minutos sem reenviar ao mesmo número"
          hint="De 1 a 240. Segura o clique duplo e a macro rodada duas vezes por engano."
        >
          <Input
            name="minutosSemReenvio"
            inputMode="numeric"
            value={minutos}
            onChange={(e) => setMinutos(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
        <Field label="Teto de envios por hora" hint="Freio contra laço. De 1 a 500.">
          <Input
            name="tetoPorHora"
            inputMode="numeric"
            value={teto}
            onChange={(e) => setTeto(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
      </div>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      {somenteLeitura ? null : (
        <div className="flex justify-end">
          <Button type="submit" disabled={salvando}>
            {salvando ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      )}
    </form>
  );
}

/** O token da NotificaMe: só Proprietário. O que já está guardado aparece só como máscara. */
export function TokenDaNotificaMe({ hint, podeSalvar }: { hint: string | null; podeSalvar: boolean }) {
  const [estado, salvar, salvando] = useActionState<EstadoBoasVindas, FormData>(
    salvarTokenDaNotificaMe,
    {},
  );
  const [token, setToken] = useState("");

  const enviar = (evento: React.FormEvent<HTMLFormElement>) => {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    startTransition(() => {
      salvar(dados);
      setToken("");
    });
  };

  return (
    <form onSubmit={enviar} className="space-y-2">
      <Field
        label="Token da NotificaMe"
        hint={
          hint
            ? `Guardado (${hint}). Cole outro para trocar.`
            : "Ainda não cadastrado. Fica cifrado e nunca volta para a tela."
        }
      >
        <Input
          name="token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={!podeSalvar}
        />
      </Field>
      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}
      {podeSalvar ? (
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" size="sm" disabled={salvando || token.trim().length === 0}>
            {salvando ? "Salvando…" : "Salvar token"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted">Só o papel Proprietário cadastra o token.</p>
      )}
    </form>
  );
}

/**
 * O endereço que a macro chama. Mesmo modelo do token do gatilho HTTP: o token
 * nasce aqui, aparece por inteiro UMA vez, e só o hash fica guardado. O estado
 * local some no reload, de propósito.
 */
export function EnderecoDaMacro({
  urlBase,
  geradoEm,
  podeGerar,
}: {
  /** `https://host/api/webhooks/boas-vindas` — falta só o token. */
  urlBase: string;
  geradoEm: string | null;
  podeGerar: boolean;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [ocupado, iniciar] = useTransition();

  const url = `${urlBase}/${token ?? "••••••••••••••••••••••••••••"}`;

  function copiar() {
    navigator.clipboard.writeText(url);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <span className="text-sm font-medium">Endereço da macro</span>
        <div className="flex gap-2">
          <Input readOnly value={url} className="font-mono text-xs" />
          <Button type="button" variant="secondary" disabled={!token} onClick={copiar}>
            {copiado ? <Check size={14} /> : <Copy size={14} />}
            {copiado ? "Copiado" : "Copiar"}
          </Button>
        </div>
        {token ? (
          <Aviso tone="danger">
            <strong>Copie agora.</strong> Esta é a única vez que o endereço aparece por inteiro — cole-o na macro
            antes de sair desta página. Gerar de novo troca o endereço, e o que já está cadastrado na macro deixa
            de valer.
          </Aviso>
        ) : null}
      </div>

      {podeGerar ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={ocupado}
            onClick={() =>
              iniciar(async () => {
                const r = await gerarEnderecoDaMacro();
                setErro(r.erro ?? null);
                if (r.token) setToken(r.token);
              })
            }
          >
            <RefreshCw size={14} aria-hidden />
            {ocupado ? "Gerando…" : geradoEm ? "Gerar outro endereço" : "Gerar endereço"}
          </Button>
          {geradoEm ? (
            <span className="text-xs text-muted">Endereço gerado em {formatarData(new Date(geradoEm))}.</span>
          ) : (
            <span className="text-xs text-muted">Nenhum endereço gerado ainda.</span>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">Só o papel Proprietário gera o endereço.</p>
      )}

      {erro ? <Aviso tone="danger">{erro}</Aviso> : null}
    </div>
  );
}

/** Confere token, canal e template sem mandar nada ao cliente. */
export function TestarBoasVindas({ podeTestar }: { podeTestar: boolean }) {
  const [resultado, setResultado] = useState<EstadoBoasVindas | null>(null);
  const [ocupado, iniciar] = useTransition();

  if (!podeTestar) return null;
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={ocupado}
        onClick={() =>
          iniciar(async () => {
            setResultado(await testarBoasVindas());
          })
        }
      >
        <PlugZap size={14} aria-hidden />
        {ocupado ? "Testando…" : "Testar token, canal e template"}
      </Button>
      {resultado?.erro ? <Aviso tone="danger">{resultado.erro}</Aviso> : null}
      {resultado?.ok ? <Aviso tone="success">{resultado.ok}</Aviso> : null}
    </div>
  );
}
