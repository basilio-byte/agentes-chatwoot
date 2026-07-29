import { describe, expect, it } from "vitest";
import {
  blocoDeRoster,
  mensagemDeBastao,
  montarRoster,
  resolverAgenteAtivo,
  resolverDestino,
  type AgenteRoteavel,
} from "./equipe";

const agente = (p: Partial<AgenteRoteavel> & { id: string }): AgenteRoteavel => ({
  key: p.id,
  name: p.id,
  routingDescription: "cuida de alguma coisa",
  active: true,
  isEntry: false,
  ...p,
});

const EQUIPE: AgenteRoteavel[] = [
  agente({ id: "recepcao", name: "Recepção", isEntry: true, routingDescription: "primeiro contato" }),
  agente({ id: "salas", name: "Salas", routingDescription: "aluguel de salas e reservas" }),
  agente({ id: "fiscal", name: "Endereço Fiscal", routingDescription: "endereço fiscal e escritório virtual" }),
];

describe("resolverAgenteAtivo", () => {
  it("o dono da conversa continua com ela", () => {
    const r = resolverAgenteAtivo(EQUIPE, { donoId: "salas", portaId: "recepcao" });
    expect(r?.id).toBe("salas");
  });

  it("sem dono, quem atende é a entrada", () => {
    const r = resolverAgenteAtivo(EQUIPE, { donoId: null, portaId: "salas" });
    expect(r?.id).toBe("recepcao");
  });

  it("dono desligado cai para a entrada em vez de virar silêncio", () => {
    const equipe = EQUIPE.map((a) => (a.id === "salas" ? { ...a, active: false } : a));
    const r = resolverAgenteAtivo(equipe, { donoId: "salas", portaId: "recepcao" });
    expect(r?.id).toBe("recepcao");
  });

  it("sem entrada configurada, a porta atende — o atendimento não pode parar", () => {
    const equipe = EQUIPE.map((a) => ({ ...a, isEntry: false }));
    const r = resolverAgenteAtivo(equipe, { donoId: null, portaId: "salas" });
    expect(r?.id).toBe("salas");
  });

  it("entrada desligada não segura a conversa", () => {
    const equipe = EQUIPE.map((a) => (a.isEntry ? { ...a, active: false } : a));
    const r = resolverAgenteAtivo(equipe, { donoId: null, portaId: "fiscal" });
    expect(r?.id).toBe("fiscal");
  });

  it("ninguém ativo devolve nulo, e quem chama trata", () => {
    const equipe = EQUIPE.map((a) => ({ ...a, active: false }));
    expect(resolverAgenteAtivo(equipe, { donoId: null, portaId: "recepcao" })).toBeNull();
  });
});

describe("montarRoster", () => {
  it("não lista o próprio agente", () => {
    const r = montarRoster(EQUIPE, "salas");
    expect(r.map((a) => a.id)).toEqual(["recepcao", "fiscal"]);
  });

  it("agente sem descrição de roteamento fica de fora", () => {
    // Sem a descrição o modelo não tem como decidir se aquele colega serve —
    // listar às cegas só gasta token e convida transferência errada.
    const equipe = EQUIPE.map((a) =>
      a.id === "fiscal" ? { ...a, routingDescription: "   " } : a,
    );
    expect(montarRoster(equipe, "salas").map((a) => a.id)).toEqual(["recepcao"]);
  });

  it("agente desligado fica de fora", () => {
    const equipe = EQUIPE.map((a) => (a.id === "fiscal" ? { ...a, active: false } : a));
    expect(montarRoster(equipe, "salas").map((a) => a.id)).toEqual(["recepcao"]);
  });
});

describe("blocoDeRoster", () => {
  it("sem colegas, não gasta nem uma linha do prompt", () => {
    expect(blocoDeRoster([], "Salas")).toBe("");
  });

  it("mostra chave, nome e a descrição de cada colega", () => {
    const texto = blocoDeRoster(montarRoster(EQUIPE, "recepcao"), "Recepção");

    expect(texto).toContain("salas — Salas: aluguel de salas e reservas");
    expect(texto).toContain("transferir_para_agente");
    expect(texto).not.toContain("recepcao —");
  });
});

describe("resolverDestino", () => {
  const roster = montarRoster(EQUIPE, "recepcao");

  it("casa pela chave, que é o que o prompt pede", () => {
    expect(resolverDestino("salas", roster)).toMatchObject({ tipo: "achado" });
  });

  it("aceita o nome — o modelo às vezes copia o rótulo", () => {
    const r = resolverDestino("Endereço Fiscal", roster);
    expect(r).toMatchObject({ tipo: "achado", destino: { key: "fiscal" } });
  });

  it("ignora caixa", () => {
    expect(resolverDestino("SALAS", roster)).toMatchObject({ tipo: "achado" });
  });

  it("destino inexistente devolve as chaves válidas para o modelo se corrigir", () => {
    const r = resolverDestino("financeiro", roster);
    expect(r).toEqual({ tipo: "nenhum", chavesValidas: ["salas", "fiscal"] });
  });

  it("string vazia não casa com ninguém", () => {
    expect(resolverDestino("  ", roster).tipo).toBe("nenhum");
  });
});

describe("mensagemDeBastao", () => {
  it("sem bastão, não injeta mensagem nenhuma", () => {
    expect(mensagemDeBastao({})).toBeNull();
  });

  it("manda continuar de onde parou — é o que evita o cliente repetir tudo", () => {
    const m = mensagemDeBastao({
      deNome: "Recepção",
      motivo: "cliente quer endereço fiscal",
      resumo: "já informou CPF e e-mail; falta escolher o plano",
    })!;

    expect(m).toContain("veio de Recepção");
    expect(m).toContain("já informou CPF");
    expect(m).toContain("não se");
    expect(m).toContain("O cliente já foi avisado");
  });
});
