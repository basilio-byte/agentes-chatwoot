import { IntegrationProvider } from "@/generated/prisma/enums";
import { decifrar } from "@/lib/crypto";
import { db } from "@/lib/db";
import { lerComReserva } from "@/lib/leitura-remota";
import type { ModelosParaEscolher } from "@/server/actions/openai";
import { macrosDoChatwoot } from "@/server/integrations/materiais";
import {
  comSelecionado,
  gruposParaAudio,
  gruposParaTexto,
  LEITURA_MODELOS_OPENAI,
  modelosDaConta,
  type CatalogoDaConta,
} from "@/server/integrations/openai/catalogo";
import { lerConfigOpenAI } from "@/server/integrations/openai/config";
import { materiaisDisponiveis, type Material } from "@/server/materiais/macros";
import { categoriasDoConexa, type CategoriaDeServico } from "@/server/notas-fiscais/categorias";

/**
 * As leituras EXTERNAS que a tela de Integrações espera para abrir, guardadas por
 * `lerComReserva`: a tela recebe o último valor lido na hora e a renovação vai por
 * trás. Medido em 03/11/2026, do servidor: macros do Chatwoot ~2,7 s (280 KB),
 * modelos da OpenAI ~1,2 s, categorias do Conexa ~1,2 s — e a primeira abertura
 * depois de um deploy levou 15 s.
 *
 * ⚠ **Só para o painel.** O agente que manda a imagem de um macro, o que consulta
 * categorias e o que lista modelos continuam nas leituras e nos caches de sempre:
 * dado velho numa tela é incômodo; numa ação do agente seria erro.
 *
 * ⚠ **Nada aqui depende de sessão nem de requisição.** Estas funções rodam também
 * no aquecimento (`aquecerOPainel`), que ninguém abriu no navegador — por isso não
 * usam as ações de servidor, que exigem sessão, e sim as funções por baixo delas.
 */

const MIN = 60_000;
const HORA = 60 * MIN;

/** Os macros do Chatwoot, crus (o prefixo de cada material é aplicado na leitura). */
function macros() {
  return lerComReserva("chatwoot:macros", {
    // A equipe mexe em macro raramente; 10 min na tela é o que ela já aceitava.
    validadeMs: 10 * MIN,
    idadeMaximaMs: HORA,
    // `forcar`: a renovação precisa LER de novo, e não devolver o cache de 5 min.
    carregar: () => macrosDoChatwoot({ forcar: true }),
  });
}

/** Os materiais liberados, com o mesmo formato (`{ lista, erro }`) de quando a tela lia direto. */
export async function materiaisDoPainel(
  prefixos: string[],
): Promise<{ lista: Material[]; erro: string | null }> {
  try {
    return { lista: materiaisDisponiveis(await macros(), prefixos), erro: null };
  } catch (erro) {
    return { lista: [], erro: erro instanceof Error ? erro.message : String(erro) };
  }
}

async function catalogoDaContaOpenAI(forcar: boolean): Promise<CatalogoDaConta> {
  const atual = await db.integration.findUnique({
    where: { provider: IntegrationProvider.OPENAI },
    include: { credential: true },
  });
  if (!atual?.credential) {
    return { ids: [], erro: "Salve a chave da OpenAI para ver a lista de modelos da conta." };
  }

  let apiKey: string;
  try {
    apiKey = decifrar(atual.credential);
  } catch {
    return { ids: [], erro: "Chave ilegível — recadastre." };
  }
  return modelosDaConta(lerConfigOpenAI(atual.config), apiKey, { forcar });
}

/**
 * Os modelos da conta da OpenAI. ⚠ Guarda a LISTA, e não os grupos já montados: os
 * grupos dependem dos modelos gravados em cada campo (`organizarModelos`), que
 * podem mudar a qualquer salvamento — e `<select>` sem a opção do valor gravado
 * troca o modelo em silêncio.
 */
export function catalogoOpenAIDoPainel(): Promise<CatalogoDaConta> {
  return lerComReserva(LEITURA_MODELOS_OPENAI, {
    validadeMs: 50 * MIN,
    idadeMaximaMs: 12 * HORA,
    carregar: () => catalogoDaContaOpenAI(true),
    // Lista vazia (sem chave, 401, 403, erro de rede) não vira "a verdade" por 50 min.
    deveGuardar: (c) => c.ids.length > 0,
  });
}

const SEM_MODELOS: ModelosParaEscolher = { audio: [], visao: [], documento: [], total: 0 };

/**
 * A lista da conta vira os grupos de cada seletor. É a mesma conta que
 * `modelosParaEscolher` (em `actions/openai.ts`) faz: cada campo garante o SEU
 * valor gravado como opção.
 */
export function organizarModelos(
  catalogo: CatalogoDaConta,
  gravados: { modeloAudio: string; modeloVisao: string; modeloDocumento: string },
): ModelosParaEscolher {
  if (catalogo.ids.length === 0) return { ...SEM_MODELOS, erro: catalogo.erro };

  const texto = gruposParaTexto(catalogo.ids);
  return {
    audio: comSelecionado(gruposParaAudio(catalogo.ids), gravados.modeloAudio),
    visao: comSelecionado(texto, gravados.modeloVisao),
    documento: comSelecionado(texto, gravados.modeloDocumento),
    total: catalogo.ids.length,
  };
}

/** As categorias de serviço do Conexa, com o formato de sempre (`{ categorias, erro? }`). */
export function categoriasFiscaisDoPainel(): Promise<{
  categorias: CategoriaDeServico[];
  erro?: string;
}> {
  return lerComReserva("conexa:categorias", {
    validadeMs: 50 * MIN,
    idadeMaximaMs: 12 * HORA,
    carregar: () => categoriasDoConexa(Date.now(), { forcar: true }),
    // Leitura que falhou devolve a lista de reserva COM o erro: não vale como lida.
    deveGuardar: (r) => !r.erro,
  });
}

/**
 * Deixa as três leituras quentes ANTES de alguém abrir a tela, e as renova quando
 * vencem. Quem chama é o worker (`painel/aquecer.ts`), de dentro do container, a
 * cada poucos minutos em horário de uso — e logo depois de cada deploy, que é
 * quando a tela estava lenta. Devolve o tempo de cada uma, para o log.
 *
 * Nunca lança: aquecimento é conveniência, e a falha de uma leitura não pode
 * impedir as outras (a tela, na hora de abrir, cuida do que faltar).
 */
export async function aquecerOPainel(): Promise<Record<string, string>> {
  const medir = async (nome: string, ler: () => Promise<unknown>): Promise<[string, string]> => {
    const inicio = Date.now();
    try {
      await ler();
      return [nome, `${Date.now() - inicio} ms`];
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);
      return [nome, `falhou em ${Date.now() - inicio} ms: ${motivo.slice(0, 80)}`];
    }
  };

  const saidas = await Promise.all([
    medir("macros do Chatwoot", macros),
    medir("modelos da OpenAI", catalogoOpenAIDoPainel),
    medir("categorias do Conexa", categoriasFiscaisDoPainel),
  ]);
  return Object.fromEntries(saidas);
}
