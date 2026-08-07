"use client";

import { useActionState, useState, useTransition } from "react";
import { Plug, Search } from "lucide-react";
import {
  descobrirModelosZapSign,
  salvarConfigZapSign,
  salvarTokenZapSign,
  testarConexaoZapSign,
  type EstadoZapSign,
} from "@/server/actions/zapsign";
import { AUTH_MODES } from "@/server/integrations/zapsign/config";
import { Aviso, Button, Field, Input, Select, Textarea } from "@/components/ui";

/** Rótulos em português para os modos de autenticação da ZapSign. */
const ROTULO_AUTH: Record<string, string> = {
  assinaturaTela: "Assinatura na tela (grátis)",
  tokenEmail: "Token por e-mail (grátis)",
  "assinaturaTela-tokenEmail": "Assinatura na tela + token por e-mail (grátis)",
  tokenSms: "Token por SMS (cobrado)",
  "assinaturaTela-tokenSms": "Assinatura na tela + token por SMS (cobrado)",
  tokenWhatsapp: "Token por WhatsApp (cobrado)",
  "assinaturaTela-tokenWhatsapp": "Assinatura na tela + token por WhatsApp (cobrado)",
  certificadoDigital: "Certificado digital ICP-Brasil (cobrado)",
};

export function ZapSignConfigForm({
  baseUrl,
  modelos,
  authModePadrao,
  whatsappAutomatico,
  lang,
  habilitada,
  temToken,
  hintToken,
  somenteLeitura,
  podeEditarCredencial,
}: {
  baseUrl: string;
  /** Uma por linha, no formato `nome = token`. */
  modelos: string;
  authModePadrao: string;
  whatsappAutomatico: boolean;
  lang: string;
  habilitada: boolean;
  temToken: boolean;
  hintToken: string | null;
  somenteLeitura: boolean;
  podeEditarCredencial: boolean;
}) {
  const [estadoConfig, salvarConfig, salvandoConfig] = useActionState<
    EstadoZapSign,
    FormData
  >(salvarConfigZapSign, {});
  const [estadoToken, salvarToken, salvandoToken] = useActionState<
    EstadoZapSign,
    FormData
  >(salvarTokenZapSign, {});

  const [teste, setTeste] = useState<EstadoZapSign | null>(null);
  const [achados, setAchados] = useState<{ id: string; nome: string }[] | null>(
    null,
  );
  const [ocupado, iniciar] = useTransition();

  const erro = (campo: string) => estadoConfig.camposComErro?.[campo];

  return (
    <div className="space-y-5">
      <form action={salvarToken} className="space-y-3">
        <Field
          label="API Token"
          hint={
            estadoToken.camposComErro?.apiToken ??
            (temToken
              ? `Salvo: ${hintToken}. Preencha de novo só para rotacionar.`
              : "Fica em Configurações → Integrações, dentro da ZapSign. Confira se é do ambiente certo: token de testes não funciona em produção.")
          }
        >
          <Input
            name="apiToken"
            type="password"
            placeholder={temToken ? "••••••••" : "Cole o token aqui"}
            autoComplete="off"
            disabled={!podeEditarCredencial}
          />
        </Field>

        {estadoToken.erro ? <Aviso tone="danger">{estadoToken.erro}</Aviso> : null}
        {estadoToken.ok ? <Aviso tone="success">{estadoToken.ok}</Aviso> : null}

        {podeEditarCredencial ? (
          <Button size="sm" disabled={salvandoToken}>
            {salvandoToken ? "Salvando…" : "Salvar token"}
          </Button>
        ) : (
          <Aviso>Só o proprietário do painel pode mexer em credenciais.</Aviso>
        )}
      </form>

      <form action={salvarConfig} className="space-y-4 border-t border-line pt-5">
        <Field
          label="Modelos de documento"
          hint={
            erro("modelos") ??
            "Um por linha, no formato nome = id. O agente pede o modelo pelo nome; o id vem daqui. Use o botão abaixo para descobrir os ids."
          }
        >
          <Textarea
            name="modelos"
            rows={3}
            defaultValue={modelos}
            placeholder={"Contrato de Endereço Fiscal = 0e1f...\nTermo de Adesão = 7b2c..."}
            disabled={somenteLeitura}
          />
        </Field>

        {!somenteLeitura ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={ocupado || !temToken}
            onClick={() =>
              iniciar(async () => {
                const r = await descobrirModelosZapSign();
                setTeste(r);
                setAchados(r.modelos ?? null);
              })
            }
          >
            <Search size={14} aria-hidden />
            {ocupado ? "Buscando…" : "Buscar modelos da conta"}
          </Button>
        ) : null}

        {achados?.length ? (
          <div className="rounded-lg border border-line bg-surface-2 p-3 text-xs">
            <p className="mb-2 text-muted">
              Copie as linhas que quiser para o campo acima:
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono">
              {achados.map((m) => `${m.nome} = ${m.id}`).join("\n")}
            </pre>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Autenticação padrão do signatário"
            hint={
              erro("authModePadrao") ??
              "Como quem assina confirma a identidade, quando o fluxo não define outra."
            }
          >
            <Select
              name="authModePadrao"
              defaultValue={authModePadrao}
              disabled={somenteLeitura}
            >
              {AUTH_MODES.map((m) => (
                <option key={m} value={m}>
                  {ROTULO_AUTH[m] ?? m}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Idioma dos documentos" hint={erro("lang") ?? undefined}>
            <Select name="lang" defaultValue={lang} disabled={somenteLeitura}>
              <option value="pt-br">Português</option>
              <option value="es">Espanhol</option>
              <option value="en">Inglês</option>
            </Select>
          </Field>
        </div>

        <Field
          label="URL da API"
          hint={erro("baseUrl") ?? "Troque só para usar o ambiente de testes da ZapSign."}
        >
          <Input
            name="baseUrl"
            defaultValue={baseUrl}
            placeholder="https://api.zapsign.com.br/api/v1"
            disabled={somenteLeitura}
          />
        </Field>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="whatsappAutomatico"
            defaultChecked={whatsappAutomatico}
            disabled={somenteLeitura}
            className="mt-0.5 size-4 accent-accent"
          />
          <span>
            Enviar o link de assinatura por WhatsApp automaticamente
            <span className="block text-xs text-muted">
              A ZapSign cobra por envio. Desligado, o agente manda o link na
              própria conversa, sem custo extra.
            </span>
          </span>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={habilitada}
            disabled={somenteLeitura}
            className="size-4 accent-accent"
          />
          Integração ligada
        </label>

        {estadoConfig.erro ? <Aviso tone="danger">{estadoConfig.erro}</Aviso> : null}
        {estadoConfig.ok ? <Aviso tone="success">{estadoConfig.ok}</Aviso> : null}

        {!somenteLeitura ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={salvandoConfig}>
              {salvandoConfig ? "Salvando…" : "Salvar configuração"}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={ocupado || !temToken}
              onClick={() =>
                iniciar(async () => setTeste(await testarConexaoZapSign()))
              }
            >
              <Plug size={14} aria-hidden />
              {ocupado ? "Testando…" : "Testar conexão"}
            </Button>
          </div>
        ) : null}
      </form>

      {teste?.ok ? <Aviso tone="success">{teste.ok}</Aviso> : null}
      {teste?.erro ? <Aviso tone="danger">{teste.erro}</Aviso> : null}
    </div>
  );
}
