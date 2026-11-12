import { describe, expect, it } from "vitest";

import { camposDaTarefa, valorLegivel } from "./campos-da-tarefa";
import { formatarTarefaDetalhada } from "./formatacao";
import type { ClickUpTarefa } from "./tipos";

/**
 * ⚠ **O formato abaixo foi COPIADO de uma task real de produção**
 * (`17twvjx2mdh`, lida em 12/11/2026), e isso não é zelo decorativo: a lição
 * de 11/11 é que teste cujo dado de entrada foi escrito por quem escreveu o
 * código não prova integração nenhuma — ali um parâmetro chamado `taskId` em
 * vez de `tarefaId` passou por 76 testes verdes.
 *
 * O que o formato real ensina e um dado inventado esconderia: campo de lista
 * vem como OBJETO (`{id, name, orderindex}`) ou como id solto, a data vem em
 * milissegundos EM STRING, o checkbox vem como `"true"` em texto, e a
 * localização vem com `formatted_address` ao lado das coordenadas.
 */
const TAREFA_REAL = {
  id: "17twvjx2mdh",
  name: "Cliente de teste",
  status: { status: "🏃‍♂️onboarding" },
  list: { id: "900701122530", name: "Base de clientes" },
  date_created: "1794403410112",
  custom_fields: [
    {
      id: "140813a9-01ce-4b63-a7d7-b44bba3cb1c8",
      name: "TIPO DE PRODUTO",
      type: "drop_down",
      value: "dc82c71d-9bd6-45ed-8b1c-88ea1fe63f66",
      type_config: {
        options: [
          { id: "dc82c71d-9bd6-45ed-8b1c-88ea1fe63f66", name: "Endereço Fiscal Litoral", orderindex: 0 },
          { id: "outra-opcao", name: "SeaBox Pro", orderindex: 1 },
        ],
      },
    },
    { id: "3a05d1d2", name: "CPF", type: "short_text", value: "11054780412" },
    { id: "0dad1007", name: "VALOR CONTRATO", type: "currency", value: "119" },
    { id: "e96199e8", name: "VENCIMENTO", type: "number", value: "12" },
    { id: "a2e35724", name: "CPF ou CNPJ Preenchidos", type: "checkbox", value: "true" },
    { id: "5115e009", name: "DATA INICIO CONTRATO", type: "date", value: "1794380400000" },
    {
      id: "b9d3e56f",
      name: "📍 Endereço Sócio",
      type: "location",
      value: {
        location: { lat: -5.847213, lng: -35.2405493 },
        place_id: "ChIJn4JjzLxVsgcRe6F8n0H9tj8",
        formatted_address: "R. Dr. Costa Ribeiro, 34 - Pitimbu, Natal - RN, 59069-330",
      },
    },
    { id: "a05cce1b", name: "Tempo de Churn", type: "formula", value: "364" },
    // Campo sem valor: a API o omite, mas quem monta um mock esquece disso.
    { id: "vazio-1", name: "Serviço Extra", type: "short_text", value: "" },
    // Campo sem nome: id cru não diz nada a quem lê.
    { id: "sem-nome", type: "short_text", value: "algo" },
  ],
} as unknown as ClickUpTarefa;

describe("camposDaTarefa", () => {
  it("traduz o dropdown pelo nome da opção, e não devolve o UUID", () => {
    const campos = camposDaTarefa(TAREFA_REAL);
    expect(campos["TIPO DE PRODUTO"]).toBe("Endereço Fiscal Litoral");
  });

  it("lê texto, moeda e número como estão", () => {
    const campos = camposDaTarefa(TAREFA_REAL);
    expect(campos.CPF).toBe("11054780412");
    expect(campos["VALOR CONTRATO"]).toBe("119");
    expect(campos.VENCIMENTO).toBe("12");
  });

  it("checkbox vira booleano, e a data vira o dia de São Paulo", () => {
    const campos = camposDaTarefa(TAREFA_REAL);
    expect(campos["CPF ou CNPJ Preenchidos"]).toBe(true);
    // 1794380400000 é 11/11/2026 no relógio de São Paulo — o dia que a equipe
    // vê na tela do ClickUp, que é o que a leitura precisa devolver.
    expect(campos["DATA INICIO CONTRATO"]).toBe("2026-11-11");
  });

  it("localização devolve o endereço escrito, não as coordenadas", () => {
    const campos = camposDaTarefa(TAREFA_REAL);
    expect(campos["📍 Endereço Sócio"]).toBe(
      "R. Dr. Costa Ribeiro, 34 - Pitimbu, Natal - RN, 59069-330",
    );
  });

  it("campo vazio e campo sem nome ficam de fora", () => {
    const campos = camposDaTarefa(TAREFA_REAL);
    expect(campos).not.toHaveProperty("Serviço Extra");
    expect(Object.values(campos)).not.toContain("algo");
  });

  /** `false` e `0` são valores, não ausência. */
  it("checkbox desmarcado e número zero continuam aparecendo", () => {
    const campos = camposDaTarefa({
      custom_fields: [
        { id: "a", name: "Marcado", type: "checkbox", value: "false" },
        { id: "b", name: "Quantidade", type: "number", value: 0 },
      ],
    } as unknown as ClickUpTarefa);
    expect(campos.Marcado).toBe(false);
    expect(campos.Quantidade).toBe(0);
  });

  it("tarefa sem campo nenhum devolve objeto vazio, sem quebrar", () => {
    expect(camposDaTarefa({} as ClickUpTarefa)).toEqual({});
  });

  /** Opção que o `type_config` não conhece não vira `null`: o id cru aparece. */
  it("dropdown com opção desconhecida devolve o valor cru, nunca nada", () => {
    expect(
      valorLegivel({
        id: "x",
        name: "Campo",
        type: "drop_down",
        value: "id-que-nao-existe",
        type_config: { options: [] },
      }),
    ).toBe("id-que-nao-existe");
  });
});

describe("formatarTarefaDetalhada", () => {
  /**
   * ⚠ Os dois campos que faltavam e travaram o agente validador por seis
   * execuções seguidas (task FORSHIP, 11 e 12/11/2026): sem `listaId` ele nem
   * conseguia o contorno de ler os campos pela lista — tentou com o NOME e
   * levou `400 List ID invalid`.
   */
  it("devolve o listaId e os campos personalizados", () => {
    const detalhe = formatarTarefaDetalhada(TAREFA_REAL);
    expect(detalhe.listaId).toBe("900701122530");
    expect(detalhe).toHaveProperty("camposPersonalizados");
    expect(
      (detalhe as { camposPersonalizados: Record<string, unknown> }).camposPersonalizados.CPF,
    ).toBe("11054780412");
  });

  it("tarefa sem campos não ganha a chave vazia", () => {
    const detalhe = formatarTarefaDetalhada({ id: "1", name: "x" } as ClickUpTarefa);
    expect(detalhe).not.toHaveProperty("camposPersonalizados");
    expect(detalhe.listaId).toBeNull();
  });
});
