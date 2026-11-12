/**
 * Os campos personalizados de uma tarefa, já legíveis para o modelo.
 *
 * **Por que isto existe.** Até 12/11/2026 `clickup_obter_tarefa` devolvia
 * descrição, tags, prazo e comentários — e **nenhum campo personalizado**. Num
 * agente que confere cadastro isso não é detalhe: é a ferramenta não devolver
 * justamente aquilo que ele foi criado para ler.
 *
 * ⚠ **O defeito só apareceu na RE-conferência.** Quando o agente validador é
 * acionado pela automação do ClickUp, o payload dela traz a task inteira, com
 * os campos dentro — então ele nunca precisou lê-los. A varredura de
 * re-conferência (`validacao-de-contratos/`) manda um payload mínimo
 * (`id`, `name`, `status`), e aí o agente ficou sem saída: a task
 * `17twvjx2r7h` (FORSHIP) foi processada SEIS vezes entre 11 e 12/11/2026 e
 * nenhuma conseguiu conferir campo nenhum. Ele tentou contornar chamando
 * `clickup_listar_campos_personalizados`, que exige o **id** da lista, e o
 * retorno da task só trazia o NOME dela: `400 List ID invalid`, seis vezes.
 * Por isso `formatarTarefaDetalhada` passou a devolver também o `listaId`.
 *
 * ⚠ **Campo de LISTA devolve o id da opção, nunca o nome** (a mesma armadilha
 * do `TIPO DE PRODUTO` no acompanhamento de contratos). Quem traduz é
 * `type_config.options`, que a API manda junto na própria task. Sem a
 * tradução, o modelo lê um UUID e conclui que o campo está preenchido com
 * lixo — ou, pior, que não bate com nada.
 */

import { opcaoEscolhida } from "@/server/auto-venda/regras";
import { deTimestamp } from "./datas";
import type { ClickUpCampoPersonalizado, ClickUpTarefa } from "./tipos";

/**
 * Objeto desconhecido vira texto, e texto comprido é cortado.
 *
 * Esconder um campo que existe seria pior do que mostrá-lo torto — o agente
 * concluiria que está vazio e cobraria da equipe um dado que está lá.
 */
const MAX_TEXTO = 300;

type CampoDaTarefa = NonNullable<ClickUpTarefa["custom_fields"]>[number];

/** Vazio de verdade. `0` e `false` NÃO são vazios: são valores. */
function semValor(valor: unknown): boolean {
  if (valor === undefined || valor === null) return true;
  if (typeof valor === "string") return valor.trim() === "";
  if (Array.isArray(valor)) return valor.length === 0;
  return false;
}

function encurtar(texto: string): string {
  return texto.length <= MAX_TEXTO ? texto : `${texto.slice(0, MAX_TEXTO)}…`;
}

/**
 * O campo no formato que `opcaoEscolhida` espera.
 *
 * Ela nasceu para a venda autônoma, que lê os campos DA LISTA
 * (`ClickUpCampoPersonalizado`); aqui eles vêm de dentro da própria task, com
 * o mesmo `type_config`. Reusar é de propósito: duas traduções de dropdown
 * seriam duas réguas, e a que diverge é sempre a cópia.
 */
function comoCampoDaLista(campo: CampoDaTarefa): ClickUpCampoPersonalizado {
  return {
    id: campo.id,
    name: campo.name ?? "",
    type: campo.type ?? "",
    type_config: campo.type_config as ClickUpCampoPersonalizado["type_config"],
  };
}

/** O valor de um campo, do jeito que uma pessoa o leria na tela do ClickUp. */
export function valorLegivel(campo: CampoDaTarefa): unknown {
  const { value, type } = campo;
  if (semValor(value)) return null;

  switch (type) {
    case "drop_down":
      // `opcaoEscolhida` casa pelo id da opção e pelo índice.
      return opcaoEscolhida(comoCampoDaLista(campo), value) ?? value;

    case "labels": {
      const ids = Array.isArray(value) ? value : [value];
      const nomes = ids
        .map((id) => opcaoEscolhida(comoCampoDaLista(campo), id))
        .filter((n): n is string => Boolean(n));
      return nomes.length ? nomes : value;
    }

    case "date":
      // ⚠ Milissegundos em string. Lido no dia de São Paulo, como todo o resto
      // do projeto — o container roda em UTC.
      return deTimestamp(String(value)) ?? value;

    case "checkbox":
      return value === true || value === "true";

    case "location": {
      const endereco = (value as { formatted_address?: unknown })?.formatted_address;
      return typeof endereco === "string" && endereco.trim() ? endereco.trim() : value;
    }

    case "users": {
      const lista = Array.isArray(value) ? value : [value];
      const nomes = lista
        .map((u) => {
          const pessoa = u as { username?: unknown; email?: unknown };
          return typeof pessoa?.username === "string"
            ? pessoa.username
            : typeof pessoa?.email === "string"
              ? pessoa.email
              : null;
        })
        .filter((n): n is string => Boolean(n));
      return nomes.length ? nomes : value;
    }

    default:
      if (typeof value === "string") return encurtar(value);
      if (typeof value === "number" || typeof value === "boolean") return value;
      try {
        return encurtar(JSON.stringify(value));
      } catch {
        return null;
      }
  }
}

/**
 * Os campos preenchidos da tarefa, pelo NOME que a equipe vê no ClickUp.
 *
 * ⚠ Campo VAZIO fica de fora, e isso é o contrato desta função: a API já omite
 * a maioria, e listar dezenas de `null` gastaria token para dizer "nada". Quem
 * precisa saber o que FALTA compara com a lista de campos da lista
 * (`clickup_listar_campos_personalizados`) ou com a lista escrita no prompt.
 *
 * ⚠ Campo sem `name` fica de fora: um id cru não diz nada a quem lê, e o
 * agente não tem como cruzá-lo com o nome que o prompt cobra.
 */
export function camposDaTarefa(tarefa: ClickUpTarefa): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const campo of tarefa.custom_fields ?? []) {
    const nome = (campo.name ?? "").trim();
    if (!nome) continue;
    const valor = valorLegivel(campo);
    if (valor === null || valor === undefined) continue;
    if (typeof valor === "string" && valor.trim() === "") continue;
    saida[nome] = valor;
  }
  return saida;
}
