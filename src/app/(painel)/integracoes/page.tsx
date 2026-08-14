import { headers } from "next/headers";
import { db } from "@/lib/db";
import { exigirSessao, podeEditar } from "@/server/auth-guard";
import { obterIntegracao } from "@/server/integrations/registry";
import { chatwootConfigSchema } from "@/server/integrations/chatwoot/config";
import { obterSegredosDaConta } from "@/server/integrations/chatwoot/credenciais";
import { clickupConfigSchema } from "@/server/integrations/clickup/config";
import { conexaConfigSchema } from "@/server/integrations/conexa/config";
import { lerConfigZapSign } from "@/server/integrations/zapsign/config";
import { lerConfigOpenAI } from "@/server/integrations/openai/config";
import { leiturasRecentes } from "@/server/actions/openai";
import {
  IntegrationProvider,
  IntegrationStatus,
  UserRole,
} from "@/generated/prisma/enums";
import { ChatwootConfigForm } from "@/components/chatwoot-config";
import { ClickUpConfigForm } from "@/components/clickup-config";
import { ConexaConfigForm } from "@/components/conexa-config";
import { ZapSignConfigForm } from "@/components/zapsign-config";
import { OpenAIConfigForm } from "@/components/openai-config";
import { LeiturasDeMidia } from "@/components/leituras-de-midia";
import {
  Building2,
  Ear,
  FileSignature,
  ListChecks,
  MessagesSquare,
} from "lucide-react";
import { Abas } from "@/components/abas";
import { Aviso, Badge, Card, PageHeader } from "@/components/ui";
import { formatarData } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function IntegracoesPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string }>;
}) {
  const { aba } = await searchParams;
  const sessao = await exigirSessao();
  const editavel = podeEditar(sessao.user.role);

  const registros = await db.integration.findMany({
    include: { credential: true },
  });
  const chatwoot = registros.find(
    (i) => i.provider === IntegrationProvider.CHATWOOT,
  );
  const clickup = registros.find(
    (i) => i.provider === IntegrationProvider.CLICKUP,
  );
  const configChatwoot = chatwootConfigSchema.safeParse(chatwoot?.config ?? {});
  const conexa = registros.find(
    (i) => i.provider === IntegrationProvider.CONEXA,
  );
  const configClickUp = clickupConfigSchema.safeParse(clickup?.config ?? {});
  const configConexa = conexaConfigSchema.safeParse(conexa?.config ?? {});
  const toolsConexa =
    obterIntegracao(IntegrationProvider.CONEXA)?.tools.length ?? 0;
  const zapsign = registros.find(
    (i) => i.provider === IntegrationProvider.ZAPSIGN,
  );
  const configZapSign = lerConfigZapSign(zapsign?.config ?? {});
  const toolsZapSign =
    obterIntegracao(IntegrationProvider.ZAPSIGN)?.tools.length ?? 0;
  const toolsClickUp =
    obterIntegracao(IntegrationProvider.CLICKUP)?.tools.length ?? 0;
  const openai = registros.find(
    (i) => i.provider === IntegrationProvider.OPENAI,
  );
  const configOpenAI = lerConfigOpenAI(openai?.config);
  const leituras = await leiturasRecentes();
  // Quantos agentes já têm a leitura ligada. Zero com a integração ligada é o
  // estado que engana: parece funcionando e nenhum atendimento lê nada.
  const agentesComMidia = openai
    ? await db.agentIntegration.count({
        where: { integrationId: openai.id, enabled: true },
      })
    : 0;

  const comBot = await db.agentChatwootBot.count();
  const segredosDaConta = await obterSegredosDaConta();

  const cabecalhos = await headers();
  const origem = `${cabecalhos.get("x-forwarded-proto") ?? "https"}://${
    cabecalhos.get("host") ?? "localhost:3000"
  }`;

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        titulo="Integrações"
        descricao={
          <>
            O liga/desliga aqui é <strong>global</strong>: desligou, nenhum
            agente enxerga as tools. Cada agente ainda tem o próprio toggle na
            tela dele.
          </>
        }
        semBorda
      />
      <Abas
        inicial={aba}
        itens={[
          {
            id: "chatwoot",
            rotulo: "Chatwoot",
            icone: <MessagesSquare size={14} aria-hidden />,
            alerta: !chatwoot?.enabled,
            conteudo: (
              <Card className="space-y-4">
                <div className="flex items-center gap-2">
                  <h2 className="font-medium">Chatwoot</h2>
                  {chatwoot?.enabled ? (
                    <Badge tone="success">ligada</Badge>
                  ) : (
                    <Badge>desligada</Badge>
                  )}
                  {chatwoot?.status === IntegrationStatus.OK ? (
                    <Badge tone="success">conexão ok</Badge>
                  ) : chatwoot?.status === IntegrationStatus.ERROR ? (
                    <Badge tone="danger">falha na conexão</Badge>
                  ) : null}
                </div>

                <p className="text-sm text-muted">
                  Canal de atendimento. Esta tela guarda só a instância — o{" "}
                  <strong>bot é por agente</strong>, com token próprio, na tela
                  de cada um.
                  {comBot > 0
                    ? ` ${comBot} agente(s) com bot configurado.`
                    : ""}
                </p>

                <ChatwootConfigForm
                  baseUrl={
                    configChatwoot.success ? configChatwoot.data.baseUrl : ""
                  }
                  accountId={
                    configChatwoot.success
                      ? String(configChatwoot.data.accountId)
                      : "1"
                  }
                  habilitada={chatwoot?.enabled ?? false}
                  somenteLeitura={!editavel}
                  temSecretDaConta={segredosDaConta.secretDaConta.length > 0}
                  temTokenDeLeitura={segredosDaConta.tokenDeLeitura.length > 0}
                  urlWebhookConta={`${origem}/api/webhooks/chatwoot/conta`}
                />

                {chatwoot?.lastError ? (
                  <Aviso tone="danger">
                    Último teste falhou: {chatwoot.lastError}
                    {chatwoot.lastCheckedAt
                      ? ` (${formatarData(chatwoot.lastCheckedAt)})`
                      : ""}
                  </Aviso>
                ) : null}
              </Card>
            ),
          },
          {
            id: "clickup",
            rotulo: "ClickUp",
            icone: <ListChecks size={14} aria-hidden />,
            contador: toolsClickUp,
            alerta: !clickup?.enabled,
            conteudo: (
              <Card className="space-y-4">
                <div className="flex items-center gap-2">
                  <h2 className="font-medium">ClickUp</h2>
                  {clickup?.enabled ? (
                    <Badge tone="success">ligada</Badge>
                  ) : (
                    <Badge>desligada</Badge>
                  )}
                  {clickup?.status === IntegrationStatus.OK ? (
                    <Badge tone="success">conexão ok</Badge>
                  ) : clickup?.status === IntegrationStatus.ERROR ? (
                    <Badge tone="danger">falha na conexão</Badge>
                  ) : null}
                </div>

                <p className="text-sm text-muted">
                  Criar e administrar tarefas, mudar status, comentar e atribuir
                  responsáveis. O agente recebe {toolsClickUp} ferramenta(s)
                  quando esta integração está ligada para ele.
                </p>

                <ClickUpConfigForm
                  teamId={
                    configClickUp.success ? configClickUp.data.teamId : ""
                  }
                  defaultListId={
                    configClickUp.success
                      ? (configClickUp.data.defaultListId ?? "")
                      : ""
                  }
                  spaceIds={
                    configClickUp.success
                      ? configClickUp.data.spaceIdsPermitidos.join(", ")
                      : ""
                  }
                  listasNomeadas={
                    configClickUp.success
                      ? configClickUp.data.listasNomeadas
                          .map((l) => `${l.nome} = ${l.listId}`)
                          .join("\n")
                      : ""
                  }
                  habilitada={clickup?.enabled ?? false}
                  temToken={Boolean(clickup?.credential)}
                  hintToken={clickup?.credential?.hint ?? null}
                  somenteLeitura={!editavel}
                  podeEditarCredencial={sessao.user.role === UserRole.OWNER}
                />

                {clickup?.lastError ? (
                  <Aviso tone="danger">
                    Último teste falhou: {clickup.lastError}
                    {clickup.lastCheckedAt
                      ? ` (${formatarData(clickup.lastCheckedAt)})`
                      : ""}
                  </Aviso>
                ) : null}
              </Card>
            ),
          },
          {
            id: "conexa",
            rotulo: "ERP Conexa",
            icone: <Building2 size={14} aria-hidden />,
            conteudo: (
              <Card className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="font-medium">ERP Conexa</h2>
                  {conexa?.enabled ? (
                    <Badge tone="success">ligada</Badge>
                  ) : (
                    <Badge>desligada</Badge>
                  )}
                  {conexa?.status === IntegrationStatus.OK ? (
                    <Badge tone="success">conexão ok</Badge>
                  ) : conexa?.status === IntegrationStatus.ERROR ? (
                    <Badge tone="danger">falha na conexão</Badge>
                  ) : null}
                </div>

                <p className="text-sm text-muted">
                  Clientes, planos, contratos com assinatura eletrônica,
                  cobranças com Pix e reservas de sala. O agente recebe{" "}
                  {toolsConexa} ferramenta(s) quando esta integração está ligada
                  para ele.
                </p>

                <ConexaConfigForm
                  baseUrl={configConexa.success ? configConexa.data.baseUrl : ""}
                  unidades={
                    configConexa.success
                      ? configConexa.data.unidades
                          .map((u) => `${u.nome} = ${u.companyId}`)
                          .join("\n")
                      : ""
                  }
                  salas={
                    configConexa.success
                      ? configConexa.data.salas
                          .map((s) => `${s.nome} = ${s.roomId}`)
                          .join("\n")
                      : ""
                  }
                  sellerId={String(
                    (configConexa.success && configConexa.data.sellerId) || "",
                  )}
                  contractTemplateId={String(
                    (configConexa.success && configConexa.data.contractTemplateId) ||
                      "",
                  )}
                  crmPartnerId={String(
                    (configConexa.success && configConexa.data.crmPartnerId) || "",
                  )}
                  crmStatusId={String(
                    (configConexa.success && configConexa.data.crmStatusId) || "",
                  )}
                  habilitada={conexa?.enabled ?? false}
                  temToken={Boolean(conexa?.credential)}
                  hintToken={conexa?.credential?.hint ?? null}
                  somenteLeitura={!editavel}
                  podeEditarCredencial={sessao.user.role === UserRole.OWNER}
                />

                {conexa?.lastError ? (
                  <Aviso tone="danger">
                    Último teste falhou: {conexa.lastError}
                    {conexa.lastCheckedAt
                      ? ` (${formatarData(conexa.lastCheckedAt)})`
                      : ""}
                  </Aviso>
                ) : null}
              </Card>
            ),
          },
          {
            id: "zapsign",
            rotulo: "ZapSign",
            icone: <FileSignature size={14} aria-hidden />,
            conteudo: (
              <Card className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="font-medium">ZapSign</h2>
                  {zapsign?.enabled ? (
                    <Badge tone="success">ligada</Badge>
                  ) : (
                    <Badge>desligada</Badge>
                  )}
                  {zapsign?.status === IntegrationStatus.OK ? (
                    <Badge tone="success">conexão ok</Badge>
                  ) : zapsign?.status === IntegrationStatus.ERROR ? (
                    <Badge tone="danger">falha na conexão</Badge>
                  ) : null}
                </div>

                <p className="text-sm text-muted">
                  Assinatura eletrônica: o agente escolhe o modelo, preenche os
                  campos, gera o contrato e devolve o link de assinatura. O
                  agente recebe {toolsZapSign} ferramenta(s) quando esta
                  integração está ligada para ele.
                </p>

                <ZapSignConfigForm
                  ambiente={
                    configZapSign.success
                      ? configZapSign.data.ambiente
                      : "producao"
                  }
                  modelos={
                    configZapSign.success
                      ? configZapSign.data.modelos
                          .map((m) => `${m.nome} = ${m.templateId}`)
                          .join("\n")
                      : ""
                  }
                  authModePadrao={
                    configZapSign.success
                      ? configZapSign.data.authModePadrao
                      : "assinaturaTela-tokenEmail"
                  }
                  whatsappAutomatico={
                    configZapSign.success
                      ? configZapSign.data.whatsappAutomatico
                      : false
                  }
                  lang={configZapSign.success ? configZapSign.data.lang : "pt-br"}
                  habilitada={zapsign?.enabled ?? false}
                  temToken={Boolean(zapsign?.credential)}
                  hintToken={zapsign?.credential?.hint ?? null}
                  somenteLeitura={!editavel}
                  podeEditarCredencial={sessao.user.role === UserRole.OWNER}
                />

                {zapsign?.lastError ? (
                  <Aviso tone="danger">
                    Último teste falhou: {zapsign.lastError}
                    {zapsign.lastCheckedAt
                      ? ` (${formatarData(zapsign.lastCheckedAt)})`
                      : ""}
                  </Aviso>
                ) : null}
              </Card>
            ),
          },
          {
            id: "midia",
            rotulo: "Leitura de mídia",
            icone: <Ear size={14} aria-hidden />,
            // Ligada globalmente e nenhum agente ligado é o estado que engana:
            // parece funcionando e nenhum atendimento lê nada.
            alerta: Boolean(openai?.enabled) && agentesComMidia === 0,
            conteudo: (
              <div className="space-y-6">
                <Card className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h2 className="font-medium">OpenAI — leitura de mídia</h2>
                    {openai?.enabled ? (
                      <Badge tone="success">ligada</Badge>
                    ) : (
                      <Badge>desligada</Badge>
                    )}
                    {openai?.status === IntegrationStatus.OK ? (
                      <Badge tone="success">conexão ok</Badge>
                    ) : openai?.status === IntegrationStatus.ERROR ? (
                      <Badge tone="danger">falha na conexão</Badge>
                    ) : null}
                  </div>

                  <p className="text-sm text-muted">
                    Áudio, foto e documento que o cliente manda viram texto{" "}
                    <strong>antes</strong> de o agente responder. Não é uma
                    ferramenta que ele escolhe usar: o anexo simplesmente passa a
                    aparecer na mensagem. É a única integração que{" "}
                    <strong>não usa a OpenRouter</strong> — a transcrição é
                    endpoint da OpenAI, e a conta vem separada.
                  </p>

                  {openai?.enabled && agentesComMidia === 0 ? (
                    <Aviso tone="danger">
                      Ligada aqui, mas <strong>nenhum agente</strong> tem a
                      leitura ligada — nenhum anexo será lido. Abra a tela do
                      agente que é dono do bot e ligue em Integrações.
                    </Aviso>
                  ) : null}

                  <OpenAIConfigForm
                    baseUrl={configOpenAI.baseUrl}
                    modeloVisao={configOpenAI.modeloVisao}
                    modeloAudio={configOpenAI.modeloAudio}
                    modeloDocumento={configOpenAI.modeloDocumento}
                    idiomaAudio={configOpenAI.idiomaAudio}
                    lerImagem={configOpenAI.lerImagem}
                    lerAudio={configOpenAI.lerAudio}
                    lerDocumento={configOpenAI.lerDocumento}
                    instrucaoImagem={configOpenAI.instrucaoImagem}
                    instrucaoDocumento={configOpenAI.instrucaoDocumento}
                    tamanhoMaximoMb={configOpenAI.tamanhoMaximoMb}
                    maxAnexosPorTurno={configOpenAI.maxAnexosPorTurno}
                    habilitada={openai?.enabled ?? false}
                    temChave={Boolean(openai?.credential)}
                    hintChave={openai?.credential?.hint ?? null}
                    somenteLeitura={!editavel}
                    podeEditarCredencial={sessao.user.role === UserRole.OWNER}
                  />

                  {openai?.lastError ? (
                    <Aviso tone="danger">
                      Último teste falhou: {openai.lastError}
                      {openai.lastCheckedAt
                        ? ` (${formatarData(openai.lastCheckedAt)})`
                        : ""}
                    </Aviso>
                  ) : null}
                </Card>

                <Card className="space-y-3">
                  <div>
                    <h2 className="text-sm font-semibold">Últimas leituras</h2>
                    <p className="text-xs text-muted">
                      Cada arquivo é lido <strong>uma vez</strong> e reaproveitado
                      nos turnos seguintes — o worker relê a conversa inteira a
                      cada mensagem, e sem esse reaproveitamento o mesmo áudio
                      seria transcrito de novo toda vez.
                    </p>
                  </div>
                  <LeiturasDeMidia leituras={leituras} />
                </Card>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
