import type { MacroChatwoot } from "@/server/integrations/chatwoot/client";

/**
 * Materiais prontos: as imagens que a equipe já manda pelos macros do Chatwoot.
 *
 * Pedido do usuário em 22/09/2026, do checklist da equipe ("adicionar ao agente
 * os formatos, capacidades de cada sala e se possível foto"). O Diego apontou
 * que tudo isso já existe nos macros — cada sala tem uma "Capa" (nome,
 * capacidade, unidade e comodidades) e uma de "Fotos". Na conversa 14149 o
 * cliente perguntou "Tem fotos das salas?" e o Diego mandou quatro imagens à
 * mão; é isso que o agente passa a fazer.
 *
 * A fonte continua sendo o macro, mantido pela equipe: trocar a foto lá troca o
 * que o agente manda, sem deploy. Capacidade duplicada é a que diverge.
 */

/**
 * Prefixos padrão: salas de reunião, de atendimento, cabine e auditório.
 *
 * Linha que começa com "-" EXCLUI: o "[SA] Promoção de Pacotes de Horas —
 * Maio.25" é uma promoção vencida que o prefixo "[SA]" levaria junto (visto
 * ao rodar contra os macros reais, em 22/09/2026).
 */
export const PREFIXOS_PADRAO = ["[SR]", "[SA]", "[CA]", "[A]", "-[SA] Promoção"];

/** Teto de arquivos por envio: um material de sala tem duas imagens. */
export const MAX_ARQUIVOS = 6;

export type ArquivoDoMaterial = {
  blobId: number;
  nome: string;
  tipo: string;
  url: string;
};

export type Material = {
  id: number;
  nome: string;
  arquivos: ArquivoDoMaterial[];
};

/** Sem acento, sem caixa, espaços únicos: "Reunião  02" casa com "reuniao 02". */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * O nome do macro começa por um prefixo liberado — e por nenhum excluído?
 *
 * Exclusão ("-[SA] Promoção") vence inclusão: é como se tira da lista um macro
 * velho sem ter de listar um a um todos os outros do mesmo prefixo.
 */
export function liberado(nome: string, prefixos: string[]): boolean {
  const alvo = normalizar(nome);
  const regras = prefixos.map(normalizar).filter(Boolean);
  const excluidos = regras.filter((p) => p.startsWith("-")).map((p) => p.slice(1).trim());
  const incluidos = regras.filter((p) => !p.startsWith("-"));
  if (excluidos.some((p) => p && alvo.startsWith(p))) return false;
  return incluidos.some((p) => alvo.startsWith(p));
}

/** Palavras que não distinguem um material de outro no pedido do agente. */
const PALAVRAS_VAZIAS = new Set([
  "a", "o", "e", "de", "da", "do", "das", "dos", "na", "no",
  "sala", "salas", "foto", "fotos", "imagem", "imagens", "material",
]);

/** As palavras de um nome: "[SR] Seaway Reunião 02/6P" → sr, seaway, reuniao, 02, 6p. */
function palavras(texto: string): string[] {
  return normalizar(texto).split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Os arquivos que o macro manda HOJE, na ordem das ações.
 *
 * ⚠ Não é a lista `files`: ela guarda também anexos antigos que a equipe já
 * trocou (o "[SR] Seaway Reunião 01" ainda carrega a foto de antes da capa
 * nova). O que vale são os ids em `send_attachment`; o `files` só diz onde
 * cada um mora.
 */
export function arquivosDoMacro(macro: MacroChatwoot): ArquivoDoMaterial[] {
  const porBlob = new Map((macro.files ?? []).map((f) => [f.blob_id, f]));
  const ids = (macro.actions ?? [])
    .filter((a) => a.action_name === "send_attachment")
    .flatMap((a) => a.action_params ?? [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);

  const vistos = new Set<number>();
  const arquivos: ArquivoDoMaterial[] = [];
  for (const id of ids) {
    const arquivo = porBlob.get(id);
    if (!arquivo || vistos.has(id)) continue;
    vistos.add(id);
    arquivos.push({
      blobId: id,
      nome: arquivo.filename?.trim() || `arquivo-${id}`,
      tipo: arquivo.file_type?.trim() || "application/octet-stream",
      url: arquivo.file_url,
    });
  }
  return arquivos;
}

/**
 * Os materiais que os agentes podem mandar: macros GLOBAIS, com nome liberado
 * e ao menos um arquivo.
 *
 * Macro pessoal fica de fora: é de uma pessoa da equipe, e o que ela guarda ali
 * não foi pensado para sair pelo robô.
 */
export function materiaisDisponiveis(
  macros: MacroChatwoot[],
  prefixos: string[],
): Material[] {
  return macros
    .filter((m) => (m.visibility ?? "").toLowerCase() === "global")
    .filter((m) => liberado(m.name, prefixos))
    .map((m) => ({ id: m.id, nome: m.name.trim(), arquivos: arquivosDoMacro(m) }))
    .filter((m) => m.arquivos.length > 0)
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

export type Escolha =
  | { tipo: "achado"; material: Material }
  | { tipo: "nenhum"; disponiveis: string[] }
  | { tipo: "ambiguo"; candidatos: string[] };

/**
 * Qual material o agente pediu.
 *
 * Nome igual (sem acento e sem caixa) ganha; senão, vale o que tiver TODAS as
 * palavras do pedido — "reunião 02 seaway" acha "[SR] Seaway Reunião 02/6P".
 * Mais de um candidato não vira palpite: mandar a foto da sala errada é o
 * cliente chegando na porta esperando outra sala.
 *
 * ⚠ Palavra INTEIRA, não trecho: "formato U" por trecho casava com todo nome
 * que tivesse a letra u — "Auditório" inclusive. Só palavra de 4 letras ou
 * mais casa pelo começo ("reuni" acha "reunião").
 */
export function escolherMaterial(pedido: string, materiais: Material[]): Escolha {
  const alvo = normalizar(pedido);
  const exato = materiais.find((m) => normalizar(m.nome) === alvo);
  if (exato) return { tipo: "achado", material: exato };

  const doPedido = palavras(pedido).filter((p) => !PALAVRAS_VAZIAS.has(p));
  const candidatos = doPedido.length
    ? materiais.filter((m) => {
        const doNome = palavras(m.nome);
        return doPedido.every((p) =>
          doNome.some((n) => n === p || (p.length >= 4 && n.startsWith(p))),
        );
      })
    : [];

  if (candidatos.length === 1) return { tipo: "achado", material: candidatos[0] };
  if (candidatos.length > 1) {
    return { tipo: "ambiguo", candidatos: candidatos.map((m) => m.nome) };
  }
  return { tipo: "nenhum", disponiveis: materiais.map((m) => m.nome) };
}

/** Lê os prefixos da configuração: lista, ou texto com um por linha/vírgula. */
export function lerPrefixos(bruto: unknown): string[] {
  const lista = Array.isArray(bruto)
    ? bruto.map(String)
    : typeof bruto === "string"
      ? bruto.split(/[\n,]/)
      : null;
  if (!lista) return [...PREFIXOS_PADRAO];
  return lista.map((p) => p.trim()).filter(Boolean);
}
