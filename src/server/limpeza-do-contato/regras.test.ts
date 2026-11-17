import { describe, expect, it } from "vitest";
import {
  CAMPOS_PADRAO,
  camposParaLimpar,
  chaveDaLimpeza,
  configDoFormulario,
  decidirLimpeza,
  lerConfigDaLimpeza,
  NUNCA_LIMPAR,
} from "./regras";

describe("config da limpeza do contato", () => {
  it("nasce desligada, com a lista decidida em 17/11/2026", () => {
    expect(lerConfigDaLimpeza({ baseUrl: "https://x", accountId: 1 })).toEqual({
      ligada: false,
      campos: CAMPOS_PADRAO,
    });
    expect(CAMPOS_PADRAO).toContain("canal");
    expect(CAMPOS_PADRAO).toContain("observaes");
  });

  it("a lista padrão não tem nenhum dado pessoal", () => {
    expect(CAMPOS_PADRAO.filter((c) => NUNCA_LIMPAR.includes(c))).toEqual([]);
    for (const pessoal of ["email", "cpf", "cnpj", "nome_completo", "link_conexa", "id_clickup"]) {
      expect(NUNCA_LIMPAR).toContain(pessoal);
    }
  });

  it("lê a chave dentro da config do Chatwoot", () => {
    expect(
      lerConfigDaLimpeza({ limpezaDoContato: { ligada: true, campos: ["canal"] } }),
    ).toEqual({ ligada: true, campos: ["canal"] });
  });

  it("config gravada à mão com dado pessoal cai no padrão desligado", () => {
    expect(lerConfigDaLimpeza({ limpezaDoContato: { ligada: true, campos: ["cpf"] } }).ligada).toBe(false);
  });

  it("o formulário aceita chaves por linha, vírgula ou espaço, sem repetir", () => {
    expect(configDoFormulario({ ligada: true, campos: "canal\ncampanha, canal  observaes" })).toEqual({
      config: { ligada: true, campos: ["canal", "campanha", "observaes"] },
    });
  });

  it("nome da tela no lugar da chave é recusado", () => {
    expect(configDoFormulario({ ligada: true, campos: "Qualificação" })).toMatchObject({
      erro: expect.stringMatching(/CHAVE/),
    });
  });

  it("dado pessoal na lista é recusado", () => {
    expect(configDoFormulario({ ligada: true, campos: "canal\ncpf\nemail" })).toMatchObject({
      erro: "cpf, email: dado pessoal ou de ligação, nunca é limpo.",
    });
  });

  it("lista vazia é recusada", () => {
    expect(configDoFormulario({ ligada: true, campos: "  " })).toMatchObject({ erro: expect.any(String) });
  });
});

describe("camposParaLimpar", () => {
  it("só os da lista que estão preenchidos; os pessoais ficam", () => {
    const atributos = {
      canal: "Site",
      campanha: "Hub Empreendedoras",
      qualificao: "",
      observaes: "ligar depois",
      email: "cliente@exemplo.com",
      cpf: "12345678909",
      id_clickup: "86abc",
    };
    expect(camposParaLimpar(atributos, CAMPOS_PADRAO)).toEqual(["canal", "campanha", "observaes"]);
  });

  it("dado pessoal nunca sai, nem se estiver na lista", () => {
    expect(camposParaLimpar({ cpf: "123", canal: "Site" }, ["cpf", "canal"])).toEqual(["canal"]);
  });
});

describe("decidirLimpeza", () => {
  const base = { conversaId: 10954, status: "resolved", contactId: 77, outras: [] };

  it("resolvida e sem outra conversa em andamento: limpa", () => {
    expect(decidirLimpeza(base)).toEqual({ acao: "limpar" });
  });

  it("reaberta: o atendimento continua, não limpa", () => {
    expect(decidirLimpeza({ ...base, status: "open" })).toMatchObject({ acao: "pular" });
  });

  it("o contato tem outra conversa em andamento: não limpa", () => {
    expect(
      decidirLimpeza({
        ...base,
        outras: [
          { id: 10954, status: "resolved" },
          { id: 15001, status: "resolved" },
          { id: 15100, status: "pending" },
        ],
      }),
    ).toEqual({
      acao: "pular",
      motivo: "o contato tem outra conversa em andamento (#15100): os campos podem ser dela",
    });
  });

  it("sem contato: não limpa", () => {
    expect(decidirLimpeza({ ...base, contactId: null })).toMatchObject({ acao: "pular" });
  });
});

describe("chaveDaLimpeza", () => {
  it("cada resolução tem a sua: reabrir e resolver de novo é outra", () => {
    expect(chaveDaLimpeza(10954, 1794935000)).toBe("conversa:10954:1794935000");
  });
});
