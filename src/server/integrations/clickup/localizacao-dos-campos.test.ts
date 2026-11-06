import { describe, expect, it } from "vitest";
import { resolverLocalizacoes, type Geocodificador } from "./localizacao-dos-campos";
import { prepararCampos } from "./campos";

const CAMPOS = [
  { id: "f-nome", name: "NOME CLIENTE", type: "short_text" },
  { id: "f-end", name: "📍 Endereço Sócio", type: "location" },
  { id: "f-sede", name: "Sede da Empresa", type: "short_text" },
];

const achou: Geocodificador = async () => ({ lat: -5.83, lng: -35.22 });
const naoAchou: Geocodificador = async () => null;

describe("resolverLocalizacoes", () => {
  it("converte o texto do campo de localização no valor da API", async () => {
    const r = await resolverLocalizacoes(
      [{ campo: "📍 Endereço Sócio", valor: "Rua Jaguarari, 4985, Candelária, Natal - RN, 59064-500" }],
      CAMPOS,
      achou,
    );

    expect(r.avisos).toEqual([]);
    expect(r.entradas).toEqual([
      {
        campo: "📍 Endereço Sócio",
        valor: {
          location: { lat: -5.83, lng: -35.22 },
          formatted_address: "Rua Jaguarari, 4985, Candelária, Natal - RN, 59064-500",
        },
      },
    ]);
  });

  it("acha o campo pelo nome como o agente o escreve, sem o emoji", async () => {
    const r = await resolverLocalizacoes([{ campo: "Endereço Sócio", valor: "Rua X, 1, Natal" }], CAMPOS, achou);
    expect(r.entradas[0].valor).toMatchObject({ formatted_address: "Rua X, 1, Natal" });
  });

  it("⚠ endereço que não acha NÃO derruba o lote: o campo sai, os outros ficam, e o motivo volta", async () => {
    const r = await resolverLocalizacoes(
      [
        { campo: "NOME CLIENTE", valor: "Maria" },
        { campo: "📍 Endereço Sócio", valor: "algum lugar" },
        { campo: "Sede da Empresa", valor: "Rua das Flores, 100" },
      ],
      CAMPOS,
      naoAchou,
    );

    expect(r.entradas.map((e) => e.campo)).toEqual(["NOME CLIENTE", "Sede da Empresa"]);
    expect(r.avisos).toHaveLength(1);
    expect(r.avisos[0].campo).toBe("📍 Endereço Sócio");
    expect(r.avisos[0].motivo).toContain("a equipe o preenche");
    // E o lote que sobra passa limpo por `prepararCampos`.
    expect(prepararCampos(r.entradas, CAMPOS).problemas).toEqual([]);
  });

  it("campo que não é de localização passa intacto, mesmo com texto de endereço", async () => {
    const entrada = { campo: "Sede da Empresa", valor: "Rua das Flores, 100, Natal - RN" };
    const r = await resolverLocalizacoes([entrada], CAMPOS, async () => {
      throw new Error("não devia geocodificar a sede");
    });
    expect(r.entradas).toEqual([entrada]);
  });

  it("valor que já veio convertido passa, e campo que não existe fica para o `prepararCampos` recusar", async () => {
    const pronto = { campo: "📍 Endereço Sócio", valor: { location: { lat: -5.83, lng: -35.22 }, formatted_address: "Rua X" } };
    const desconhecido = { campo: "Campo Inexistente", valor: "x" };
    const r = await resolverLocalizacoes([pronto, desconhecido], CAMPOS, naoAchou);
    expect(r.entradas).toEqual([pronto, desconhecido]);
    expect(r.avisos).toEqual([]);
  });

  it("texto em branco não é geocodificado: vira aviso", async () => {
    const r = await resolverLocalizacoes([{ campo: "📍 Endereço Sócio", valor: "   " }], CAMPOS, async () => {
      throw new Error("não devia chamar");
    });
    expect(r.entradas).toEqual([]);
    expect(r.avisos[0].motivo).toContain("vazio");
  });

  it("manda ao geocodificador o endereço limpo", async () => {
    let recebido = "";
    await resolverLocalizacoes([{ campo: "📍 Endereço Sócio", valor: "  Rua   X,\n 1 " }], CAMPOS, async (e) => {
      recebido = e;
      return { lat: -5.83, lng: -35.22 };
    });
    expect(recebido).toBe("Rua X, 1");
  });
});
