import { db } from "@/lib/db";
import { exigirSessao, podeEditar } from "@/server/auth-guard";
import { obterIntegracao } from "@/server/integrations/registry";
import { chatwootConfigSchema } from "@/server/integrations/chatwoot/config";
import { clickupConfigSchema } from "@/server/integrations/clickup/config";
import {
  IntegrationProvider,
  IntegrationStatus,
  UserRole,
} from "@/generated/prisma/enums";
import { ChatwootConfigForm } from "@/components/chatwoot-config";
import { ClickUpConfigForm } from "@/components/clickup-config";
import { Aviso, Badge, Card } from "@/components/ui";
import { formatarData } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function IntegracoesPage() {
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
  const configClickUp = clickupConfigSchema.safeParse(clickup?.config ?? {});
  const toolsClickUp =
    obterIntegracao(IntegrationProvider.CLICKUP)?.tools.length ?? 0;

  const comBot = await db.agentChatwootBot.count();

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Integrações</h1>
        <p className="text-sm text-muted">
          O liga/desliga aqui é <strong>global</strong>: desligou, nenhum agente
          enxerga as tools. Cada agente ainda tem o próprio toggle na tela dele.
        </p>
      </header>

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
          <strong>bot é por agente</strong>, com token próprio, na tela de cada um.
          {comBot > 0 ? ` ${comBot} agente(s) com bot configurado.` : ""}
        </p>

        <ChatwootConfigForm
          baseUrl={configChatwoot.success ? configChatwoot.data.baseUrl : ""}
          accountId={
            configChatwoot.success ? String(configChatwoot.data.accountId) : "1"
          }
          habilitada={chatwoot?.enabled ?? false}
          somenteLeitura={!editavel}
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
          responsáveis. O agente recebe {toolsClickUp} ferramenta(s) quando esta
          integração está ligada para ele.
        </p>

        <ClickUpConfigForm
          teamId={configClickUp.success ? configClickUp.data.teamId : ""}
          defaultListId={
            configClickUp.success ? (configClickUp.data.defaultListId ?? "") : ""
          }
          spaceIds={
            configClickUp.success
              ? configClickUp.data.spaceIdsPermitidos.join(", ")
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

      <Card className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="font-medium">ERP Conexa</h2>
          <Badge>aguardando documentação de API</Badge>
        </div>
        <p className="text-sm text-muted">
          Consulta de cadastro, contratos e financeiro dos clientes. O contrato do
          registry já existe — falta a documentação para escrever o módulo.
        </p>
      </Card>
    </div>
  );
}
