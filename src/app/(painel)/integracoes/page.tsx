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
import { lerConfigGoogle } from "@/server/integrations/google/config";
import { leiturasRecentes, modelosParaEscolher } from "@/server/actions/openai";
import { dadosDaContaGoogle } from "@/server/actions/google";
import {
  IntegrationProvider,
  IntegrationStatus,
  type PresenteStatus,
  UserRole,
} from "@/generated/prisma/enums";
import { ChatwootConfigForm } from "@/components/chatwoot-config";
import { ClickUpConfigForm } from "@/components/clickup-config";
import { ConexaConfigForm } from "@/components/conexa-config";
import { ZapSignConfigForm } from "@/components/zapsign-config";
import { OpenAIConfigForm } from "@/components/openai-config";
import { LeiturasDeMidia } from "@/components/leituras-de-midia";
import { DocumentosConfigForm } from "@/components/documentos-config";
import { PrazosConfigForm } from "@/components/prazos-config";
import { MateriaisConfigForm } from "@/components/materiais-config";
import { CobrancaConfigForm } from "@/components/cobranca-config";
import { AniversarioConfigForm } from "@/components/aniversario-config";
import { lerConfigAniversario } from "@/server/aniversario/regras";
import { formatarTelefone } from "@/server/alerta-de-saldo/regras";
import { lerConfigCobranca, PROVIDER_DA_COBRANCA } from "@/server/cobranca/regras";
import {
  configMateriaisSchema,
  listarMateriais,
} from "@/server/integrations/materiais";
import { GoogleConfigForm } from "@/components/google-config";
import { NpsConfigForm } from "@/components/nps-config";
import { lerConfigNps } from "@/server/nps/config";
import { SITUACAO_DA_PESQUISA } from "@/server/nps/rotulos";
import { JanelaConfigForm } from "@/components/janela-config";
import { lerConfigJanela } from "@/server/janela/config";
import { PROVIDER_DA_JANELA } from "@/server/janela/conferir";
import {
  ETIQUETA_ABERTA,
  ETIQUETA_FECHADA,
  textoDaNota,
} from "@/server/janela/regras";
import {
  Building2,
  Cake,
  Ear,
  FileSignature,
  Hourglass,
  IdCard,
  Images,
  ListChecks,
  MessagesSquare,
  Receipt,
  Star,
  Table2,
  Timer,
} from "lucide-react";
import { Abas } from "@/components/abas";
import { Aviso, Badge, Card, PageHeader, Tabela } from "@/components/ui";
import { formatarData } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SITUACAO_DO_PRESENTE: Record<PresenteStatus, string> = {
  AGUARDANDO: "esperando o pacote",
  PROCESSANDO: "reservando",
  RESERVADO: "reservado",
  ENTREGUE: "com a equipe",
  CANCELADO: "cancelado",
  FALHOU: "falhou",
};

const TOM_DO_PRESENTE: Record<PresenteStatus, "success" | "danger" | "warning" | "neutral"> = {
  AGUARDANDO: "neutral",
  PROCESSANDO: "neutral",
  RESERVADO: "success",
  ENTREGUE: "warning",
  CANCELADO: "neutral",
  FALHOU: "danger",
};

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
  // Lista viva da conta, com cache de 1h — assim que a chave existe, os campos
  // de modelo já vêm como seletor, sem ninguém precisar clicar em "buscar".
  const modelosOpenAI = await modelosParaEscolher({
    modeloAudio: configOpenAI.modeloAudio,
    modeloVisao: configOpenAI.modeloVisao,
    modeloDocumento: configOpenAI.modeloDocumento,
  });
  // Quantos agentes já têm a leitura ligada. Zero com a integração ligada é o
  // estado que engana: parece funcionando e nenhum atendimento lê nada.
  const documentos = registros.find(
    (i) => i.provider === IntegrationProvider.DOCUMENTOS,
  );
  const toolsDocumentos =
    obterIntegracao(IntegrationProvider.DOCUMENTOS)?.tools.length ?? 0;
  const prazos = registros.find(
    (i) => i.provider === IntegrationProvider.PRAZOS,
  );
  const toolsPrazos =
    obterIntegracao(IntegrationProvider.PRAZOS)?.tools.length ?? 0;
  const materiais = registros.find(
    (i) => i.provider === IntegrationProvider.MATERIAIS,
  );
  const configMateriais = configMateriaisSchema.parse(materiais?.config ?? {});
  // A lista de verdade, lida dos macros do Chatwoot (cache de 5 min): é o que
  // os agentes conseguem mandar agora. Falhar aqui não derruba a página.
  const materiaisDisponiveis = await listarMateriais(configMateriais.prefixos).then(
    (lista) => ({ lista, erro: null as string | null }),
    (erro: unknown) => ({
      lista: [] as Awaited<ReturnType<typeof listarMateriais>>,
      erro: erro instanceof Error ? erro.message : String(erro),
    }),
  );
  const agentesComMateriais = materiais
    ? await db.agentIntegration.count({
        where: { integrationId: materiais.id, enabled: true },
      })
    : 0;
  const aniversario = registros.find((i) => i.provider === IntegrationProvider.ANIVERSARIO);
  const configAniversario = lerConfigAniversario(aniversario?.config);
  const agentesComAniversario = aniversario
    ? await db.agentIntegration.count({
        where: { integrationId: aniversario.id, enabled: true },
      })
    : 0;
  // Sem nome nem telefone do cliente: a tela é aberta pela equipe inteira.
  const presentes = await db.presenteDeAniversario.findMany({
    orderBy: { criadoEm: "desc" },
    take: 15,
    select: {
      id: true,
      chatwootConversationId: true,
      salaNome: true,
      salaId: true,
      data: true,
      inicio: true,
      fim: true,
      status: true,
      resultado: true,
      criadoEm: true,
    },
  });
  const cobranca = registros.find((i) => i.provider === IntegrationProvider.COBRANCA);
  const configCobranca = lerConfigCobranca(cobranca?.config);
  // "reservado" é envio a caminho (ou que caiu no meio e vira "incerto"): não é rastro.
  const avisosDeCobranca = await db.webhookEvent.findMany({
    where: { provider: PROVIDER_DA_COBRANCA, resultado: { not: "reservado" } },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { id: true, eventType: true, resultado: true, detalhe: true, createdAt: true, payload: true },
  });
  const nps = registros.find((i) => i.provider === IntegrationProvider.NPS);
  const configNps = lerConfigNps(nps?.config);
  // Sem telefone nem nome: a tela é aberta pela equipe inteira.
  const pesquisasNps = await db.pesquisaNps.findMany({
    orderBy: { criadaEm: "desc" },
    take: 15,
    select: {
      id: true,
      chatwootConversationId: true,
      status: true,
      nota: true,
      marcadaEm: true,
      resultado: true,
    },
  });
  const janela = registros.find((i) => i.provider === IntegrationProvider.JANELA);
  const configJanela = lerConfigJanela(janela?.config);
  // A prévia usa uma janela de verdade — a que fecharia daqui a
  // `minutosDeAviso` —, para a hora sair no fuso e no formato que a equipe lê.
  const previaDaNota = textoDaNota(
    Math.floor(Date.now() / 1000) + configJanela.minutosDeAviso * 60,
    configJanela.instrucao,
  );
  // "reservado" é a nota a caminho (ou que falhou e será desfeita): não é rastro.
  const acoesDaJanela = await db.webhookEvent.findMany({
    where: { provider: PROVIDER_DA_JANELA, resultado: { not: "reservado" } },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { id: true, resultado: true, detalhe: true, createdAt: true, payload: true },
  });
  const linkDaConversa = (id: number) =>
    configChatwoot.success
      ? `${configChatwoot.data.baseUrl}/app/accounts/${configChatwoot.data.accountId}/conversations/${id}`
      : null;
  const agentesComMidia = openai
    ? await db.agentIntegration.count({
        where: { integrationId: openai.id, enabled: true },
      })
    : 0;

  const google = registros.find(
    (i) => i.provider === IntegrationProvider.GOOGLE,
  );
  const configGoogle = lerConfigGoogle(google?.config);
  const toolsGoogle =
    obterIntegracao(IntegrationProvider.GOOGLE)?.tools.length ?? 0;
  // O e-mail da conta de serviço é lido do JSON decifrado a cada abertura, e
  // não sai da config: a config é substituída inteira a cada save, e o
  // primeiro "Salvar configuração" de um ADMIN apagaria o que o OWNER gravou.
  //
  // ⚠ Só para quem pode: `dadosDaContaGoogle` exige ADMIN e **lança** se não
  // tiver. Chamar sem a guarda derrubaria a página inteira de Integrações para
  // o papel Leitura, que hoje a abre sem problema.
  const contaGoogle = editavel ? await dadosDaContaGoogle() : null;

  const comBot = await db.agentChatwootBot.count();
  const segredosDaConta = await obterSegredosDaConta();

  const cabecalhos = await headers();
  const origem = `${cabecalhos.get("x-forwarded-proto") ?? "https"}://${
    cabecalhos.get("host") ?? "localhost:3000"
  }`;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
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
            id: "documentos",
            rotulo: "Documentos",
            icone: <IdCard size={14} aria-hidden />,
            contador: toolsDocumentos,
            conteudo: (
              <Card className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="font-medium">Documentos (CPF, CNH, CNPJ)</h2>
                  {documentos?.enabled ? (
                    <Badge tone="success">ligada</Badge>
                  ) : (
                    <Badge>desligada</Badge>
                  )}
                </div>

                <p className="text-sm text-muted">
                  Confere se o número de um documento é bem formado e consulta
                  CNPJ na base pública da Receita. O agente recebe{" "}
                  {toolsDocumentos} ferramenta(s) quando esta integração está
                  ligada para ele.
                </p>

                <Aviso tone="danger">
                  <strong>Isto não detecta falsificação.</strong> Prova que um
                  número é bem formado e que uma empresa existe — não que o
                  documento é autêntico nem que pertence a quem o enviou. Para
                  CPF e CNH não existe consulta oficial gratuita. Antifraude de
                  verdade exige serviço contratado.
                </Aviso>

                <DocumentosConfigForm
                  habilitada={documentos?.enabled ?? false}
                  somenteLeitura={!editavel}
                />

                {documentos?.lastError ? (
                  <Aviso tone="danger">
                    Último teste: {documentos.lastError}
                    {documentos.lastCheckedAt
                      ? ` (${formatarData(documentos.lastCheckedAt)})`
                      : ""}
                  </Aviso>
                ) : null}
              </Card>
            ),
          },
          {
            id: "prazos",
            rotulo: "Prazos",
            icone: <Timer size={14} aria-hidden />,
            contador: toolsPrazos,
            conteudo: (
              <Card className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="font-medium">Prazos da conversa</h2>
                  {prazos?.enabled ? (
                    <Badge tone="success">ligada</Badge>
                  ) : (
                    <Badge>desligada</Badge>
                  )}
                </div>

                <p className="text-sm text-muted">
                  O agente registra um prazo numa conversa do Chatwoot — “se
                  ninguém da equipe responder em 10 minutos, passe para outra
                  pessoa”, “se o cliente não responder em 1 hora, pergunte se
                  ainda precisa de ajuda” — e o worker confere os prazos de
                  minuto em minuto. O agente recebe {toolsPrazos} ferramenta(s)
                  quando esta integração está ligada para ele.
                </p>

                <Aviso>
                  Antes de agir, o sistema confere a conversa{" "}
                  <strong>ao vivo</strong> no Chatwoot. O prazo cai sozinho se
                  alguém da equipe escrever (inclusive nota interna), se outra
                  pessoa assumir, se o cliente responder ou se a conversa for
                  resolvida. Desligar aqui faz os prazos pendentes não agirem
                  mais.
                </Aviso>

                <PrazosConfigForm
                  habilitada={prazos?.enabled ?? false}
                  somenteLeitura={!editavel}
                />
              </Card>
            ),
          },
          {
            id: "materiais",
            rotulo: "Materiais",
            icone: <Images size={14} aria-hidden />,
            contador: materiaisDisponiveis.lista.length,
            conteudo: (
              <Card className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="font-medium">Fotos e materiais prontos</h2>
                  {materiais?.enabled ? (
                    <Badge tone="success">ligada</Badge>
                  ) : (
                    <Badge>desligada</Badge>
                  )}
                </div>

                <p className="text-sm text-muted">
                  O agente manda ao cliente as imagens dos macros do Chatwoot —
                  capa e fotos das salas, formatos do auditório, catálogos —
                  quando o cliente pede. A equipe continua mantendo as imagens
                  nos macros: trocou lá, o agente passa a mandar a nova. Agentes
                  com a integração ligada: <strong>{agentesComMateriais}</strong>.
                </p>

                <Aviso>
                  Só os <strong>arquivos</strong> do macro saem, pelo robô da
                  conversa — o macro não é executado, então nenhum texto,
                  atribuição ou etiqueta dele acontece. Antes de mandar, o
                  sistema confere ao vivo que a conversa ainda é do robô.
                </Aviso>

                {materiaisDisponiveis.erro ? (
                  <Aviso tone="danger">
                    Não consegui ler os macros: {materiaisDisponiveis.erro}
                  </Aviso>
                ) : materiaisDisponiveis.lista.length === 0 ? (
                  <Aviso>
                    Nenhum macro global com imagem começa pelos prefixos abaixo.
                  </Aviso>
                ) : (
                  <Tabela
                    cabecalho={
                      <>
                        <th>Material (nome do macro)</th>
                        <th className="text-right">Imagens</th>
                      </>
                    }
                  >
                    {materiaisDisponiveis.lista.map((m) => (
                      <tr key={m.id}>
                        <td>{m.nome}</td>
                        <td className="text-right tabular-nums">{m.arquivos.length}</td>
                      </tr>
                    ))}
                  </Tabela>
                )}

                <MateriaisConfigForm
                  habilitada={materiais?.enabled ?? false}
                  prefixos={configMateriais.prefixos.join("\n")}
                  somenteLeitura={!editavel}
                />
              </Card>
            ),
          },
          {
            id: "aniversario",
            rotulo: "Aniversário",
            icone: <Cake size={14} aria-hidden />,
            conteudo: (
              <div className="space-y-6">
                <Card className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h2 className="font-medium">Presente de aniversário</h2>
                    {aniversario?.enabled ? (
                      <Badge tone="success">ligada</Badge>
                    ) : (
                      <Badge>desligada</Badge>
                    )}
                  </div>

                  <p className="text-sm text-muted">
                    O cliente que recebeu o e-mail de aniversário pede as{" "}
                    {configAniversario.horas} h de sala na conversa. O agente
                    combina sala, dia e horário, confere o CPF ou CNPJ, o
                    aniversário no cadastro do Conexa (até{" "}
                    {configAniversario.diasDepois} dias depois) e a agenda, e
                    registra o pedido. Quem está abaixo recebe um WhatsApp para{" "}
                    <strong>lançar e faturar o pacote</strong> no Conexa (Pré-Venda
                    Pacote de Horas, R$ 0). Assim que a venda aparece paga, o
                    sistema reserva e confirma ao cliente — ninguém precisa
                    reservar. Agentes com a integração ligada:{" "}
                    <strong>{agentesComAniversario}</strong>.
                  </p>

                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                    <li>
                      O agente <strong>nunca oferece</strong> o presente: só
                      registra quando o cliente diz que recebeu o e-mail.
                    </li>
                    <li>
                      O Conexa é conferido a cada 5 minutos, só enquanto houver
                      pedido esperando. Sem o pacote pago em{" "}
                      {configAniversario.prazoHoras} h (ou até 30 min antes da
                      reserva), a conversa vai para{" "}
                      <strong>{configAniversario.atendente}</strong>.
                    </li>
                    <li>
                      A reserva só é confirmada ao cliente se sair{" "}
                      <strong>descontada do pacote</strong>. Se sair como
                      cobrança, a conversa vai para a equipe conferir.
                    </li>
                    <li>
                      Um presente por cliente a cada 300 dias, pelos registros
                      daqui.
                    </li>
                  </ul>

                  <Aviso>
                    Ao faturar a cobrança de R$ 0, o fluxo do n8n que manda o
                    template de &ldquo;fatura disponível&rdquo; manda o link de
                    pagamento ao cliente. Isso é ajuste do lado do n8n.
                  </Aviso>

                  {aniversario?.lastCheckedAt ? (
                    <p className="text-xs text-muted">
                      Última conferência com pedido: {formatarData(aniversario.lastCheckedAt)}
                      {aniversario.lastError ? ` — ${aniversario.lastError}` : ""}
                    </p>
                  ) : null}

                  {editavel ? (
                    <AniversarioConfigForm
                      habilitada={aniversario?.enabled ?? false}
                      avisar={configAniversario.avisar.map((d) => ({
                        nome: d.nome,
                        telefone: formatarTelefone(d.telefone),
                      }))}
                      caixaDoAviso={String(configAniversario.caixaDoAviso)}
                      atendente={configAniversario.atendente}
                      prazoHoras={String(configAniversario.prazoHoras)}
                      diasDepois={String(configAniversario.diasDepois)}
                      confirmacao={configAniversario.confirmacao}
                      entrega={configAniversario.entrega}
                    />
                  ) : (
                    <p className="text-sm text-muted">
                      {configAniversario.avisar.length
                        ? `Avisa ${configAniversario.avisar.length} pessoa(s) por WhatsApp.`
                        : "Ninguém cadastrado para receber o aviso."}
                    </p>
                  )}
                </Card>

                <Card className="space-y-3">
                  <h3 className="font-medium">Últimos pedidos</h3>
                  {presentes.length === 0 ? (
                    <p className="text-sm text-muted">Nenhum pedido ainda.</p>
                  ) : (
                    <Tabela
                      cabecalho={
                        <>
                          <th>Conversa</th>
                          <th>Reserva pedida</th>
                          <th>Situação</th>
                          <th>Quando</th>
                        </>
                      }
                    >
                      {presentes.map((p) => {
                        const link = linkDaConversa(p.chatwootConversationId);
                        return (
                          <tr key={p.id}>
                            <td className="whitespace-nowrap">
                              {link ? (
                                <a href={link} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                                  #{p.chatwootConversationId}
                                </a>
                              ) : (
                                `#${p.chatwootConversationId}`
                              )}
                            </td>
                            <td className="whitespace-nowrap">
                              {p.salaNome ?? `sala ${p.salaId}`}, {p.data.split("-").reverse().slice(0, 2).join("/")}, {p.inicio}–{p.fim}
                            </td>
                            <td>
                              <Badge tone={TOM_DO_PRESENTE[p.status]}>
                                {SITUACAO_DO_PRESENTE[p.status]}
                              </Badge>
                              {p.resultado ? <p className="mt-1 text-xs text-muted">{p.resultado}</p> : null}
                            </td>
                            <td className="whitespace-nowrap tabular-nums">{formatarData(p.criadoEm)}</td>
                          </tr>
                        );
                      })}
                    </Tabela>
                  )}
                </Card>
              </div>
            ),
          },
          {
            id: "nps",
            rotulo: "NPS",
            icone: <Star size={14} aria-hidden />,
            conteudo: (
              <div className="space-y-6">
                <Card className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h2 className="font-medium">Pesquisa de satisfação (NPS)</h2>
                    {nps?.enabled ? (
                      <Badge tone="success">ligada</Badge>
                    ) : (
                      <Badge>desligada</Badge>
                    )}
                  </div>

                  <p className="text-sm text-muted">
                    Quando alguém da equipe marca o checkbox numa conversa, o
                    robô da caixa desatribui a conversa e manda a pesquisa.{" "}
                    <strong>Sem modelo</strong>: as mensagens são as fixas
                    abaixo, e a nota é lida pelo sistema antes de chegar a
                    qualquer agente.
                  </p>

                  <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted">
                    <li>
                      <strong>Nota é a mensagem que é só o número de 1 a 5</strong>{" "}
                      — com estrelas, “nota” ou pontuação em volta. Qualquer
                      outra resposta encerra a pesquisa, sem lembrete, e o agente
                      atende.
                    </li>
                    <li>
                      Sem nota: lembrete depois de{" "}
                      {configNps.horasAteLembrete.toLocaleString("pt-BR")} h, e a
                      conversa é resolvida{" "}
                      {configNps.horasAteEncerrar.toLocaleString("pt-BR")} h
                      depois. Se uma pessoa assumir ou escrever antes, a pesquisa
                      não faz mais nada.
                    </li>
                    <li>
                      Com nota: a resposta sai na hora, e a conversa é resolvida
                      quando o cliente fica {configNps.minutosAposNota} min sem
                      escrever. O que ele escrever nesse meio é complemento e{" "}
                      <strong>não aciona o agente</strong>.
                    </li>
                    <li>
                      A nota vai para a task que um agente criou nesta conversa;
                      sem ela, para a mais recente do telefone nos últimos 30
                      dias, em cada lista. Sem nenhuma, fica numa nota interna.{" "}
                      <strong>O status da task não é alterado.</strong>
                    </li>
                    <li>
                      O mesmo telefone não recebe a pesquisa de novo em{" "}
                      {configNps.horasEntrePesquisas} h.
                    </li>
                  </ul>

                  <Aviso tone="danger">
                    Com o fluxo “NPS SEAHUB” publicado no n8n, ligar aqui faz o
                    cliente receber a pesquisa <strong>em dobro</strong>.
                  </Aviso>

                  <NpsConfigForm
                    valores={{
                      checkbox: configNps.checkbox,
                      caixas: configNps.caixas.join(", "),
                      listasDaNota: configNps.listasDaNota.join("\n"),
                      campoDaNota: configNps.campoDaNota,
                      campoDoTelefone: configNps.campoDoTelefone,
                      horasAteLembrete: String(configNps.horasAteLembrete).replace(".", ","),
                      horasAteEncerrar: String(configNps.horasAteEncerrar).replace(".", ","),
                      minutosAposNota: String(configNps.minutosAposNota),
                      horasEntrePesquisas: String(configNps.horasEntrePesquisas),
                      textoAgradecimento: configNps.textos.agradecimento,
                      textoConvite: configNps.textos.convite,
                      textoPergunta: configNps.textos.pergunta,
                      textoLembrete: configNps.textos.lembrete,
                      textoNotaBaixa: configNps.textos.notaBaixa,
                      textoNotaAlta: configNps.textos.notaAlta,
                    }}
                    habilitada={nps?.enabled ?? false}
                    somenteLeitura={!editavel}
                  />
                </Card>

                <Card className="space-y-3">
                  <h2 className="text-sm font-semibold">Últimas pesquisas</h2>
                  {pesquisasNps.length === 0 ? (
                    <p className="text-sm text-muted">Nenhuma pesquisa ainda.</p>
                  ) : (
                    <Tabela
                      cabecalho={
                        <>
                          <th>Conversa</th>
                          <th>Situação</th>
                          <th>Nota</th>
                          <th>Marcada em</th>
                          <th>O que aconteceu</th>
                        </>
                      }
                    >
                      {pesquisasNps.map((p) => {
                        const situacao = SITUACAO_DA_PESQUISA[p.status];
                        const link = linkDaConversa(p.chatwootConversationId);
                        return (
                          <tr key={p.id}>
                            <td className="whitespace-nowrap">
                              {link ? (
                                <a
                                  href={link}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-accent hover:underline"
                                >
                                  #{p.chatwootConversationId}
                                </a>
                              ) : (
                                `#${p.chatwootConversationId}`
                              )}
                            </td>
                            <td>
                              <Badge tone={situacao.tom}>{situacao.rotulo}</Badge>
                            </td>
                            <td>{p.nota ?? "—"}</td>
                            <td className="whitespace-nowrap text-muted">
                              {formatarData(p.marcadaEm)}
                            </td>
                            <td className="min-w-64 text-xs leading-relaxed text-muted">
                              {p.resultado ?? "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </Tabela>
                  )}
                </Card>
              </div>
            ),
          },
          {
            id: "janela",
            rotulo: "Janela",
            icone: <Hourglass size={14} aria-hidden />,
            conteudo: (
              <div className="space-y-6">
                <Card className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h2 className="font-medium">Janela de 24 h do WhatsApp</h2>
                    {janela?.enabled ? (
                      <Badge tone="success">ligada</Badge>
                    ) : (
                      <Badge>desligada</Badge>
                    )}
                    {janela?.enabled && janela.status === IntegrationStatus.ERROR ? (
                      <Badge tone="danger">última conferência falhou</Badge>
                    ) : null}
                  </div>

                  <p className="text-sm text-muted">
                    No WhatsApp oficial, a mensagem escrita só chega ao cliente
                    até 24 h depois da última mensagem <strong>dele</strong>. O
                    Chatwoot não sabe disso nesta caixa, e quem avisa a equipe
                    são as etiquetas. <strong>Sem modelo</strong>: a cada 5
                    minutos o sistema confere as conversas abertas e pendentes.
                  </p>

                  <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted">
                    <li>
                      <strong>{configJanela.minutosDeAviso} min antes de fechar</strong>,
                      deixa uma nota interna para quem atende, uma vez por
                      janela. A nota sai pelo robô da caixa.
                    </li>
                    <li>
                      <strong>Quando fecha</strong>, troca{" "}
                      <code>{ETIQUETA_ABERTA}</code> por{" "}
                      <code>{ETIQUETA_FECHADA}</code> e mantém as outras
                      etiquetas.
                    </li>
                    <li>
                      A etiqueta de aberta continua sendo posta pela automação
                      do próprio Chatwoot, a cada mensagem do cliente.
                    </li>
                  </ul>

                  <Aviso tone="warning">
                    Enquanto o fluxo “Follow - UPs Janela de Conversas” estiver
                    publicado no n8n, a conversa que ele pegar ganha as duas
                    notas. Ele também manda o e-mail de “1 mês grátis de Seabox”
                    e o follow-up das 8h ao cliente: desligar o fluxo desliga
                    essas duas coisas, que este sistema não faz.
                  </Aviso>

                  <div className="space-y-1.5">
                    <p className="text-[13px] font-medium">Como a nota sai</p>
                    <p className="rounded-lg border border-line bg-surface-2 p-3 text-sm whitespace-pre-line">
                      {previaDaNota}
                    </p>
                  </div>

                  <JanelaConfigForm
                    habilitada={janela?.enabled ?? false}
                    caixas={configJanela.caixas.join(", ")}
                    minutosDeAviso={String(configJanela.minutosDeAviso)}
                    instrucao={configJanela.instrucao}
                    somenteLeitura={!editavel}
                  />

                  {janela?.lastCheckedAt ? (
                    <p className="text-xs text-muted">
                      Última conferência: {formatarData(janela.lastCheckedAt)}
                      {janela.status === IntegrationStatus.ERROR && janela.lastError
                        ? ` — falhou: ${janela.lastError}`
                        : ""}
                    </p>
                  ) : null}
                </Card>

                <Card className="space-y-3">
                  <h2 className="text-sm font-semibold">Últimas ações</h2>
                  {acoesDaJanela.length === 0 ? (
                    <p className="text-sm text-muted">Nenhuma ainda.</p>
                  ) : (
                    <Tabela
                      cabecalho={
                        <>
                          <th>Conversa</th>
                          <th>O que fez</th>
                          <th>Quando</th>
                        </>
                      }
                    >
                      {acoesDaJanela.map((a) => {
                        const conversa = Number(
                          (a.payload as { conversationId?: unknown } | null)?.conversationId,
                        );
                        const link = Number.isInteger(conversa) ? linkDaConversa(conversa) : null;
                        return (
                          <tr key={a.id}>
                            <td className="whitespace-nowrap">
                              {link ? (
                                <a
                                  href={link}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-accent hover:underline"
                                >
                                  #{conversa}
                                </a>
                              ) : Number.isInteger(conversa) ? (
                                `#${conversa}`
                              ) : (
                                "—"
                              )}
                            </td>
                            <td>
                              <Badge tone={a.resultado === "nota deixada" ? "accent" : "neutral"}>
                                {a.resultado ?? "—"}
                              </Badge>
                              {a.detalhe ? (
                                <span className="ml-2 text-xs text-muted">{a.detalhe}</span>
                              ) : null}
                            </td>
                            <td className="whitespace-nowrap text-muted">
                              {formatarData(a.createdAt)}
                            </td>
                          </tr>
                        );
                      })}
                    </Tabela>
                  )}
                </Card>
              </div>
            ),
          },
          {
            id: "cobranca",
            rotulo: "Cobrança",
            icone: <Receipt size={14} aria-hidden />,
            conteudo: (
              <div className="space-y-6">
                <Card className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h2 className="font-medium">Aviso de cobrança (ClickUp)</h2>
                    {cobranca?.enabled ? (
                      <Badge tone="success">ligado</Badge>
                    ) : (
                      <Badge>desligado</Badge>
                    )}
                  </div>

                  <p className="text-sm text-muted">
                    Ponha a etiqueta <strong>cobranca-1</strong> ou{" "}
                    <strong>cobranca-2</strong> numa task da{" "}
                    <strong>Base de clientes</strong> no ClickUp, e o cliente
                    recebe a mensagem da etiqueta pelo WhatsApp, no número do campo{" "}
                    <strong>CELULAR</strong>. Depois do envio a etiqueta sai e a
                    task ganha um comentário. Sem modelo: as mensagens são as de
                    baixo, letra por letra.
                  </p>

                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                    <li>
                      Confere a cada <strong>30 minutos</strong>, de segunda a
                      sexta, das 8h às 18h. Etiqueta posta fora disso espera.
                    </li>
                    <li>
                      Um envio a cada {configCobranca.intervaloSegundos} segundos, no
                      máximo {configCobranca.tetoPorHora} por hora: a caixa{" "}
                      {configCobranca.caixaId} é conexão não oficial do WhatsApp, e
                      lote disparado de uma vez é como o número é bloqueado.
                    </li>
                    <li>
                      Sem CELULAR válido, ou número recusado, nada sai: a etiqueta{" "}
                      <strong>fica</strong> e a task ganha um comentário dizendo
                      por quê, uma vez só.
                    </li>
                    <li>
                      A mensagem aparece no Chatwoot em nome da pessoa dona do
                      token de Integrações → Chatwoot, com uma nota interna
                      dizendo de qual task veio.
                    </li>
                  </ul>

                  {cobranca?.lastCheckedAt ? (
                    <p className="text-xs text-muted">
                      Última conferência: {formatarData(cobranca.lastCheckedAt)}
                      {cobranca.lastError ? ` — ${cobranca.lastError}` : ""}
                    </p>
                  ) : null}

                  <CobrancaConfigForm
                    habilitada={cobranca?.enabled ?? false}
                    caixaId={String(configCobranca.caixaId)}
                    aposEnviar={configCobranca.aposEnviar}
                    atribuirA={configCobranca.atribuirA}
                    mensagem1={configCobranca.mensagens["cobranca-1"]}
                    mensagem2={configCobranca.mensagens["cobranca-2"]}
                    somenteLeitura={!editavel}
                  />
                </Card>

                <Card className="space-y-3">
                  <h3 className="font-medium">Últimos envios</h3>
                  {avisosDeCobranca.length === 0 ? (
                    <p className="text-sm text-muted">Nenhum envio ainda.</p>
                  ) : (
                    <Tabela
                      cabecalho={
                        <>
                          <th>Task</th>
                          <th>Aviso</th>
                          <th>O que aconteceu</th>
                          <th>Conversa</th>
                          <th>Quando</th>
                        </>
                      }
                    >
                      {avisosDeCobranca.map((a) => {
                        const p = (a.payload ?? {}) as {
                          taskUrl?: string | null;
                          taskId?: string;
                          conversaId?: number;
                        };
                        const link = p.conversaId ? linkDaConversa(p.conversaId) : null;
                        return (
                          <tr key={a.id}>
                            <td className="whitespace-nowrap">
                              {p.taskUrl ? (
                                <a href={p.taskUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                                  {p.taskId ?? "task"}
                                </a>
                              ) : (
                                (p.taskId ?? "—")
                              )}
                            </td>
                            <td className="whitespace-nowrap">{a.eventType}</td>
                            <td>
                              <Badge tone={a.resultado === "enviado" ? "success" : a.resultado === "falhou" ? "danger" : "neutral"}>
                                {a.resultado ?? "—"}
                              </Badge>
                              {a.detalhe ? <span className="ml-2 text-xs text-muted">{a.detalhe}</span> : null}
                            </td>
                            <td className="whitespace-nowrap">
                              {link ? (
                                <a href={link} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                                  #{p.conversaId}
                                </a>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="whitespace-nowrap tabular-nums">{formatarData(a.createdAt)}</td>
                          </tr>
                        );
                      })}
                    </Tabela>
                  )}
                </Card>
              </div>
            ),
          },
          {
            id: "google",
            // "Google" e não "Google Workspace": é o rótulo mais longo da tira, e
            // com sete abas ele empurrava "Leitura de mídia" para fora da tela.
            // O nome completo está no título do cartão, logo abaixo.
            rotulo: "Google",
            icone: <Table2 size={14} aria-hidden />,
            contador: toolsGoogle,
            alerta: !google?.enabled,
            conteudo: (
              <Card className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="font-medium">Google Workspace</h2>
                  {google?.enabled ? (
                    <Badge tone="success">ligada</Badge>
                  ) : (
                    <Badge>desligada</Badge>
                  )}
                  {google?.status === IntegrationStatus.OK ? (
                    <Badge tone="success">conexão ok</Badge>
                  ) : google?.status === IntegrationStatus.ERROR ? (
                    <Badge tone="danger">falha na conexão</Badge>
                  ) : null}
                </div>

                {/* "Nunca vê um id" era falso: a listagem de pasta devolve o
                    id de cada arquivo. O que sustenta a allowlist é outra
                    afirmação, essa verdadeira — nenhuma tool aceita id de
                    volta; ele aparece no retorno para uma pessoa cadastrar o
                    arquivo. */}
                <p className="text-sm text-muted">
                  Planilhas do Sheets, documentos do Docs e pastas do Drive, por
                  uma conta de serviço. Os arquivos são cadastrados{" "}
                  <strong>por nome</strong>: o agente pede pelo nome,{" "}
                  <strong>nenhuma ferramenta aceita id</strong>, e ele não
                  alcança nada que esteja fora da lista. O agente recebe{" "}
                  {toolsGoogle} ferramenta(s) quando esta integração está ligada
                  para ele.
                </p>

                <GoogleConfigForm
                  contaEmail={contaGoogle?.contaEmail ?? null}
                  projectId={contaGoogle?.projectId ?? null}
                  planilhas={configGoogle.planilhas
                    .map((p) => `${p.nome} = ${p.id}`)
                    .join("\n")}
                  documentos={configGoogle.documentos
                    .map((d) => `${d.nome} = ${d.id}`)
                    .join("\n")}
                  modelos={configGoogle.modelos
                    .map((m) => `${m.nome} = ${m.id}`)
                    .join("\n")}
                  pastas={configGoogle.pastas
                    .map((p) => `${p.nome} = ${p.id}`)
                    .join("\n")}
                  driveCompartilhadoId={configGoogle.driveCompartilhadoId}
                  limiteDeLinhas={configGoogle.limiteDeLinhas}
                  personificar={configGoogle.personificar}
                  habilitada={google?.enabled ?? false}
                  temChave={Boolean(google?.credential)}
                  hintChave={google?.credential?.hint ?? null}
                  somenteLeitura={!editavel}
                  podeEditarCredencial={sessao.user.role === UserRole.OWNER}
                />

                {/* ⚠ Sob a MESMA condição do e-mail da conta de serviço, e não
                    é excesso de zelo: as mensagens de erro de `google/client.ts`
                    interpolam `client_email` e `project_id`. O papel Leitura
                    acabou de ler, poucos blocos acima, que o endereço da conta
                    não aparece para ele — mostrá-lo aqui, dentro do erro,
                    desmentiria a barreira que a própria tela anuncia. Segredo
                    não é, mas tela que contradiz o que promete ensina a não
                    acreditar no resto. */}
                {editavel && google?.lastError ? (
                  <Aviso tone="danger">
                    Último teste falhou: {google.lastError}
                    {google.lastCheckedAt
                      ? ` (${formatarData(google.lastCheckedAt)})`
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
                    modelos={modelosOpenAI}
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
