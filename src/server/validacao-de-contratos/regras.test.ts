import { describe, expect, it } from "vitest";

import {
  chaveDaReconferencia,
  ehAFila,
  ehTarefaDeCliente,
  payloadDaReconferencia,
  precisaReconferir,
  STATUS_DA_FILA,
} from "./regras";

const TAREFA = {
  id: "17twvjx2j2w",
  name: "CW — Tayná Sena da Rocha",
  status: { status: STATUS_DA_FILA },
  date_updated: "1794362081302",
};

describe("ehAFila", () => {
  it("reconhece o status com emoji, que é o nome real", () => {
    expect(ehAFila("📝 contrato")).toBe(true);
  });

  it("⚠ continua reconhecendo se alguém tirar o emoji da tela", () => {
    expect(ehAFila("contrato")).toBe(true);
    expect(ehAFila("Contrato")).toBe(true);
  });

  it("não confunde com os outros status da Base de clientes", () => {
    for (const outro of [
      "🏃‍♂️onboarding",
      "ongoing",
      "ongoing - sala privativa",
      "renovação",
      "notificação renovação",
      "pg pendente - renovação",
      "😢  distrato",
      "inativo",
      "negativado",
      "inadimplente",
    ]) {
      expect(ehAFila(outro)).toBe(false);
    }
  });

  it("status ausente não é fila", () => {
    expect(ehAFila(null)).toBe(false);
    expect(ehAFila(undefined)).toBe(false);
  });
});

describe("precisaReconferir", () => {
  it("⚠ a primeira vez que vê a task NÃO aciona: só anota", () => {
    // Sem isso, o primeiro boot depois do deploy acionaria o agente para toda
    // task parada na fila de uma vez — e a automação do ClickUp já disparou
    // quando cada uma entrou ali.
    expect(precisaReconferir(TAREFA, null)).toBe(false);
  });

  it("task que não mudou desde a última olhada não custa modelo", () => {
    expect(precisaReconferir(TAREFA, { mudouEm: "1794362081302" })).toBe(false);
  });

  it("task corrigida à mão volta para a fila", () => {
    // O caso do Diego: ele preencheu o campo que faltava, e nada aconteceu
    // porque preencher campo não muda status.
    expect(precisaReconferir(TAREFA, { mudouEm: "1794362081000" })).toBe(true);
  });

  it("sem date_updated, não aciona — não dá para saber se mudou", () => {
    expect(precisaReconferir({ date_updated: null }, { mudouEm: "1" })).toBe(false);
    expect(precisaReconferir({ date_updated: "  " }, { mudouEm: "1" })).toBe(false);
  });
});

describe("chaveDaReconferencia", () => {
  it("leva o instante da mudança: cada correção é uma entrega nova", () => {
    expect(chaveDaReconferencia("abc", "123")).toBe("reconferencia:abc:123");
    expect(chaveDaReconferencia("abc", "124")).not.toBe(chaveDaReconferencia("abc", "123"));
  });
});

describe("payloadDaReconferencia", () => {
  it("⚠ põe o id em payload.id, como a automação do ClickUp faz", () => {
    // É de `payload.id` que o prompt manda tirar o id da task. Outro formato
    // faria o agente não achar a task e encerrar sem fazer nada.
    const p = payloadDaReconferencia(TAREFA);
    expect(p.payload.id).toBe("17twvjx2j2w");
    expect(p.reconferencia).toBe(true);
  });

  it("diz ao agente o que fazer nos dois desfechos", () => {
    const p = payloadDaReconferencia(TAREFA);
    expect(p.motivo).toContain("mova para Onboarding");
    expect(p.motivo).toContain("sem repetir comentário igual ao anterior");
  });
});

/**
 * Medido em 11/11/2026: a primeira página da fila `📝 contrato` traz 100
 * tarefas, e quase todas são subtarefas de cadência criadas pelo ClickBot
 * desde 2024.
 */
describe("ehTarefaDeCliente", () => {
  it("a task de contratação de verdade passa", () => {
    expect(ehTarefaDeCliente({ parent: null, tags: [{ name: "venda autonoma" }] })).toBe(true);
    expect(ehTarefaDeCliente({ parent: null, tags: [{ name: "fazer_contrato" }] })).toBe(true);
  });

  it("⚠ subtarefa de cadência não passa — não tem campo nenhum para conferir", () => {
    // "Whatsapp de follow up", "Ligação de qualificação", "Envio de proposta"…
    expect(ehTarefaDeCliente({ parent: "86a4e8nz1", tags: [] })).toBe(false);
    expect(ehTarefaDeCliente({ parent: null, tags: [{ name: "subtarefas" }] })).toBe(false);
  });

  it("as duas marcas valem sozinhas: nenhuma é garantida", () => {
    expect(ehTarefaDeCliente({ parent: "x", tags: [{ name: "fazer_contrato" }] })).toBe(false);
    expect(ehTarefaDeCliente({ parent: null, tags: [{ name: "SubTarefas" }] })).toBe(false);
  });

  it("sem etiqueta nenhuma, passa", () => {
    expect(ehTarefaDeCliente({ parent: null, tags: undefined })).toBe(true);
  });
});
