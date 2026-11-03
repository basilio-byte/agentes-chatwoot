import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emHorarioDeAquecer,
  pedirAquecimentoDoPainel,
  reiniciarRelogioDoAquecimento,
  tokenDoAquecimento,
  tokenDoAquecimentoConfere,
} from "./aquecer";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const SEGREDO = "segredo-de-teste";
// Terça-feira, 11h em São Paulo (UTC-3).
const ONZE_DA_MANHA = Date.parse("2026-11-03T14:00:00Z");

const resposta = (ok: boolean, corpo: unknown = { ok: true }) =>
  ({ ok, status: ok ? 200 : 404, json: async () => corpo }) as unknown as Response;

/** Deixa a promessa de fundo do pedido terminar. */
const esperarOFundo = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => reiniciarRelogioDoAquecimento());

describe("o token do aquecimento", () => {
  it("é derivado da AUTH_SECRET, confere e muda com o segredo", () => {
    const token = tokenDoAquecimento(SEGREDO)!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenDoAquecimentoConfere(token, SEGREDO)).toBe(true);
    expect(tokenDoAquecimentoConfere(token, "outro-segredo")).toBe(false);
  });

  it("⚠ sem segredo ou sem token apresentado, nada confere", () => {
    expect(tokenDoAquecimento("")).toBeNull();
    expect(tokenDoAquecimentoConfere("qualquer", "")).toBe(false);
    expect(tokenDoAquecimentoConfere(null, SEGREDO)).toBe(false);
    expect(tokenDoAquecimentoConfere("curto", SEGREDO)).toBe(false);
  });
});

describe("horário de aquecer", () => {
  it("das 6h às 22h em São Paulo — e não pelo relógio UTC do container", () => {
    expect(emHorarioDeAquecer(new Date("2026-11-03T09:00:00Z"))).toBe(true); // 6h em SP
    expect(emHorarioDeAquecer(new Date("2026-11-03T08:59:00Z"))).toBe(false); // 5h59
    expect(emHorarioDeAquecer(new Date("2026-11-03T14:00:00Z"))).toBe(true); // 11h
    expect(emHorarioDeAquecer(new Date("2026-11-04T00:59:00Z"))).toBe(true); // 21h59
    expect(emHorarioDeAquecer(new Date("2026-11-04T01:00:00Z"))).toBe(false); // 22h
    expect(emHorarioDeAquecer(new Date("2026-11-03T03:00:00Z"))).toBe(false); // 0h
  });
});

describe("o pedido do worker ao painel", () => {
  it("manda o token no cabeçalho para o próprio container e conta como feito quando a rota responde bem", async () => {
    const buscar = vi.fn(async () => resposta(true, { ok: true, tempos: { macros: "2700 ms" } }));

    expect(pedirAquecimentoDoPainel({ agora: ONZE_DA_MANHA, buscar, porta: "3000", segredo: SEGREDO })).toBe(true);
    await esperarOFundo();

    const [url, init] = buscar.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/api/interno/aquecer");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-aquecer"]).toBe(tokenDoAquecimento(SEGREDO));

    // Feito há pouco: o vigia roda de minuto em minuto, e o pedido sai a cada 4.
    expect(pedirAquecimentoDoPainel({ agora: ONZE_DA_MANHA + 60_000, buscar, segredo: SEGREDO })).toBe(false);
    expect(pedirAquecimentoDoPainel({ agora: ONZE_DA_MANHA + 4 * 60_000, buscar, segredo: SEGREDO })).toBe(true);
    expect(buscar).toHaveBeenCalledTimes(2);
  });

  it("⚠ painel ainda subindo (conexão recusada) NÃO conta como feito: o próximo tick tenta de novo", async () => {
    const buscar = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    pedirAquecimentoDoPainel({ agora: ONZE_DA_MANHA, buscar, segredo: SEGREDO, repetirEmMs: null });
    await esperarOFundo();
    expect(pedirAquecimentoDoPainel({ agora: ONZE_DA_MANHA + 60_000, buscar, segredo: SEGREDO, repetirEmMs: null })).toBe(true);
    expect(buscar).toHaveBeenCalledTimes(2);
  });

  it("recusa do painel (token errado) também não conta como feito", async () => {
    const buscar = vi.fn(async () => resposta(false));
    pedirAquecimentoDoPainel({ agora: ONZE_DA_MANHA, buscar, segredo: SEGREDO });
    await esperarOFundo();
    expect(pedirAquecimentoDoPainel({ agora: ONZE_DA_MANHA + 60_000, buscar, segredo: SEGREDO })).toBe(true);
  });

  it("fora do horário de uso não pede nada", () => {
    const buscar = vi.fn(async () => resposta(true));
    const tresDaManha = Date.parse("2026-11-03T06:00:00Z"); // 3h em SP
    expect(pedirAquecimentoDoPainel({ agora: tresDaManha, buscar, segredo: SEGREDO })).toBe(false);
    expect(buscar).not.toHaveBeenCalled();
  });

  it("sem AUTH_SECRET não há como pedir: não pede", () => {
    const buscar = vi.fn(async () => resposta(true));
    expect(pedirAquecimentoDoPainel({ agora: ONZE_DA_MANHA, buscar, segredo: "" })).toBe(false);
    expect(buscar).not.toHaveBeenCalled();
  });

  it("dois pedidos ao mesmo tempo viram um só", async () => {
    let liberar!: () => void;
    const buscar = vi.fn(() => new Promise<Response>((r) => (liberar = () => r(resposta(true)))));

    expect(pedirAquecimentoDoPainel({ agora: ONZE_DA_MANHA, buscar, segredo: SEGREDO })).toBe(true);
    expect(pedirAquecimentoDoPainel({ agora: ONZE_DA_MANHA + 1_000, buscar, segredo: SEGREDO })).toBe(false);
    liberar();
    await esperarOFundo();
    expect(buscar).toHaveBeenCalledTimes(1);
  });
});
