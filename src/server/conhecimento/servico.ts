import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { reconciliarSetor } from "@/lib/setor";
import { auditar, type Autor } from "@/server/gestao/autor";
import { setoresGravados } from "./consulta";
import {
  cabeNoAgente,
  documentoSchema,
  MAX_CARACTERES_POR_AGENTE,
  normalizarTexto,
  type DadosDoDocumento,
} from "./regras";

/**
 * O que se pode fazer com um documento de apoio — a regra, sem a porta.
 *
 * Só o painel escreve aqui (o MCP não tem ferramenta de documento), mas a regra
 * mora no serviço pela mesma razão das de agente: a tela decide o papel e o
 * formato, e o que é permitido fazer com o documento é um lugar só.
 */

export type Recusa = { erro: string; camposComErro?: Record<string, string> };

export type Gravacao = { ok: true; id: string } | ({ ok: false } & Recusa);
export type Desfecho = { ok: string } | { erro: string };

function formatar(numero: number) {
  return numero.toLocaleString("pt-BR");
}

function recusaDeValidacao(
  issues: { path: PropertyKey[]; message: string }[],
): Recusa {
  return {
    erro: "Confira os campos destacados.",
    camposComErro: Object.fromEntries(
      issues.map((i) => [i.path.join("."), i.message]),
    ),
  };
}

function textoDoTeto(nomeDoAgente: string, total: number) {
  return `O agente "${nomeDoAgente}" passaria a receber ${formatar(total)} caracteres em documentos, e o teto é ${formatar(MAX_CARACTERES_POR_AGENTE)}: o prompt estouraria a janela do modelo e o agente deixaria de responder. Tire um documento dele ou encurte este.`;
}

/**
 * Cada agente vinculado ao documento continua dentro do teto com o texto novo?
 * Devolve a recusa, ou `null`.
 */
async function conferirAgentesDoDocumento(
  documentoId: string,
  textoNovo: string,
): Promise<string | null> {
  const vinculados = await db.documentoDoAgente.findMany({
    where: { documentoId },
    select: {
      agent: {
        select: {
          name: true,
          documentos: {
            where: { documentoId: { not: documentoId } },
            select: { documento: { select: { texto: true } } },
          },
        },
      },
    },
  });

  for (const { agent } of vinculados) {
    const { cabe, total } = cabeNoAgente([
      ...agent.documentos.map((d) => d.documento),
      { texto: textoNovo },
    ]);
    if (!cabe) return textoDoTeto(agent.name, total);
  }
  return null;
}

export async function criarDocumento(
  dados: DadosDoDocumento,
  autor: Autor,
): Promise<Gravacao> {
  const parsed = documentoSchema.safeParse({
    ...dados,
    texto: normalizarTexto(dados.texto),
  });
  if (!parsed.success) {
    return { ok: false, ...recusaDeValidacao(parsed.error.issues) };
  }

  const homonimo = await db.documentoDeConhecimento.findUnique({
    where: { nome: parsed.data.nome },
    select: { id: true },
  });
  if (homonimo) {
    return {
      ok: false,
      erro: "Já existe um documento com esse nome.",
      camposComErro: { nome: "Nome em uso" },
    };
  }

  const setor = reconciliarSetor(parsed.data.setor, await setoresGravados());

  const criado = await db.documentoDeConhecimento.create({
    data: {
      nome: parsed.data.nome,
      descricao: parsed.data.descricao || null,
      setor,
      texto: parsed.data.texto,
      origem: parsed.data.origem || null,
    },
    select: { id: true },
  });

  await auditar(autor, "documento.created", "DocumentoDeConhecimento", criado.id, {
    nome: parsed.data.nome,
    caracteres: parsed.data.texto.length,
  });

  revalidatePath("/documentos");
  return { ok: true, id: criado.id };
}

export async function atualizarDocumento(
  id: string,
  dados: DadosDoDocumento,
  autor: Autor,
): Promise<Gravacao> {
  const parsed = documentoSchema.safeParse({
    ...dados,
    texto: normalizarTexto(dados.texto),
  });
  if (!parsed.success) {
    return { ok: false, ...recusaDeValidacao(parsed.error.issues) };
  }

  const atual = await db.documentoDeConhecimento.findUnique({
    where: { id },
    select: { nome: true, texto: true },
  });
  if (!atual) return { ok: false, erro: "Documento não encontrado." };

  if (parsed.data.nome !== atual.nome) {
    const homonimo = await db.documentoDeConhecimento.findUnique({
      where: { nome: parsed.data.nome },
      select: { id: true },
    });
    if (homonimo) {
      return {
        ok: false,
        erro: "Já existe um documento com esse nome.",
        camposComErro: { nome: "Nome em uso" },
      };
    }
  }

  const estourou = await conferirAgentesDoDocumento(id, parsed.data.texto);
  if (estourou) return { ok: false, erro: estourou };

  const setor = reconciliarSetor(parsed.data.setor, await setoresGravados());

  await db.documentoDeConhecimento.update({
    where: { id },
    data: {
      nome: parsed.data.nome,
      descricao: parsed.data.descricao || null,
      setor,
      texto: parsed.data.texto,
      // Só troca a origem quando veio uma — editar o texto à mão não apaga de
      // onde o documento veio.
      ...(parsed.data.origem ? { origem: parsed.data.origem } : {}),
    },
  });

  const mudouOTexto = atual.texto !== parsed.data.texto;
  await auditar(autor, "documento.updated", "DocumentoDeConhecimento", id, {
    nome: parsed.data.nome,
    caracteres: parsed.data.texto.length,
    mudouOTexto,
    // Documento não tem histórico de versões como o prompt do agente, e um
    // playbook editado por engano não volta de outro lugar: o texto de antes
    // fica aqui, que é por onde se recupera.
    ...(mudouOTexto ? { textoAnterior: atual.texto } : {}),
  });

  // O texto vale para os agentes vinculados a partir da próxima mensagem, e a
  // tela de cada um mostra o peso dele.
  revalidatePath("/documentos");
  revalidatePath("/agentes", "layout");
  return { ok: true, id };
}

/**
 * Apaga o documento — e o vínculo com todo agente, na hora. Os agentes param de
 * recebê-lo na próxima mensagem.
 */
export async function excluirDocumento(
  id: string,
  autor: Autor,
): Promise<Desfecho> {
  const documento = await db.documentoDeConhecimento.findUnique({
    where: { id },
    select: { nome: true, texto: true, _count: { select: { agentes: true } } },
  });
  if (!documento) return { erro: "Documento não encontrado." };

  await db.documentoDeConhecimento.delete({ where: { id } });

  await auditar(autor, "documento.deleted", "DocumentoDeConhecimento", id, {
    nome: documento.nome,
    agentesQueRecebiam: documento._count.agentes,
    // Apagar leva o texto junto; a auditoria é o único lugar onde ele sobra.
    texto: documento.texto,
  });

  revalidatePath("/documentos");
  revalidatePath("/agentes", "layout");

  const n = documento._count.agentes;
  return {
    ok:
      n === 0
        ? "Documento apagado."
        : `Documento apagado. ${n === 1 ? "1 agente deixa" : `${n} agentes deixam`} de recebê-lo na próxima mensagem.`,
  };
}

/**
 * Define QUAIS agentes recebem o documento — o conjunto inteiro, de uma vez.
 *
 * ⚠ Só mexe nos agentes que NÃO estão arquivados. A tela não lista arquivado, e
 * "substituir o conjunto" a partir dela apagaria em silêncio o vínculo de quem
 * ela nunca mostrou — que reapareceria sem o playbook no dia em que fosse
 * restaurado.
 */
export async function definirAgentesDoDocumento(
  documentoId: string,
  agentIds: readonly string[],
  autor: Autor,
): Promise<Desfecho> {
  const documento = await db.documentoDeConhecimento.findUnique({
    where: { id: documentoId },
    select: { nome: true, texto: true },
  });
  if (!documento) return { erro: "Documento não encontrado." };

  const pedidos = [...new Set(agentIds.filter((a) => typeof a === "string" && a))];
  const agentes = await db.agent.findMany({
    where: { id: { in: pedidos }, archivedAt: null },
    select: {
      id: true,
      name: true,
      documentos: {
        where: { documentoId: { not: documentoId } },
        select: { documento: { select: { texto: true } } },
      },
    },
  });

  for (const agente of agentes) {
    const { cabe, total } = cabeNoAgente([
      ...agente.documentos.map((d) => d.documento),
      documento,
    ]);
    if (!cabe) return { erro: textoDoTeto(agente.name, total) };
  }

  const ids = agentes.map((a) => a.id);
  await db.$transaction([
    db.documentoDoAgente.deleteMany({
      where: { documentoId, agentId: { notIn: ids }, agent: { archivedAt: null } },
    }),
    db.documentoDoAgente.createMany({
      data: ids.map((agentId) => ({ documentoId, agentId })),
      skipDuplicates: true,
    }),
  ]);

  await auditar(autor, "documento.vinculos.updated", "DocumentoDeConhecimento", documentoId, {
    nome: documento.nome,
    agentes: agentes.map((a) => a.name),
  });

  revalidatePath("/documentos");
  revalidatePath("/agentes", "layout");
  return {
    ok:
      ids.length === 0
        ? "Nenhum agente recebe este documento."
        : `${ids.length === 1 ? "1 agente recebe" : `${ids.length} agentes recebem`} este documento a partir da próxima mensagem.`,
  };
}

/**
 * O mesmo vínculo, pelo outro lado: QUAIS documentos o agente recebe.
 *
 * Aqui o conjunto é de todos os documentos — a tela do agente lista todos —,
 * então substituir é seguro.
 */
export async function definirDocumentosDoAgente(
  agentId: string,
  documentoIds: readonly string[],
  autor: Autor,
): Promise<Desfecho> {
  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { name: true, archivedAt: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };
  if (agente.archivedAt) {
    return { erro: "Agente arquivado não recebe documentos. Restaure antes." };
  }

  const pedidos = [...new Set(documentoIds.filter((d) => typeof d === "string" && d))];
  const documentos = await db.documentoDeConhecimento.findMany({
    where: { id: { in: pedidos } },
    select: { id: true, nome: true, texto: true },
  });

  const { cabe, total } = cabeNoAgente(documentos);
  if (!cabe) return { erro: textoDoTeto(agente.name, total) };

  const ids = documentos.map((d) => d.id);
  await db.$transaction([
    db.documentoDoAgente.deleteMany({ where: { agentId, documentoId: { notIn: ids } } }),
    db.documentoDoAgente.createMany({
      data: ids.map((documentoId) => ({ documentoId, agentId })),
      skipDuplicates: true,
    }),
  ]);

  await auditar(autor, "agent.documentos.updated", "Agent", agentId, {
    documentos: documentos.map((d) => d.nome),
  });

  revalidatePath("/documentos");
  revalidatePath(`/agentes/${agentId}`);
  return {
    ok:
      ids.length === 0
        ? "Este agente não recebe nenhum documento."
        : `${ids.length === 1 ? "1 documento" : `${ids.length} documentos`} no prompt deste agente, a partir da próxima mensagem.`,
  };
}
