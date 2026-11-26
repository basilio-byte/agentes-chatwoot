import { describe, expect, it } from "vitest";
import {
  AGENTES_PADRAO,
  chaveDoLead,
  configDoFormulario,
  contarTasks,
  decidirRegistro,
  lerConfigDoLead,
  mensagemDoLead,
  VALIDADE_MS,
} from "./regras";

/**
 * O registro automático do lead no CRM Comercial (pedido do Diego, 26/11/2026).
 * O que importa travar: só registra com uma PESSOA dona da conversa, e nunca
 * quando já há task ou o atendimento virou suporte.
 */

const base = {
  status: "open",
  donoEhPessoa: true as boolean | undefined | null,
  tasksNaConversa: 0,
  virouSuporte: false,
  agenteComercial: true,
  idadeMs: 5 * 60_000,
};

describe("lerConfigDoLead", () => {
  it("nasce DESLIGADO, com os agentes comerciais e o CRM Comercial", () => {
    expect(lerConfigDoLead({})).toEqual({
      modo: "desligado",
      agentes: AGENTES_PADRAO,
      agenteDoCrm: "agente-crm-comercial",
    });
    expect(lerConfigDoLead(null).modo).toBe("desligado");
  });

  it("config torta volta ao padrão desligado, em vez de ligar alguma coisa", () => {
    expect(lerConfigDoLead({ leadNoCrm: { modo: "talvez" } }).modo).toBe("desligado");
  });

  it("lê a chave leadNoCrm da linha do Chatwoot", () => {
    expect(
      lerConfigDoLead({ baseUrl: "x", leadNoCrm: { modo: "sombra", agentes: ["vendedor-ev"] } }),
    ).toMatchObject({ modo: "sombra", agentes: ["vendedor-ev"] });
  });
});

describe("configDoFormulario", () => {
  it("aceita uma chave por linha, sem repetir", () => {
    expect(
      configDoFormulario({
        modo: "ligado",
        agentes: "vendedor-ev\nAgente-Seabox\nvendedor-ev",
        agenteDoCrm: " agente-crm-comercial ",
      }),
    ).toEqual({
      config: {
        modo: "ligado",
        agentes: ["vendedor-ev", "agente-seabox"],
        agenteDoCrm: "agente-crm-comercial",
      },
    });
  });

  it("recusa nome em vez de chave, lista vazia, modo desconhecido e o CRM na lista", () => {
    expect(
      configDoFormulario({ modo: "ligado", agentes: "Everton - Vendedor EV", agenteDoCrm: "agente-crm-comercial" }),
    ).toHaveProperty("erro");
    expect(configDoFormulario({ modo: "ligado", agentes: " ", agenteDoCrm: "x" })).toHaveProperty("erro");
    expect(configDoFormulario({ modo: "talvez", agentes: "a", agenteDoCrm: "b" })).toHaveProperty("erro");
    expect(
      configDoFormulario({ modo: "ligado", agentes: "a\nb", agenteDoCrm: "b" }),
    ).toHaveProperty("erro");
  });
});

describe("chaveDoLead", () => {
  it("um por atendimento: resolver e reabrir muda a chave", () => {
    expect(chaveDoLead(15480, null)).toBe("conversa:15480:0");
    expect(chaveDoLead(15480, new Date(1000))).toBe("conversa:15480:1000");
  });
});

describe("decidirRegistro", () => {
  it("conversa com uma pessoa da equipe e sem task: registra", () => {
    expect(decidirRegistro(base)).toEqual({ acao: "registrar" });
  });

  it("⚠ com o robô conduzindo, ESPERA — senão a task nasceria no nome do Diego", () => {
    expect(decidirRegistro({ ...base, donoEhPessoa: false }).acao).toBe("esperar");
    expect(decidirRegistro({ ...base, donoEhPessoa: null }).acao).toBe("esperar");
  });

  it("dono de tipo desconhecido não vira vendedor: espera", () => {
    expect(decidirRegistro({ ...base, donoEhPessoa: undefined })).toMatchObject({
      acao: "esperar",
      motivo: expect.stringMatching(/desconhecido/),
    });
  });

  it("task já existe na conversa (de qualquer agente): encerra sem registrar", () => {
    expect(decidirRegistro({ ...base, tasksNaConversa: 1 })).toMatchObject({
      acao: "encerrar",
      resultado: "já registrada",
    });
  });

  it("virou suporte ou passou a um agente não comercial: não é lead", () => {
    expect(decidirRegistro({ ...base, virouSuporte: true })).toMatchObject({ resultado: "suporte" });
    expect(decidirRegistro({ ...base, agenteComercial: false })).toMatchObject({
      resultado: "não é lead",
    });
  });

  it("resolvida com uma pessoa dona ainda registra; resolvida com o robô, não", () => {
    expect(decidirRegistro({ ...base, status: "resolved" })).toEqual({ acao: "registrar" });
    expect(decidirRegistro({ ...base, status: "resolved", donoEhPessoa: null })).toMatchObject({
      acao: "encerrar",
      resultado: "sem pessoa",
    });
  });

  it("24 h com o robô: sai da fila", () => {
    expect(
      decidirRegistro({ ...base, donoEhPessoa: false, idadeMs: VALIDADE_MS }),
    ).toMatchObject({ acao: "encerrar", resultado: "expirada" });
  });
});

describe("contarTasks", () => {
  it("conta a task criada e a existente que a criação devolveu; recusa e texto não contam", () => {
    expect(
      contarTasks([
        { criada: true, id: "a" },
        { criada: false, jaExistia: true },
        { criada: false, problemas: ["x"] },
        "erro em texto",
        null,
      ]),
    ).toBe(2);
  });
});

describe("mensagemDoLead", () => {
  const msg = mensagemDoLead({
    conversationId: 15480,
    link: "https://chatwoot.test/app/accounts/1/conversations/15480",
    contatoNome: "Ana [teste]\nnova linha",
    telefone: "+55 84 99999-0000 ramal",
    dono: "Alan Novaes",
    agenteComercial: "Everton - Vendedor EV",
    atendentes: [],
    transcricao: "[transcrição do atendimento]\n…\n[fim da transcrição]",
    quando: "26/11/2026 15:00",
  });

  it("⚠ começa como a do checkbox: é a seção do prompt do CRM que usa o dono como vendedor", () => {
    expect(msg.startsWith("[Checkbox marcado no Chatwoot —")).toBe(true);
    expect(msg).toMatch(/registro automático do lead/);
    expect(msg).toMatch(/Dono da conversa no Chatwoot: Alan Novaes/);
  });

  it("nome do contato não abre colchete nem linha nova no cabeçalho", () => {
    expect(msg).toMatch(/Contato: Ana teste nova linha/);
    expect(msg).toMatch(/Telefone do contato: \+55 84 99999-0000/);
  });
});
