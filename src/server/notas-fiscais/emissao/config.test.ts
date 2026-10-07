import { describe, expect, it } from "vitest";
import {
  configDoFormulario,
  lerConfigNotasFiscais,
  lerCobrancasLiberadas,
  notasFiscaisConfigSchema,
} from "../config";

const atual = notasFiscaisConfigSchema.parse({});

describe("config da emissão", () => {
  it("⚠ a config gravada ANTES da emissão existir carrega DESLIGADA, com as empresas certas", () => {
    const antiga = lerConfigNotasFiscais({ modo: "sombra", inicio: "2026-10-05", codigos: { "10": "03.03.02" } });
    expect(antiga.emissao).toEqual({
      ligada: false,
      soCobrancas: [],
      aPartirDe: null,
      enviarEmailAoCliente: true,
    });
    // 3 = SEAHUB COWORKING e 4 = SEATECH (conferido na configuração do Conexa).
    expect(antiga.empresas).toEqual({ "3": "SEAHUB", "4": "SEATECH" });
  });

  it("config sem nada nasce desligada", () => {
    expect(lerConfigNotasFiscais(null).emissao.ligada).toBe(false);
    expect(lerConfigNotasFiscais({ emissao: "lixo" }).emissao.ligada).toBe(false);
  });

  it("lê os ids liberados separados por espaço, vírgula ou linha, sem repetir", () => {
    expect(lerCobrancasLiberadas("31450 31451,31450\n31452")).toEqual({ ids: [31450, 31451, 31452] });
    expect(lerCobrancasLiberadas("")).toEqual({ ids: [] });
  });

  it("⚠ um id inválido recusa tudo, dizendo qual", () => {
    expect(lerCobrancasLiberadas("31450 abc")).toEqual({
      erro: 'Cobranças liberadas: "abc" não é um id de cobrança do Conexa.',
    });
    expect(lerCobrancasLiberadas("0")).toHaveProperty("erro");
  });
});

describe("formulário da emissão", () => {
  const form = (campos: Record<string, string>) => configDoFormulario(campos, atual);

  it("⚠ ligar a emissão SEM lista e SEM dia de corte é recusado", () => {
    const r = form({ emissaoLigada: "on" });
    expect(r).toHaveProperty("erro");
    expect((r as { erro: string }).erro).toMatch(/cobranças liberadas OU o dia do corte/);
  });

  it("ligada com lista liberada: aceita", () => {
    const r = form({ emissaoLigada: "on", soCobrancas: "31450" });
    expect(r).toHaveProperty("config");
    expect((r as { config: typeof atual }).config.emissao).toMatchObject({ ligada: true, soCobrancas: [31450] });
  });

  it("ligada com dia de corte: aceita", () => {
    const r = form({ emissaoLigada: "on", aPartirDe: "2026-10-20" });
    expect((r as { config: typeof atual }).config.emissao).toMatchObject({ ligada: true, aPartirDe: "2026-10-20" });
  });

  it("desligada não exige nada, e o e-mail ao cliente segue o que foi marcado", () => {
    const r = form({ enviarEmailAoCliente: "on" }) as { config: typeof atual };
    expect(r.config.emissao.ligada).toBe(false);
    expect(r.config.emissao.enviarEmailAoCliente).toBe(true);
    const sem = form({}) as { config: typeof atual };
    expect(sem.config.emissao.enviarEmailAoCliente).toBe(false);
  });

  it("dia de corte inválido é recusado", () => {
    expect(form({ aPartirDe: "amanhã" })).toHaveProperty("erro");
  });

  it("salvar a tela não apaga as empresas nem as regras já gravadas", () => {
    const com = notasFiscaisConfigSchema.parse({ empresas: { "3": "SEAHUB", "4": "SEATECH", "9": "SEATECH" } });
    const r = configDoFormulario({ produtos: "2849 03.03.02" }, com) as { config: typeof atual };
    expect(r.config.empresas["9"]).toBe("SEATECH");
    expect(r.config.produtos).toHaveLength(1);
  });
});
