import { afterEach, describe, expect, it, vi } from "vitest";
import { chaveDaSpedy, ehRecusaDefinitiva, SpedyApiError, SpedyClient, SpedyRedeError } from "./client";

const corpo = {
  integrationId: "conexa-1-030302",
  issue: true,
  sendEmailToCustomer: false,
  description: "x",
  nationalTaxationCode: "030302",
  receiver: { name: "A", federalTaxNumber: "04578999483", address: { postalCode: "59056000", country: "BRA" } },
  total: { invoiceAmount: 1 },
};

function resposta(status: number, json: unknown) {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("cliente da Spedy", () => {
  it("manda a chave no cabeçalho X-Api-Key e o corpo em JSON", async () => {
    const f = vi.fn(async () => resposta(200, { id: "n1", integrationId: "conexa-1-030302", status: "enqueued", number: 0 }));
    vi.stubGlobal("fetch", f);
    const nota = await new SpedyClient("chave-secreta", "https://spedy.teste").criarNota(corpo);

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://spedy.teste/v1/service-invoices");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("chave-secreta");
    expect(JSON.parse(String(init.body)).nationalTaxationCode).toBe("030302");
    expect(nota).toMatchObject({ id: "n1", status: "enqueued", number: null });
  });

  it("número 0 do rascunho não é número de nota", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resposta(200, { id: "n", status: "created", number: 0 })));
    expect((await new SpedyClient("k", "https://s").obterNota("n")).number).toBeNull();
  });

  it("⚠ recusa 4xx traz a mensagem da Spedy e é definitiva; 429, 408 e 5xx não", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resposta(400, { message: "CEP inválido", errors: ["receiver.address.postalCode"] })));
    const erro = await new SpedyClient("k", "https://s").criarNota(corpo).catch((e) => e);
    expect(erro).toBeInstanceOf(SpedyApiError);
    expect(erro.message).toMatch(/400.*CEP inválido.*postalCode/);
    expect(ehRecusaDefinitiva(erro)).toBe(true);
    expect(ehRecusaDefinitiva(new SpedyApiError(429, "x"))).toBe(false);
    expect(ehRecusaDefinitiva(new SpedyApiError(408, "x"))).toBe(false);
    expect(ehRecusaDefinitiva(new SpedyApiError(503, "x"))).toBe(false);
    expect(ehRecusaDefinitiva(new SpedyRedeError("x"))).toBe(false);
  });

  it("queda de rede vira SpedyRedeError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    await expect(new SpedyClient("k", "https://s").obterNota("n")).rejects.toBeInstanceOf(SpedyRedeError);
  });

  it("procura a nota pelo identificador nosso e só aceita a que bate", async () => {
    const f = vi.fn(async () => resposta(200, { items: [{ id: "a", integrationId: "outra", status: "authorized" }, { id: "b", integrationId: "conexa-1-030302", status: "enqueued" }] }));
    vi.stubGlobal("fetch", f);
    const achada = await new SpedyClient("k", "https://s").buscarPorIntegrationId("conexa-1-030302");
    expect(achada?.id).toBe("b");
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("integrationId=conexa-1-030302");

    vi.stubGlobal("fetch", vi.fn(async () => resposta(200, { items: [] })));
    expect(await new SpedyClient("k", "https://s").buscarPorIntegrationId("nada")).toBeNull();
  });

  it("⚠ o cliente NÃO sabe cancelar nem apagar nota: um bug nosso nunca cancela nota fiscal", () => {
    const metodos = Object.getOwnPropertyNames(SpedyClient.prototype);
    expect(metodos.filter((m) => /cancel|delet|apag|remov|exclu/i.test(m))).toEqual([]);
  });

  it("a chave vem da variável do servidor, por empresa", () => {
    vi.stubEnv("SPEDY_KEY_SEATECH", "  abc ");
    expect(chaveDaSpedy("SEATECH")).toBe("abc");
    expect(chaveDaSpedy("SEAHUB")).toBeNull();
    vi.unstubAllEnvs();
  });
});
