import { FilePlus2, FileText } from "lucide-react";
import { db } from "@/lib/db";
import { bateComOFiltro, listarSetores, SEM_SETOR } from "@/lib/setor";
import { exigirSessao, podeEditar } from "@/server/auth-guard";
import { tokensDoTexto } from "@/server/conhecimento/regras";
import { DocumentoForm } from "@/components/documento-form";
import { Filtros, type Campo } from "@/components/filtros";
import { Recolhivel } from "@/components/recolhivel";
import { Aviso, Badge, EmptyState, Meta, PageHeader } from "@/components/ui";
import { formatarData } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Busca = { setor?: string };

/**
 * Documentos de apoio dos agentes — o "Playbook comercial", a "Matriz de
 * qualificação": texto que a equipe escreve uma vez e vincula a quantos agentes
 * quiser. O vínculo também se faz pela aba Documentos de cada agente.
 */
export default async function DocumentosPage({
  searchParams,
}: {
  searchParams: Promise<Busca>;
}) {
  const busca = await searchParams;
  const sessao = await exigirSessao();
  const editavel = podeEditar(sessao.user.role);

  const [documentos, agentes] = await Promise.all([
    db.documentoDeConhecimento.findMany({
      orderBy: { nome: "asc" },
      include: { agentes: { select: { agentId: true } } },
    }),
    db.agent.findMany({
      where: { archivedAt: null },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: { id: true, name: true, setor: true },
    }),
  ]);

  // O vocabulário é um só: o filtro lista os setores de agentes e de documentos.
  const setores = listarSetores([
    ...documentos.map((d) => d.setor),
    ...agentes.map((a) => a.setor),
  ]);
  const filtro = busca.setor || null;
  const visiveis = documentos.filter((d) => bateComOFiltro(d.setor, filtro));
  const nomesDosAgentes = new Map(agentes.map((a) => [a.id, a.name]));

  const campos: Campo[] = [
    {
      tipo: "select",
      chave: "setor",
      rotulo: "Setor",
      opcoes: [
        { valor: "", rotulo: "Todos os setores" },
        ...setores.map((s) => ({ valor: s, rotulo: s })),
        { valor: SEM_SETOR, rotulo: "Sem setor" },
      ],
    },
  ];

  const agentesParaMarcar = agentes.map((a) => ({
    id: a.id,
    nome: a.name,
    setor: a.setor,
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        titulo="Documentos"
        descricao="Textos que dão base aos agentes — o playbook comercial, a matriz de qualificação. Cada documento vinculado entra no prompt do agente, em toda mensagem; por isso o peso de cada um aparece em tokens."
      />

      <Aviso>
        O agente lê <strong>texto</strong>. Arquivos .txt e .md são carregados
        aqui mesmo; PDF e Word não são lidos automaticamente — abra o documento,
        copie o texto e cole no campo, e confira o que ficou antes de salvar. É
        isso que o agente vai tratar como instrução.
      </Aviso>

      {editavel ? (
        <Recolhivel
          titulo="Novo documento"
          icone={<FilePlus2 size={15} aria-hidden />}
          resumo="Cole o texto ou carregue um arquivo, e marque quais agentes o recebem."
          padraoAberto={documentos.length === 0}
        >
          <DocumentoForm
            agentes={agentesParaMarcar}
            vinculados={[]}
            setoresEmUso={setores}
            somenteLeitura={false}
          />
        </Recolhivel>
      ) : null}

      <Filtros campos={campos} valores={busca} />

      {visiveis.length === 0 ? (
        <EmptyState
          icone={<FileText size={18} aria-hidden />}
          titulo={
            documentos.length === 0
              ? "Nenhum documento ainda"
              : "Nenhum documento nesse setor"
          }
          descricao={
            documentos.length === 0
              ? "Crie o primeiro acima. Ele só chega a um agente depois de vinculado."
              : "Tire o filtro para ver todos."
          }
        />
      ) : (
        <div className="space-y-2">
          {visiveis.map((d) => {
            const ids = d.agentes.map((v) => v.agentId);
            // Só conta quem está na lista: o arquivado continua vinculado, mas
            // não recebe nada enquanto estiver fora de circulação.
            const ativos = ids.filter((id) => nomesDosAgentes.has(id));

            return (
              <Recolhivel
                key={d.id}
                titulo={d.nome}
                icone={<FileText size={15} aria-hidden />}
                estado={
                  <>
                    {d.setor ? <Badge>{d.setor}</Badge> : null}
                    {ativos.length === 0 ? (
                      <Badge tone="warning" title="Nenhum agente recebe este documento">
                        sem agente
                      </Badge>
                    ) : null}
                  </>
                }
                resumo={
                  <>
                    {ativos.length === 0
                      ? "ninguém recebe"
                      : `${ativos.length} agente${ativos.length > 1 ? "s" : ""}`}{" "}
                    · ~{tokensDoTexto(d.texto.length).toLocaleString("pt-BR")}{" "}
                    tokens por mensagem · alterado em {formatarData(d.updatedAt)}
                  </>
                }
              >
                <Meta className="block">
                  {ativos.length > 0
                    ? `Recebem: ${ativos.map((id) => nomesDosAgentes.get(id)).join(", ")}.`
                    : "Nenhum agente recebe este documento ainda."}
                </Meta>
                <DocumentoForm
                  documento={{
                    id: d.id,
                    nome: d.nome,
                    descricao: d.descricao ?? "",
                    setor: d.setor ?? "",
                    texto: d.texto,
                    origem: d.origem ?? "",
                  }}
                  agentes={agentesParaMarcar}
                  vinculados={ids}
                  setoresEmUso={setores}
                  somenteLeitura={!editavel}
                />
              </Recolhivel>
            );
          })}
        </div>
      )}
    </div>
  );
}
