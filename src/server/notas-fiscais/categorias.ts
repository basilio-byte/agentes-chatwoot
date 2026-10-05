import { logger } from "@/lib/logger";
import { juntarPaginas } from "@/server/integrations/conexa/client";
import { abrirConexa } from "@/server/integrations/conexa/sistema";

/**
 * As categorias de serviço do Conexa, para a tela montar a tabela de códigos.
 *
 * A página de Integrações é componente de servidor e renderiza todas as abas a
 * cada abertura. Por isso a lista fica em memória por uma hora, e a leitura tem
 * prazo curto: um Conexa lento não pode segurar a página inteira.
 */

export type CategoriaDeServico = {
  id: number;
  nome: string;
  empresas: { id: number; nome: string }[];
  ativa: boolean;
};

const VALIDADE_MS = 60 * 60_000;
const PRAZO_MS = 6_000;

let guardadas: { em: number; categorias: CategoriaDeServico[] } | null = null;

export function lerCategoria(bruto: Record<string, unknown>): CategoriaDeServico | null {
  const id = Number(bruto.serviceCategoryId ?? bruto.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const empresas = Array.isArray(bruto.companies)
    ? (bruto.companies as Array<Record<string, unknown>>)
        .map((e) => ({ id: Number(e.id), nome: String(e.name ?? "").trim() }))
        .filter((e) => Number.isInteger(e.id))
    : [];
  return {
    id,
    nome: String(bruto.name ?? `categoria ${id}`).trim(),
    empresas,
    ativa: bruto.isActive !== false,
  };
}

export async function categoriasDoConexa(
  agora = Date.now(),
): Promise<{ categorias: CategoriaDeServico[]; erro?: string }> {
  if (guardadas && agora - guardadas.em < VALIDADE_MS) return { categorias: guardadas.categorias };

  const reserva = guardadas?.categorias ?? [];
  try {
    const lidas = await Promise.race([
      ler(),
      new Promise<never>((_, recusar) =>
        setTimeout(() => recusar(new Error("o Conexa não respondeu a tempo")), PRAZO_MS),
      ),
    ]);
    if ("erro" in lidas) return { categorias: reserva, erro: lidas.erro };
    guardadas = { em: agora, categorias: lidas.categorias };
    return { categorias: lidas.categorias };
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    logger.warn({ erro: mensagem }, "notas fiscais: categorias do Conexa não lidas");
    return { categorias: reserva, erro: mensagem };
  }
}

async function ler(): Promise<{ categorias: CategoriaDeServico[] } | { erro: string }> {
  const aberto = await abrirConexa("notas-fiscais");
  if ("erro" in aberto) return { erro: aberto.erro };
  const { itens } = await juntarPaginas(
    (p) => aberto.cliente.listarCategoriasDeServico(p),
    { porPagina: 100, teto: 500 },
  );
  const categorias = itens
    .map(lerCategoria)
    .filter((c): c is CategoriaDeServico => c !== null)
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR") || a.id - b.id);
  return { categorias };
}

/** Só para teste. */
export function esquecerCategorias() {
  guardadas = null;
}
