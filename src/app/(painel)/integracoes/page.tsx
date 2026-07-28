import { db } from "@/lib/db";
import { exigirSessao } from "@/server/auth-guard";
import { integracaoImplementada } from "@/server/integrations/registry";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { Aviso, Badge, Card } from "@/components/ui";

const CATALOGO: Record<
  IntegrationProvider,
  { label: string; descricao: string }
> = {
  [IntegrationProvider.CHATWOOT]: {
    label: "Chatwoot",
    descricao:
      "Canal de atendimento. O agente responde como Agent Bot nas inboxes vinculadas.",
  },
  [IntegrationProvider.CLICKUP]: {
    label: "ClickUp",
    descricao: "Consulta e criação de tarefas a partir do atendimento.",
  },
  [IntegrationProvider.CONEXA]: {
    label: "ERP Conexa",
    descricao: "Consulta de cadastro, contratos e financeiro dos clientes.",
  },
};

export default async function IntegracoesPage() {
  await exigirSessao();
  const configuradas = await db.integration.findMany();
  const porProvider = new Map(configuradas.map((i) => [i.provider, i]));

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Integrações</h1>
        <p className="text-sm text-muted">
          O liga/desliga aqui é <strong>global</strong>: desligou, nenhum agente
          enxerga as tools. Cada agente ainda tem o próprio toggle na tela dele.
        </p>
      </header>

      <Aviso>
        Fase 3 do projeto. A documentação de API do ClickUp e do ERP Conexa ainda
        não foi fornecida, então essas integrações aparecem aqui como pendentes —
        o contrato já existe, falta o módulo de cada uma.
      </Aviso>

      <div className="space-y-3">
        {Object.values(IntegrationProvider).map((provider) => {
          const registro = porProvider.get(provider);
          const implementada = integracaoImplementada(provider);
          const info = CATALOGO[provider];

          return (
            <Card key={provider} className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="font-medium">{info.label}</h2>

                {!implementada ? (
                  <Badge>aguardando implementação</Badge>
                ) : registro?.enabled ? (
                  <Badge tone="success">ligada</Badge>
                ) : (
                  <Badge>desligada</Badge>
                )}
              </div>

              <p className="text-sm text-muted">{info.descricao}</p>

              {registro?.lastError ? (
                <p className="text-xs text-danger">{registro.lastError}</p>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
