import { db } from "@/lib/db";
import { exigirSessao, podeEditar } from "@/server/auth-guard";
import { integracaoImplementada } from "@/server/integrations/registry";
import { chatwootConfigSchema } from "@/server/integrations/chatwoot/config";
import { IntegrationProvider, IntegrationStatus } from "@/generated/prisma/enums";
import { ChatwootConfigForm } from "@/components/chatwoot-config";
import { Aviso, Badge, Card } from "@/components/ui";
import { formatarData } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PENDENTES: Partial<Record<IntegrationProvider, string>> = {
  [IntegrationProvider.CLICKUP]:
    "Consulta e criação de tarefas a partir do atendimento.",
  [IntegrationProvider.CONEXA]:
    "Consulta de cadastro, contratos e financeiro dos clientes.",
};

export default async function IntegracoesPage() {
  const sessao = await exigirSessao();
  const editavel = podeEditar(sessao.user.role);

  const registros = await db.integration.findMany();
  const chatwoot = registros.find(
    (i) => i.provider === IntegrationProvider.CHATWOOT,
  );
  const configChatwoot = chatwootConfigSchema.safeParse(chatwoot?.config ?? {});

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

      <Aviso>
        ClickUp e ERP Conexa entram na Fase 3. A documentação de API das duas
        ainda não foi fornecida — o contrato do registry já existe, falta o módulo
        de cada uma.
      </Aviso>

      {Object.entries(PENDENTES).map(([provider, descricao]) => (
        <Card key={provider} className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="font-medium">
              {provider === IntegrationProvider.CLICKUP ? "ClickUp" : "ERP Conexa"}
            </h2>
            {integracaoImplementada(provider as IntegrationProvider) ? (
              <Badge tone="success">disponível</Badge>
            ) : (
              <Badge>aguardando implementação</Badge>
            )}
          </div>
          <p className="text-sm text-muted">{descricao}</p>
        </Card>
      ))}
    </div>
  );
}
