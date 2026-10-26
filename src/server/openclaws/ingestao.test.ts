import { describe, expect, it } from "vitest";
import { MAX_DE_LINHAS_POR_LOTE, resumoDoLote, validarLote } from "./ingestao";

const AGORA = new Date("2026-10-26T12:00:00Z");

function loteValido(extra: Record<string, unknown> = {}) {
  return {
    desde: "2026-10-26T00:00:00Z",
    ate: "2026-10-26T12:00:00Z",
    conteineres: ["lr9a", "fkv5"],
    uso: [
      {
        hora: "2026-10-26T09:00:00Z",
        conteiner: "lr9a",
        agente: "main",
        tipo: "main",
        modelo: "claude-sonnet-5",
        chamadas: 4,
        entrada: 120,
        saida: 3400,
        cacheLeitura: 900000,
        cacheEscrita: 50000,
      },
    ],
    limites: [
      { hora: "2026-10-26T09:00:00Z", conteiner: "fkv5", categoria: "rate_limit", quantidade: 4 },
    ],
    ...extra,
  };
}

const erroDe = (bruto: unknown) => {
  const r = validarLote(bruto, AGORA);
  return r.ok ? null : r.erro;
};

describe("validarLote", () => {
  it("aceita um lote bem formado e devolve datas de verdade", () => {
    const r = validarLote(loteValido(), AGORA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lote.desde).toBeInstanceOf(Date);
    expect(r.lote.uso[0].hora.toISOString()).toBe("2026-10-26T09:00:00.000Z");
    expect(r.lote.limites[0].categoria).toBe("rate_limit");
  });

  it("aceita lote sem nenhuma linha: a janela inteira foi sem uso", () => {
    expect(validarLote(loteValido({ uso: [], limites: [] }), AGORA).ok).toBe(true);
  });

  it("recusa campo que não conhece (o Zod comum o jogaria fora em silêncio)", () => {
    expect(erroDe(loteValido({ token: "x" }))).toMatch(/inválido/);
    const uso = loteValido().uso.map((u) => ({ ...u, custo: 3 }));
    expect(erroDe(loteValido({ uso }))).toMatch(/uso\.0/);
  });

  it("recusa janela que não começa e termina em hora cheia", () => {
    expect(erroDe(loteValido({ desde: "2026-10-26T00:30:00Z" }))).toMatch(/horas cheias/);
    expect(erroDe(loteValido({ ate: "2026-10-26T11:59:59Z" }))).toMatch(/horas cheias/);
  });

  it("recusa janela invertida, longa demais ou no futuro", () => {
    expect(erroDe(loteValido({ desde: "2026-10-26T12:00:00Z", ate: "2026-10-26T00:00:00Z" }))).toMatch(/depois/);
    expect(erroDe(loteValido({ desde: "2026-08-01T00:00:00Z" }))).toMatch(/45 dias/);
    expect(erroDe(loteValido({ ate: "2026-10-27T12:00:00Z" }))).toMatch(/futuro/);
  });

  it("recusa linha de uso fora da janela, ou fora da hora cheia", () => {
    const fora = loteValido().uso.map((u) => ({ ...u, hora: "2026-10-25T09:00:00Z" }));
    expect(erroDe(loteValido({ uso: fora }))).toMatch(/fora da janela/);
    const quebrada = loteValido().uso.map((u) => ({ ...u, hora: "2026-10-26T09:15:00Z" }));
    expect(erroDe(loteValido({ uso: quebrada }))).toMatch(/fora da janela ou não cheia/);
  });

  it("a hora do `ate` é exclusiva", () => {
    const noFim = loteValido().uso.map((u) => ({ ...u, hora: "2026-10-26T12:00:00Z" }));
    expect(erroDe(loteValido({ uso: noFim }))).toMatch(/fora da janela/);
  });

  it("recusa contêiner que o lote não declarou: sem isso a janela dele não seria substituída", () => {
    const uso = loteValido().uso.map((u) => ({ ...u, conteiner: "xqxb" }));
    expect(erroDe(loteValido({ uso }))).toMatch(/xqxb.*conteineres/);
    const limites = [{ hora: "2026-10-26T09:00:00Z", conteiner: "xqxb", categoria: "rate_limit", quantidade: 1 }];
    expect(erroDe(loteValido({ limites }))).toMatch(/xqxb.*conteineres/);
  });

  it("recusa linha repetida: a chave única do banco derrubaria o lote inteiro", () => {
    const u = loteValido().uso[0];
    expect(erroDe(loteValido({ uso: [u, { ...u, chamadas: 9 }] }))).toMatch(/repetida/);
    const l = loteValido().limites[0];
    expect(erroDe(loteValido({ limites: [l, l] }))).toMatch(/repetida/);
  });

  it("a mesma hora e agente em outro modelo NÃO é repetição", () => {
    const u = loteValido().uso[0];
    expect(validarLote(loteValido({ uso: [u, { ...u, modelo: "claude-haiku-4-5" }] }), AGORA).ok).toBe(true);
  });

  it("recusa id de contêiner e de agente com formato estranho", () => {
    expect(erroDe(loteValido({ conteineres: ["LR9A!"] }))).toMatch(/inválido/);
    const uso = loteValido().uso.map((u) => ({ ...u, agente: "../x" }));
    expect(erroDe(loteValido({ uso }))).toMatch(/inválido/);
  });

  it("recusa contagem negativa, fracionária ou zero chamadas", () => {
    const base = loteValido().uso[0];
    expect(erroDe(loteValido({ uso: [{ ...base, saida: -1 }] }))).toMatch(/inválido/);
    expect(erroDe(loteValido({ uso: [{ ...base, saida: 1.5 }] }))).toMatch(/inválido/);
    expect(erroDe(loteValido({ uso: [{ ...base, chamadas: 0 }] }))).toMatch(/inválido/);
  });

  it("recusa categoria de limite desconhecida", () => {
    const limites = [{ hora: "2026-10-26T09:00:00Z", conteiner: "fkv5", categoria: "x", quantidade: 1 }];
    expect(erroDe(loteValido({ limites }))).toMatch(/inválido/);
  });

  it("recusa lote com linhas demais", () => {
    const u = loteValido().uso[0];
    const uso = Array.from({ length: MAX_DE_LINHAS_POR_LOTE + 1 }, (_, i) => ({ ...u, agente: `a${i}` }));
    expect(erroDe(loteValido({ uso }))).toMatch(/inválido/);
  });

  it("recusa corpo que nem é objeto", () => {
    expect(erroDe(null)).toMatch(/inválido/);
    expect(erroDe("texto")).toMatch(/inválido/);
    expect(erroDe([])).toMatch(/inválido/);
  });
});

describe("validarLote com a leitura real da cota", () => {
  const cota = {
    lidaEm: "2026-10-26T11:37:42Z",
    plano: "max",
    janelas: [
      { chave: "seven_day", utilizacao: 5.4, resetaEm: "2026-11-01T18:59:59.617Z" },
      { chave: "five_hour", utilizacao: 3, resetaEm: null },
    ],
  };

  it("aceita e devolve datas, com a leitura truncada ao minuto", () => {
    const r = validarLote(loteValido({ cota }), AGORA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lote.cota?.lidaEm.toISOString()).toBe("2026-10-26T11:37:00.000Z");
    expect(r.lote.cota?.plano).toBe("max");
    expect(r.lote.cota?.janelas[0].resetaEm).toBeInstanceOf(Date);
    expect(r.lote.cota?.janelas[1].resetaEm).toBeNull();
  });

  it("o lote antigo, sem cota, continua valendo (coletor sem login da conta)", () => {
    const r = validarLote(loteValido(), AGORA);
    expect(r.ok && r.lote.cota).toBeNull();
  });

  it("recusa leitura no futuro e leitura velha demais", () => {
    expect(erroDe(loteValido({ cota: { ...cota, lidaEm: "2026-10-26T13:00:00Z" } }))).toMatch(/futuro/);
    expect(erroDe(loteValido({ cota: { ...cota, lidaEm: "2026-10-24T11:00:00Z" } }))).toMatch(/mais de um dia/);
  });

  it("recusa janela repetida, utilização negativa e chave estranha", () => {
    const repetida = { ...cota, janelas: [cota.janelas[0], cota.janelas[0]] };
    expect(erroDe(loteValido({ cota: repetida }))).toMatch(/repetida/);
    const negativa = { ...cota, janelas: [{ chave: "seven_day", utilizacao: -1 }] };
    expect(erroDe(loteValido({ cota: negativa }))).toMatch(/inválido/);
    const estranha = { ...cota, janelas: [{ chave: "../x", utilizacao: 1 }] };
    expect(erroDe(loteValido({ cota: estranha }))).toMatch(/inválido/);
  });

  it("recusa leitura sem janela nenhuma e campo que não conhece", () => {
    expect(erroDe(loteValido({ cota: { ...cota, janelas: [] } }))).toMatch(/inválido/);
    expect(erroDe(loteValido({ cota: { ...cota, token: "x" } }))).toMatch(/inválido/);
  });

  it("o resumo diz que veio cota real", () => {
    const r = validarLote(loteValido({ cota }), AGORA);
    if (!r.ok) throw new Error(r.erro);
    expect(resumoDoLote(r.lote)).toContain("cota real de 2 janela(s)");
  });
});

describe("resumoDoLote", () => {
  it("diz quantas linhas e a janela, em UTC", () => {
    const r = validarLote(loteValido(), AGORA);
    if (!r.ok) throw new Error(r.erro);
    expect(resumoDoLote(r.lote)).toBe("1 linhas de uso e 1 de recusa, 2026-10-26 00:00 a 2026-10-26 12:00 UTC");
  });
});
