"use client";

import { Check, Copy, RefreshCw } from "lucide-react";
import { startTransition, useActionState, useState, useTransition } from "react";

import {
  gerarEnderecoDasDatas,
  salvarConfigRenovacao,
  type EstadoRenovacao,
} from "@/server/actions/renovacao";
import { Aviso, Button, Field, Input, Textarea } from "@/components/ui";
import { formatarData } from "@/lib/utils";
import type { ModoDasDatas, ModoDeParte } from "@/server/renovacao/config";

/**
 * As chaves da renovação automática.
 *
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada. Mesmo conserto da janela, da cobrança e do acompanhamento.
 */
export function RenovacaoConfigForm({
  geral,
  moverParaNotificacao,
  fecharNoPagamento,
  avancarDatas,
  avisarPorWhatsapp,
  whatsappAtribuirA,
  whatsappTexto,
  textoPadrao,
  temEndereco,
  somenteLeitura,
}: {
  geral: boolean;
  moverParaNotificacao: boolean;
  fecharNoPagamento: boolean;
  avancarDatas: ModoDasDatas;
  /** O WhatsApp de renovação ao cliente ONE: desligado, sombra ou ligado. */
  avisarPorWhatsapp: ModoDeParte;
  whatsappAtribuirA: string;
  /** O texto gravado, ou `null` quando vale o padrão. */
  whatsappTexto: string | null;
  /** O texto do fluxo do n8n, para a tela mostrar o que vale quando não há outro. */
  textoPadrao: string;
  /** O endereço das datas já foi gerado? Sem ele o modo não tem o que ligar. */
  temEndereco: boolean;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoRenovacao, FormData>(
    salvarConfigRenovacao,
    {},
  );

  const [ligadoGeral, setLigadoGeral] = useState(geral);
  const [mover, setMover] = useState(moverParaNotificacao);
  const [fechar, setFechar] = useState(fecharNoPagamento);
  const [modo, setModo] = useState<ModoDasDatas>(avancarDatas);
  const [whats, setWhats] = useState<ModoDeParte>(avisarPorWhatsapp);
  const [atribuirA, setAtribuirA] = useState(whatsappAtribuirA);
  const [texto, setTexto] = useState(whatsappTexto ?? textoPadrao);

  const enviar = (evento: React.FormEvent<HTMLFormElement>) => {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    startTransition(() => salvar(dados));
  };

  const ligandoMover = ligadoGeral && mover && !(geral && moverParaNotificacao);
  const ligandoFechar = ligadoGeral && fechar && !(geral && fecharNoPagamento);
  const ligandoDatas = ligadoGeral && modo === "ligado" && !(geral && avancarDatas === "ligado");
  const ligandoWhats = ligadoGeral && whats === "ligado" && !(geral && avisarPorWhatsapp === "ligado");

  return (
    <form onSubmit={enviar} className="space-y-4">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          name="enabled"
          checked={ligadoGeral}
          onChange={(e) => setLigadoGeral(e.target.checked)}
          disabled={somenteLeitura}
          className="size-4 accent-accent"
        />
        Renovação automática ligada
      </label>

      <div className="space-y-3 border-l-2 border-line pl-4">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="moverParaNotificacao"
            checked={mover}
            onChange={(e) => setMover(e.target.checked)}
            disabled={somenteLeitura}
            className="mt-0.5 size-4 accent-accent"
          />
          <span>
            <strong>Mover para “notificação renovação”</strong> depois de 2 dias em
            “renovação”
            <span className="block text-muted">
              É o passo que a equipe faz à mão. ⚠ É nessa passagem que o ClickUp manda o
              e-mail de aviso do reajuste ao cliente.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="fecharNoPagamento"
            checked={fechar}
            onChange={(e) => setFechar(e.target.checked)}
            disabled={somenteLeitura}
            className="mt-0.5 size-4 accent-accent"
          />
          <span>
            <strong>Fechar o ciclo no pagamento</strong>
            <span className="block text-muted">
              Quando o cliente paga a cobrança no valor reajustado, a tarefa vai para
              “ongoing”. ⚠ Nessa passagem o ClickUp manda o e-mail de “cliente renovado”
              e a automação de datas do n8n roda.
            </span>
          </span>
        </label>

        <label className="block space-y-1 text-sm">
          <span>
            <strong>Avançar as datas</strong> no lugar do fluxo do n8n
          </span>
          <select
            name="avancarDatas"
            value={modo}
            onChange={(e) => setModo(e.target.value as ModoDasDatas)}
            disabled={somenteLeitura || !temEndereco}
            className="block rounded border border-line bg-surface px-2 py-1 text-sm"
          >
            <option value="desligado">Desligado</option>
            <option value="sombra">Sombra — registra o plano e não escreve nada</option>
            <option value="ligado">Ligado — escreve no ClickUp e no Conexa</option>
          </select>
          <span className="block text-muted">
            {temEndereco
              ? "Quando uma tarefa passa para “ongoing”, avança a data de reajuste, a de encerramento e a fidelidade do contrato dela, um ano à frente."
              : "Gere o endereço abaixo primeiro."}
          </span>
        </label>

        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span>
              <strong>WhatsApp de renovação ao cliente ONE</strong> no lugar do fluxo do n8n
            </span>
            <select
              name="avisarPorWhatsapp"
              value={whats}
              onChange={(e) => setWhats(e.target.value as ModoDeParte)}
              disabled={somenteLeitura}
              className="block rounded border border-line bg-surface px-2 py-1 text-sm"
            >
              <option value="desligado">Desligado</option>
              <option value="sombra">Sombra — registra para quem iria e não manda nada</option>
              <option value="ligado">Ligado — manda ao cliente pelo WhatsApp</option>
            </select>
            <span className="block text-muted">
              Quando a tarefa de um cliente de categoria ONE entra em “notificação
              renovação”, manda a mensagem abaixo pelo número da caixa 31 e passa a
              conversa para quem cuida da renovação (só se ninguém estiver com ela).
              Vale para quem entrou nesse status nos últimos 4 dias, uma mensagem por
              entrada.
            </span>
          </label>

          <Field
            label="Atribuir a conversa a"
            hint="Nome como está no Chatwoot. Com a pessoa ausente (Integrações → Chatwoot), vai para o substituto."
          >
            <Input
              name="whatsappAtribuirA"
              value={atribuirA}
              onChange={(e) => setAtribuirA(e.target.value)}
              disabled={somenteLeitura}
              className="w-auto sm:w-72"
            />
          </Field>

          <Field
            label="Texto da mensagem"
            hint={
              <>
                {"O marcador {responsavel} vira o nome do responsável da tarefa. "}
                O texto padrão é o do fluxo do n8n, que fala em IGP-M. Confira se é o
                índice do contrato ONE antes de ligar.
                {whatsappTexto === null ? " (Hoje vale o padrão.)" : null}
              </>
            }
          >
            <Textarea
              name="whatsappTexto"
              rows={12}
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              disabled={somenteLeitura}
            />
          </Field>
        </div>
      </div>

      {ligandoMover ? (
        <Aviso tone="warning">
          Ao salvar, o sistema passa a <strong>mover as tarefas</strong> que já estão há
          mais de 2 dias em “renovação”, e o ClickUp <strong>manda o e-mail ao cliente</strong>.
          As que já passaram do prazo hoje são movidas na próxima conferência.
        </Aviso>
      ) : null}
      {ligandoFechar ? (
        <Aviso tone="warning">
          Ao salvar, a tarefa cujo cliente já pagou o valor reajustado vai para “ongoing”,
          e as automações do ClickUp e do n8n rodam em seguida.
        </Aviso>
      ) : null}

      {ligandoWhats ? (
        <Aviso tone="warning">
          Ao salvar, o sistema passa a <strong>mandar WhatsApp ao cliente ONE</strong> cuja
          tarefa entrou em “notificação renovação” nos últimos 4 dias. Rode antes em{" "}
          <strong>Sombra</strong> e confira para quem iria.
        </Aviso>
      ) : null}

      {ligandoDatas ? (
        <Aviso tone="danger">
          <strong>Antes de ligar:</strong> tire a ação do n8n da automação “Atualizar datas
          renovação - N8N” do ClickUp no MESMO momento. Com os dois rodando, o contrato é
          avançado duas vezes. Se o endereço ainda não foi testado em <strong>Sombra</strong>,
          teste primeiro.
        </Aviso>
      ) : null}

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      {!somenteLeitura ? (
        <Button type="submit" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar"}
        </Button>
      ) : null}
    </form>
  );
}

/**
 * O endereço que a automação 8 do ClickUp chama. Aparece por inteiro UMA vez, ao
 * gerar — mesmo modelo do endereço da macro de boas-vindas.
 */
export function EnderecoDasDatas({
  urlBase,
  geradoEm,
  podeGerar,
}: {
  /** `https://host/api/webhooks/renovacao` — falta só o token. */
  urlBase: string;
  geradoEm: string | null;
  podeGerar: boolean;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [ocupado, iniciar] = useTransition();

  // As três variáveis que a automação já manda ao n8n; o resto o sistema lê ao vivo.
  const consulta =
    "?taskid={Task ID}&datadereajuste={DATA DE REAJUSTE}&dataencerramento={DATA DE ENCERRAMENTO CONTRATO [BASE CLIENTES]}";
  const url = `${urlBase}/${token ?? "••••••••••••••••••••••••••••"}${consulta}`;

  function copiar() {
    navigator.clipboard.writeText(url);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <span className="text-sm font-medium">Endereço para a automação do ClickUp</span>
        <div className="flex gap-2">
          <Input readOnly value={url} className="font-mono text-xs" />
          <Button type="button" variant="secondary" disabled={!token} onClick={copiar}>
            {copiado ? <Check size={14} /> : <Copy size={14} />}
            {copiado ? "Copiado" : "Copiar"}
          </Button>
        </div>
        <p className="text-xs text-muted">
          Vai na automação “Atualizar datas renovação - N8N”, como uma segunda ação “Chamar
          webhook” enquanto o modo é <strong>Sombra</strong>. As três variáveis são as que ela já manda ao n8n.
        </p>
        {token ? (
          <Aviso tone="danger">
            <strong>Copie agora.</strong> Esta é a única vez que o endereço aparece por inteiro. Gerar de
            novo troca o endereço, e o que já está cadastrado na automação deixa de valer.
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
                const r = await gerarEnderecoDasDatas();
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
