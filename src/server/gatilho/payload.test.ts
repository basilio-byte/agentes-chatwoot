import { describe, expect, it } from "vitest";
import {
  extrairEventType,
  extrairRecursoChave,
  montarMensagemDoGatilho,
} from "./payload";

describe("montarMensagemDoGatilho", () => {
  it("inclui o eventType e o payload como JSON legível", () => {
    const msg = montarMensagemDoGatilho({
      eventType: "taskCreated",
      payload: { task_id: "abc123", name: "Testar gatilho" },
    });

    expect(msg).toContain('evento "taskCreated"');
    expect(msg).toContain('"task_id": "abc123"');
    expect(msg).toContain("fora de uma conversa do Chatwoot");
  });

  it("avisa que não há cliente esperando resposta em texto", () => {
    const msg = montarMensagemDoGatilho({ eventType: "x", payload: {} });
    expect(msg).toContain("não há cliente esperando resposta em texto");
  });
});

describe("extrairEventType", () => {
  it("lê o campo event (formato do ClickUp)", () => {
    expect(extrairEventType({ event: "taskCreated" })).toBe("taskCreated");
  });

  it("aceita event_type e type como alternativas", () => {
    expect(extrairEventType({ event_type: "order.created" })).toBe("order.created");
    expect(extrairEventType({ type: "ping" })).toBe("ping");
  });

  it("sem nenhum campo reconhecido, devolve desconhecido — nunca falha", () => {
    expect(extrairEventType({ foo: "bar" })).toBe("desconhecido");
    expect(extrairEventType(null)).toBe("desconhecido");
    expect(extrairEventType("texto cru")).toBe("desconhecido");
    expect(extrairEventType(undefined)).toBe("desconhecido");
  });

  it("campo vazio não conta como evento válido", () => {
    expect(extrairEventType({ event: "   " })).toBe("desconhecido");
  });
});

describe("extrairRecursoChave", () => {
  it("prioriza task_id — é o campo do exemplo dado (ClickUp)", () => {
    expect(extrairRecursoChave({ task_id: "c0j", id: "outro" })).toBe("c0j");
  });

  it("aceita resource_id, object_id e id como alternativas genéricas", () => {
    expect(extrairRecursoChave({ resource_id: "r1" })).toBe("r1");
    expect(extrairRecursoChave({ object_id: "o1" })).toBe("o1");
    expect(extrairRecursoChave({ id: "i1" })).toBe("i1");
  });

  it("aceita id numérico, convertendo para string", () => {
    expect(extrairRecursoChave({ id: 42 })).toBe("42");
  });

  it("sem nenhum campo reconhecido, devolve undefined — só a trava de teto global se aplica", () => {
    expect(extrairRecursoChave({ foo: "bar" })).toBeUndefined();
    expect(extrairRecursoChave(null)).toBeUndefined();
    expect(extrairRecursoChave("texto cru")).toBeUndefined();
  });
});
