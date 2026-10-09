"use client";

import { startTransition, useActionState, useState } from "react";
import {
  salvarConfigNotasFiscais,
  type EstadoNotasFiscais,
} from "@/server/actions/notas-fiscais";
import { Aviso, Button, Field, Input, Select, Textarea } from "@/components/ui";
import {
  EXIGE_NFSE_REFERENCIADA,
  ROTULO_DO_TIPO_DE_OPERACAO,
  TIPOS_DE_OPERACAO,
  type TipoDeOperacao,
} from "@/lib/tipos-de-operacao";

export type LinhaDeCategoria = {
  id: number;
  nome: string;
  /** Nomes das unidades do Conexa a que a categoria pertence. */
  empresas: string;
  ativa: boolean;
  codigo: string;
  /** Tem código gravado, mas o Conexa não a devolveu agora. */
  sumiu?: boolean;
};

/**
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada. Mesmo conserto da cobrança, da janela e do alerta de saldo.
 */
export function NotasFiscaisConfigForm({
  versao,
  habilitada,
  inicio,
  categorias,
  codigoReservaDeSala,
  codigoSemVenda,
  clientes,
  produtos,
  emissao,
  chaves,
  emailNoServidor,
  somenteLeitura,
}: {
  /** A impressão digital da configuração gravada quando a tela foi aberta: o servidor recusa o que ficou para trás. */
  versao: string;
  habilitada: boolean;
  inicio: string;
  categorias: LinhaDeCategoria[];
  codigoReservaDeSala: string;
  codigoSemVenda: string;
  clientes: string;
  produtos: string;
  emissao: {
    ligada: boolean;
    soCobrancas: string;
    aPartirDe: string;
    enviarEmailAoCliente: boolean;
    emailsDeAviso: string;
    cautela: string;
    /** Por que o sistema desligou a emissão sozinho (nulo = não desligou). */
    pausadaMotivo: string | null;
    /** Códigos em espera, separados por espaço (ex.: "10.05.01"). */
    codigosEmEspera: string;
    /** Quantas cobranças pagas estão retidas agora por causa deles. */
    retidas: number;
    /** Tipo de operação (tpOper) da nota emitida na quitação e na geração. */
    tipoQuitacao: TipoDeOperacao;
    tipoGeracao: TipoDeOperacao;
  };
  /** Se a chave de cada empresa está no servidor (nunca o valor). */
  chaves: Record<string, boolean>;
  /** Se a Resend (chave e remetente) está no servidor. */
  emailNoServidor: boolean;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoNotasFiscais, FormData>(
    salvarConfigNotasFiscais,
    {},
  );

  const [ligada, setLigada] = useState(habilitada);
  const [dia, setDia] = useState(inicio);
  const [codigos, setCodigos] = useState<Record<number, string>>(
    Object.fromEntries(categorias.map((c) => [c.id, c.codigo])),
  );
  const [sala, setSala] = useState(codigoReservaDeSala);
  const [semVenda, setSemVenda] = useState(codigoSemVenda);
  const [regras, setRegras] = useState(clientes);
  const [produtosTexto, setProdutosTexto] = useState(produtos);
  const [emitir, setEmitir] = useState(emissao.ligada);
  const [liberadas, setLiberadas] = useState(emissao.soCobrancas);
  const [corte, setCorte] = useState(emissao.aPartirDe);
  const [emailAoCliente, setEmailAoCliente] = useState(emissao.enviarEmailAoCliente);
  const [avisos, setAvisos] = useState(emissao.emailsDeAviso);
  const [cautela, setCautela] = useState(emissao.cautela);
  const [espera, setEspera] = useState(emissao.codigosEmEspera);
  const [tipoQuitacao, setTipoQuitacao] = useState<TipoDeOperacao>(emissao.tipoQuitacao);
  const [tipoGeracao, setTipoGeracao] = useState<TipoDeOperacao>(emissao.tipoGeracao);

  const enviar = (evento: React.FormEvent<HTMLFormElement>) => {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    startTransition(() => salvar(dados));
  };

  return (
    <form onSubmit={enviar} className="space-y-5">
      <input type="hidden" name="versao" value={estado.versao ?? versao} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          checked={ligada}
          onChange={(e) => setLigada(e.target.checked)}
          disabled={somenteLeitura}
          className="size-4 accent-accent"
        />
        Modo sombra ligado
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Cobranças pagas a partir de"
          hint="Vazio = a partir de hoje. A conferência nunca volta mais que 7 dias."
        >
          <Input
            type="date"
            name="inicio"
            value={dia}
            onChange={(e) => setDia(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
        <Field
          label="Código da reserva de sala"
          hint="O item de reserva não tem categoria no Conexa: o “produto” dele é a sala."
        >
          <Input
            name="codigoReservaDeSala"
            placeholder="03.03.02"
            value={sala}
            onChange={(e) => setSala(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
        <Field
          label="Código da cobrança sem venda"
          hint="Parcela de venda parcelada e pagamento de renegociação não têm venda ligada. Vazio = ficam em conferência."
        >
          <Input
            name="codigoSemVenda"
            placeholder="03.03.02"
            value={semVenda}
            onChange={(e) => setSemVenda(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium">Código de serviço por categoria do Conexa</legend>
        <p className="text-xs text-muted">
          Categoria sem código deixa a cobrança <strong>aguardando classificação</strong>: o
          código nunca é adivinhado. Formato 03.03.02.
        </p>
        {categorias.length === 0 ? (
          <p className="text-sm text-muted">Nenhuma categoria para mostrar.</p>
        ) : (
          <div className="divide-y divide-line rounded-lg border border-line">
            {categorias.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{c.nome}</span>
                  <span className="ml-2 text-xs text-muted tabular-nums">#{c.id}</span>
                  <span className="block truncate text-xs text-muted">
                    {[c.empresas, c.ativa ? null : "inativa", c.sumiu ? "não veio do Conexa agora" : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <Input
                  name={`codigo_${c.id}`}
                  aria-label={`Código de ${c.nome}`}
                  placeholder="sem código"
                  value={codigos[c.id] ?? ""}
                  onChange={(e) => setCodigos((atual) => ({ ...atual, [c.id]: e.target.value }))}
                  disabled={somenteLeitura}
                  className="w-32 shrink-0 tabular-nums"
                />
              </div>
            ))}
          </div>
        )}
      </fieldset>

      <Field
        label="Regras por produto"
        hint={
          <>
            Vencem a categoria. Uma por linha: id do produto no Conexa, espaço, e{" "}
            <strong>sem nota</strong> (não leva nota de serviço), <strong>conferir</strong> (uma
            pessoa decide) ou um código como <code>03.03.02</code>, e uma observação opcional. Ex.:{" "}
            <code>2799 sem nota Red Bull</code>. Só vale para produto do cadastro — não para
            reserva de sala.
          </>
        }
      >
        <Textarea
          name="produtos"
          rows={6}
          value={produtosTexto}
          onChange={(e) => setProdutosTexto(e.target.value)}
          disabled={somenteLeitura}
          className="font-mono text-[13px]"
        />
      </Field>

      <Field
        label="Regras por cliente"
        hint={
          <>
            Uma por linha: id do cliente no Conexa, espaço, <strong>antes</strong> (nota na
            geração da cobrança) ou <strong>nunca</strong> (sem nota automática), e uma
            observação opcional. Ex.: <code>3245 antes paga depois de receber a nota</code>.
          </>
        }
      >
        <Textarea
          name="clientes"
          rows={5}
          value={regras}
          onChange={(e) => setRegras(e.target.value)}
          disabled={somenteLeitura}
          className="font-mono text-[13px]"
        />
      </Field>

      <fieldset className="space-y-3 rounded-lg border border-line p-4">
        <legend className="px-1 text-[13px] font-medium">Emissão de verdade (Spedy)</legend>
        <Aviso tone="warning">
          Ligada, o sistema <strong>emite nota fiscal real</strong>. Não existe ambiente de teste na
          Spedy: cada nota gasta um número da sequência da empresa. Enquanto o n8n estiver emitindo,
          libere só as cobranças que ele <strong>não</strong> vai emitir, senão a nota sai em dobro.
        </Aviso>

        {emissao.pausadaMotivo ? (
          <Aviso tone="danger">
            <strong>O sistema desligou a emissão sozinho:</strong> {emissao.pausadaMotivo}. Confira a lista de
            notas abaixo, resolva a causa e só então ligue de novo (salvar esta tela apaga este aviso).
          </Aviso>
        ) : null}

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {Object.entries(chaves).map(([empresa, presente]) => (
            <span key={empresa} className={presente ? "" : "text-danger"}>
              Chave {empresa}: {presente ? "no servidor" : "FALTA no servidor"}
            </span>
          ))}
        </div>
        {Object.values(chaves).some((p) => !p) ? (
          <p className="text-xs text-muted">
            A chave de cada empresa é uma variável do servidor (<code>SPEDY_KEY_SEAHUB</code> e{" "}
            <code>SPEDY_KEY_SEATECH</code>), não um campo desta tela. Sem ela a empresa não emite.
          </p>
        ) : null}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="emissaoLigada"
            checked={emitir}
            onChange={(e) => setEmitir(e.target.checked)}
            disabled={somenteLeitura}
            className="size-4 accent-accent"
          />
          Emitir as notas na Spedy
        </label>

        <Field
          label="Cobranças liberadas"
          hint={
            <>
              Ids das cobranças do Conexa, separados por espaço, vírgula ou linha. Com lista, só
              estas são emitidas — é assim que se faz a <strong>primeira nota real</strong>, numa
              cobrança escolhida e pequena.
            </>
          }
        >
          <Input
            name="soCobrancas"
            placeholder="31450 31451"
            value={liberadas}
            onChange={(e) => setLiberadas(e.target.value)}
            disabled={somenteLeitura}
            className="tabular-nums"
          />
        </Field>

        <Field
          label="Corte com o n8n (sem lista)"
          hint="Sem lista, só emite cobrança paga a partir deste dia. O que foi pago antes já teve a nota do n8n: emitir de novo seria nota em dobro."
        >
          <Input
            type="date"
            name="aPartirDe"
            value={corte}
            onChange={(e) => setCorte(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enviarEmailAoCliente"
            checked={emailAoCliente}
            onChange={(e) => setEmailAoCliente(e.target.checked)}
            disabled={somenteLeitura}
            className="size-4 accent-accent"
          />
          Spedy envia a nota por e-mail ao cliente (o n8n já faz isso)
        </label>

        <Field
          label="Cautela: primeiras notas conferidas uma a uma"
          hint="Enquanto menos que este número de notas nossas tiverem sido autorizadas, elas saem uma de cada vez, e qualquer problema (rejeição, recusa ou valor diferente do planejado) desliga a emissão sozinha. Passada a cautela, a rejeição da prefeitura só avisa por e-mail; valor diferente do planejado e três recusas da Spedy na mesma rodada ainda desligam. 0 = sem cautela."
        >
          <Input
            type="number"
            name="cautela"
            min={0}
            max={50}
            value={cautela}
            onChange={(e) => setCautela(e.target.value)}
            disabled={somenteLeitura}
            className="w-24 tabular-nums"
          />
        </Field>

        <Field
          label="Códigos em espera (retidos)"
          hint={
            <>
              Códigos de serviço separados por espaço, como <code>10.05.01</code>. A cobrança que tiver
              uma nota com um destes códigos fica <strong>retida inteira</strong> (nenhuma nota dela
              sai, sem gastar número) e o resto segue normalmente. Tire o código da lista para soltar:
              a cobrança continua pronta e sai na rodada seguinte.
              {emissao.retidas > 0 ? (
                <>
                  {" "}
                  <strong>
                    Agora: {emissao.retidas} cobrança{emissao.retidas === 1 ? "" : "s"} paga
                    {emissao.retidas === 1 ? "" : "s"} esperando.
                  </strong>
                </>
              ) : null}
            </>
          }
        >
          <Input
            name="codigosEmEspera"
            placeholder="10.05.01"
            value={espera}
            onChange={(e) => setEspera(e.target.value)}
            disabled={somenteLeitura}
            className="font-mono tabular-nums"
          />
        </Field>

        <fieldset className="space-y-3 rounded-lg border border-line p-3">
          <legend className="px-1 text-[13px] font-medium">Tipo de operação (Reforma Tributária)</legend>
          <p className="text-xs text-muted">
            A prefeitura de Natal exige o tipo de operação (<code>tpOper</code>) na nota de{" "}
            <strong>sala privativa</strong> (e nos itens 15.09, 17.12 e 25.05 da LC 116). É decisão fiscal
            (Laércio/contador), por momento: nota emitida quando a cobrança é <strong>paga</strong> e quando é{" "}
            <strong>gerada</strong>. Vale na rodada seguinte, sem publicar nada. As outras notas não levam o campo.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nota emitida na quitação (cobrança paga)">
              <Select
                name="tipoQuitacao"
                value={tipoQuitacao}
                onChange={(e) => setTipoQuitacao(e.target.value as TipoDeOperacao)}
                disabled={somenteLeitura}
              >
                {TIPOS_DE_OPERACAO.map((t) => (
                  <option key={t} value={t}>
                    {ROTULO_DO_TIPO_DE_OPERACAO[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Nota emitida na geração (cliente &quot;antes&quot;)">
              <Select
                name="tipoGeracao"
                value={tipoGeracao}
                onChange={(e) => setTipoGeracao(e.target.value as TipoDeOperacao)}
                disabled={somenteLeitura}
              >
                {TIPOS_DE_OPERACAO.map((t) => (
                  <option key={t} value={t}>
                    {ROTULO_DO_TIPO_DE_OPERACAO[t]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {EXIGE_NFSE_REFERENCIADA[tipoQuitacao] || EXIGE_NFSE_REFERENCIADA[tipoGeracao] ? (
            <Aviso tone="danger">
              O tipo escolhido (<strong>2</strong> ou <strong>3</strong>) exige a <strong>NFS-e referenciada</strong>{" "}
              (grupo de documentos referenciados), que este sistema não consegue enviar: a Spedy não tem o campo e,
              na quitação, não existe nota anterior. A prefeitura rejeita com o erro <strong>E0905</strong>. A nota
              fica guardada e a equipe é avisada por e-mail, mas não sai.
            </Aviso>
          ) : null}
        </fieldset>

        <Field
          label="Avisar por e-mail quando uma nota der problema"
          hint={
            <>
              Até 5 endereços, separados por espaço ou vírgula. Recebem um e-mail quando a prefeitura
              <strong> rejeita</strong> uma nota, a Spedy a recusa, o cadastro do cliente a segura,
              uma cobrança paga fica sem nota (código em espera, sem decisão ou plano que mudou depois
              da emissão) ou o sistema <strong>desliga a emissão sozinho</strong>. Um e-mail só por
              rodada, com tudo que está pendente.{" "}
              {emailNoServidor ? (
                "Envio pela Resend: configurado no servidor."
              ) : (
                <span className="text-danger">
                  A Resend NÃO está configurada no servidor (<code>RESEND_API_KEY</code> e{" "}
                  <code>EMAIL_REMETENTE</code>): sem ela o aviso não sai, e o problema só aparece na
                  lista de notas abaixo.
                </span>
              )}
            </>
          }
        >
          <Input
            name="emailsDeAviso"
            placeholder="suporte@seahubcoworking.com.br"
            value={avisos}
            onChange={(e) => setAvisos(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
      </fieldset>

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
