import { normalizar, paraTimestamp } from "./formatacao";
import type { ClickUpCampoPersonalizado } from "./tipos";

/**
 * Campos personalizados: do nome que o agente conhece para o formato que a API
 * exige.
 *
 * O modelo sabe "CPF" e "383.570.368-48". A API quer o UUID do campo e, em
 * campo de seleção, o UUID da *opção* — nada disso o agente tem como adivinhar.
 * Resolver aqui evita obrigá-lo a listar ids e montar chamada por chamada, que
 * é justamente o caminho caro que faz o modelo desistir e escrever tudo num
 * comentário.
 *
 * Puro de propósito: dá para testar cada tipo sem tocar na rede.
 */

/** Tipos que aceitam texto direto, sem conversão. */
const TEXTUAIS = new Set([
  "text",
  "short_text",
  "email",
  "phone",
  "url",
  "location",
]);

const NUMERICOS = new Set(["number", "currency", "emoji"]);

/** A API calcula sozinha — escrever nesses campos é erro garantido. */
const SOMENTE_LEITURA = new Set([
  "formula",
  "rollup",
  "automatic_progress",
]);

const VERDADEIROS = new Set(["true", "sim", "yes", "1", "verdadeiro"]);
const FALSOS = new Set(["false", "nao", "não", "no", "0", "falso"]);

export type Entrada = { campo: string; valor: unknown };

export type Problema = { campo: string; motivo: string };

export type Preparacao = {
  /** No formato que o corpo da API espera. */
  prontos: { id: string; value: unknown }[];
  problemas: Problema[];
};

function rotuloDaOpcao(opcao: { name?: string | null; label?: string | null }) {
  return opcao.name ?? opcao.label ?? "";
}

/** Nomes dos campos, para devolver ao modelo quando ele erra o nome. */
export function nomesDisponiveis(campos: ClickUpCampoPersonalizado[]) {
  return campos.map((c) => c.name);
}

/**
 * Casa por id exato, depois por nome exato, depois por trecho.
 *
 * Devolve ambiguidade em vez de escolher: gravar o CPF no campo errado é pior
 * do que devolver a pergunta.
 */
export function resolverCampo(
  termo: string,
  campos: ClickUpCampoPersonalizado[],
):
  | { tipo: "achado"; campo: ClickUpCampoPersonalizado }
  | { tipo: "ambiguo"; candidatos: string[] }
  | { tipo: "nenhum" } {
  const porId = campos.find((c) => c.id === termo);
  if (porId) return { tipo: "achado", campo: porId };

  const alvo = normalizar(termo);
  if (!alvo) return { tipo: "nenhum" };

  const exatos = campos.filter((c) => normalizar(c.name) === alvo);
  if (exatos.length === 1) return { tipo: "achado", campo: exatos[0] };
  if (exatos.length > 1)
    return { tipo: "ambiguo", candidatos: exatos.map((c) => c.name) };

  const parciais = campos.filter((c) => normalizar(c.name).includes(alvo));
  if (parciais.length === 1) return { tipo: "achado", campo: parciais[0] };
  if (parciais.length > 1)
    return { tipo: "ambiguo", candidatos: parciais.map((c) => c.name) };

  return { tipo: "nenhum" };
}

/** Resolve o rótulo de uma opção para o id que a API espera. */
function idDaOpcao(
  campo: ClickUpCampoPersonalizado,
  valor: unknown,
): { ok: true; id: string } | { ok: false; motivo: string } {
  const opcoes = campo.type_config?.options ?? [];
  const termo = String(valor);

  const porId = opcoes.find((o) => o.id === termo);
  if (porId) return { ok: true, id: porId.id };

  const alvo = normalizar(termo);
  const achada = opcoes.find((o) => normalizar(rotuloDaOpcao(o)) === alvo);
  if (achada) return { ok: true, id: achada.id };

  const rotulos = opcoes.map(rotuloDaOpcao).filter(Boolean);
  return {
    ok: false,
    motivo: `"${termo}" não é uma opção de "${campo.name}". Opções: ${
      rotulos.length > 0 ? rotulos.join(", ") : "(nenhuma configurada)"
    }.`,
  };
}

export function converterValor(
  campo: ClickUpCampoPersonalizado,
  valor: unknown,
): { ok: true; valor: unknown } | { ok: false; motivo: string } {
  const tipo = campo.type;

  if (SOMENTE_LEITURA.has(tipo)) {
    return {
      ok: false,
      motivo: `"${campo.name}" é do tipo ${tipo}, calculado pelo ClickUp — não aceita escrita.`,
    };
  }

  if (TEXTUAIS.has(tipo)) return { ok: true, valor: String(valor) };

  if (NUMERICOS.has(tipo)) {
    if (typeof valor === "number") {
      return Number.isFinite(valor)
        ? { ok: true, valor }
        : { ok: false, motivo: `"${valor}" não é um número válido para "${campo.name}".` };
    }

    const texto = String(valor);
    // Sem dígito nenhum não há o que converter. Sem esta guarda, "a combinar"
    // vira 0 — `Number("")` é 0 — e grava R$ 0,00 sem ninguém perceber.
    if (!/\d/.test(texto)) {
      return {
        ok: false,
        motivo: `"${texto}" não tem número para gravar em "${campo.name}".`,
      };
    }

    // Aceita "R$ 119,00" e "1.250,50": o modelo repete o que o cliente falou.
    const limpo = Number(
      texto
        .replace(/[^\d,.-]/g, "")
        .replace(/\.(?=\d{3}\b)/g, "")
        .replace(",", "."),
    );

    if (!Number.isFinite(limpo)) {
      return { ok: false, motivo: `"${texto}" não é um número válido para "${campo.name}".` };
    }
    return { ok: true, valor: limpo };
  }

  if (tipo === "checkbox") {
    if (typeof valor === "boolean") return { ok: true, valor };
    const texto = normalizar(String(valor));
    if (VERDADEIROS.has(texto)) return { ok: true, valor: true };
    if (FALSOS.has(texto)) return { ok: true, valor: false };
    return { ok: false, motivo: `"${valor}" não é sim/não para "${campo.name}".` };
  }

  if (tipo === "date") {
    const ms = paraTimestamp(String(valor));
    if (!ms) {
      return {
        ok: false,
        motivo: `"${valor}" não é uma data ISO válida para "${campo.name}".`,
      };
    }
    return { ok: true, valor: ms };
  }

  if (tipo === "drop_down") {
    const opcao = idDaOpcao(campo, valor);
    return opcao.ok ? { ok: true, valor: opcao.id } : opcao;
  }

  if (tipo === "labels") {
    const lista = Array.isArray(valor) ? valor : [valor];
    const ids: string[] = [];
    for (const item of lista) {
      const opcao = idDaOpcao(campo, item);
      if (!opcao.ok) return opcao;
      ids.push(opcao.id);
    }
    return { ok: true, valor: ids };
  }

  if (tipo === "users") {
    const lista = (Array.isArray(valor) ? valor : [valor]).map(Number);
    if (lista.some((n) => !Number.isFinite(n))) {
      return {
        ok: false,
        motivo: `"${campo.name}" espera ids numéricos de pessoas — use clickup_listar_membros.`,
      };
    }
    return { ok: true, valor: lista };
  }

  // Tipo que ainda não mapeamos: manda como veio em vez de bloquear. Se a API
  // recusar, o erro dela é mais informativo do que um palpite nosso.
  return { ok: true, valor };
}

/**
 * Prepara o lote inteiro.
 *
 * Quem chama deve tratar `problemas` como impeditivo: gravar metade dos campos
 * deixa a tarefa incompleta sem ninguém perceber, e o modelo não tem como saber
 * o que faltou se a resposta vier como sucesso.
 */
export function prepararCampos(
  entradas: Entrada[],
  campos: ClickUpCampoPersonalizado[],
): Preparacao {
  const prontos: { id: string; value: unknown }[] = [];
  const problemas: Problema[] = [];

  for (const entrada of entradas) {
    const achado = resolverCampo(entrada.campo, campos);

    if (achado.tipo === "nenhum") {
      problemas.push({
        campo: entrada.campo,
        motivo: `Não existe campo com esse nome. Disponíveis: ${
          nomesDisponiveis(campos).join(", ") || "(a lista não tem campos personalizados)"
        }.`,
      });
      continue;
    }

    if (achado.tipo === "ambiguo") {
      problemas.push({
        campo: entrada.campo,
        motivo: `Nome ambíguo — corresponde a: ${achado.candidatos.join(", ")}.`,
      });
      continue;
    }

    const convertido = converterValor(achado.campo, entrada.valor);
    if (!convertido.ok) {
      problemas.push({ campo: entrada.campo, motivo: convertido.motivo });
      continue;
    }

    prontos.push({ id: achado.campo.id, value: convertido.valor });
  }

  return { prontos, problemas };
}
