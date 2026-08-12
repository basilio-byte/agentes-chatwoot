"use client";

import { useActionState, useState, useTransition } from "react";
import { Plug } from "lucide-react";
import {
  salvarConfigConexa,
  salvarTokenConexa,
  testarConexaoConexa,
  type EstadoConexa,
} from "@/server/actions/conexa";
import { Aviso, Button, Field, Input, Textarea } from "@/components/ui";

export function ConexaConfigForm({
  baseUrl,
  unidades,
  salas,
  sellerId,
  contractTemplateId,
  crmPartnerId,
  crmStatusId,
  habilitada,
  temToken,
  hintToken,
  somenteLeitura,
  podeEditarCredencial,
}: {
  baseUrl: string;
  /** Uma por linha, no formato `nome = id`. */
  unidades: string;
  salas: string;
  sellerId: string;
  contractTemplateId: string;
  crmPartnerId: string;
  crmStatusId: string;
  habilitada: boolean;
  temToken: boolean;
  hintToken: string | null;
  somenteLeitura: boolean;
  podeEditarCredencial: boolean;
}) {
  const [estadoConfig, salvarConfig, salvandoConfig] = useActionState<
    EstadoConexa,
    FormData
  >(salvarConfigConexa, {});
  const [estadoToken, salvarToken, salvandoToken] = useActionState<
    EstadoConexa,
    FormData
  >(salvarTokenConexa, {});

  const [teste, setTeste] = useState<EstadoConexa | null>(null);
  const [ocupado, iniciar] = useTransition();

  const erro = (campo: string) => estadoConfig.camposComErro?.[campo];

  return (
    <div className="space-y-5">
      <form action={salvarToken} className="space-y-3">
        <Field
          label="Token de API"
          hint={
            temToken
              ? `Salvo: ${hintToken}. Preencha de novo só para rotacionar.`
              : "Token permanente, criado por um administrador dentro do Conexa. Vai no cabeçalho como Bearer."
          }
          erro={estadoToken.camposComErro?.apiToken}
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
          label="URL da API"
          hint="Com o subdomínio da sua instância e terminando em /index.php/api/v2."
          erro={erro("baseUrl")}
        >
          <Input
            name="baseUrl"
            defaultValue={baseUrl}
            placeholder="https://seahubcoworking.conexa.app/index.php/api/v2"
            disabled={somenteLeitura}
          />
        </Field>

        <Field
          label="Unidades"
          hint="Uma por linha, no formato nome = id. O agente escreve o nome; o id vem daqui. Clique em testar para ver os ids da conta."
          erro={erro("unidades")}
        >
          <Textarea
            name="unidades"
            rows={3}
            defaultValue={unidades}
            placeholder={"Natal = 3\nRecife = 7"}
            disabled={somenteLeitura}
          />
        </Field>

        <Field
          label="Salas de reunião"
          hint="Uma por linha, nome = id. A API do Conexa não lista salas — sem este cadastro, nenhum agente consegue reservar."
          erro={erro("salas")}
        >
          <Textarea
            name="salas"
            rows={3}
            defaultValue={salas}
            placeholder={"Sala Executiva = 4140\nSala de Atendimento = 4141"}
            disabled={somenteLeitura}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Id do vendedor"
            hint="A quem as vendas da IA são atribuídas. Obrigatório com token de API: sem usuário logado, o Conexa exige o vendedor explícito."
            erro={erro("sellerId")}
          >
            <Input
              name="sellerId"
              defaultValue={sellerId}
              inputMode="numeric"
              placeholder="531"
              disabled={somenteLeitura}
            />
          </Field>

          <Field
            label="Id do modelo de contrato"
            hint="Usado ao mandar o contrato para assinatura. Sem ele, o agente cria o contrato mas não consegue enviá-lo."
            erro={erro("contractTemplateId")}
          >
            <Input
              name="contractTemplateId"
              defaultValue={contractTemplateId}
              inputMode="numeric"
              placeholder="1"
              disabled={somenteLeitura}
            />
          </Field>

          <Field
            label="Origem do CRM"
            hint="Obrigatório para registrar cliente potencial (partnerId)."
            erro={erro("crmPartnerId")}
          >
            <Input
              name="crmPartnerId"
              defaultValue={crmPartnerId}
              inputMode="numeric"
              placeholder="1"
              disabled={somenteLeitura}
            />
          </Field>

          <Field
            label="Status inicial do lead (opcional)"
            hint="Só se a sua instância usar status."
            erro={erro("crmStatusId")}
          >
            <Input
              name="crmStatusId"
              defaultValue={crmStatusId}
              inputMode="numeric"
              placeholder="4"
              disabled={somenteLeitura}
            />
          </Field>
        </div>

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
                iniciar(async () => setTeste(await testarConexaoConexa()))
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
