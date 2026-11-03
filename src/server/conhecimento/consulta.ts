import { db } from "@/lib/db";
import { listarSetores } from "@/lib/setor";
import type { DocumentoParaOPrompt } from "./regras";

/**
 * Leitura dos documentos de apoio — a parte que o WORKER também usa.
 *
 * Separado de `servico.ts` de propósito: o worker é um bundle do esbuild e não
 * pode importar `next/cache`, que a escrita precisa para revalidar as telas.
 * Este arquivo só fala com o banco.
 */

/**
 * Os documentos que um agente recebe no prompt.
 *
 * Uma consulta por turno, pela chave primária composta (o índice por `agentId`
 * já existe). Não captura erro: se o banco falhou aqui, falhou para o resto do
 * turno também, e um agente que responde SEM o playbook que a equipe vinculou é
 * pior do que um turno que tenta de novo.
 */
export async function documentosDoAgente(
  agentId: string,
): Promise<DocumentoParaOPrompt[]> {
  const vinculos = await db.documentoDoAgente.findMany({
    where: { agentId },
    select: {
      documento: {
        select: { nome: true, descricao: true, setor: true, texto: true },
      },
    },
  });

  return vinculos.map((v) => v.documento);
}

/**
 * Todo setor em uso, de agentes e de documentos, sem repetir a mesma área.
 *
 * É a lista de sugestões dos formulários e a de opções dos filtros. Os dois
 * lados entram porque o setor é um vocabulário só: um documento do "Comercial"
 * e um agente do "Comercial" têm de aparecer sob o mesmo nome.
 */
export async function setoresEmUso(): Promise<string[]> {
  const [agentes, documentos] = await Promise.all([
    db.agent.findMany({ select: { setor: true } }),
    db.documentoDeConhecimento.findMany({ select: { setor: true } }),
  ]);

  return listarSetores([
    ...agentes.map((a) => a.setor),
    ...documentos.map((d) => d.setor),
  ]);
}

/** Os valores crus, para reconciliar a grafia de um setor na gravação. */
export async function setoresGravados(): Promise<(string | null)[]> {
  const [agentes, documentos] = await Promise.all([
    db.agent.findMany({ select: { setor: true }, distinct: ["setor"] }),
    db.documentoDeConhecimento.findMany({
      select: { setor: true },
      distinct: ["setor"],
    }),
  ]);

  return [...agentes.map((a) => a.setor), ...documentos.map((d) => d.setor)];
}
