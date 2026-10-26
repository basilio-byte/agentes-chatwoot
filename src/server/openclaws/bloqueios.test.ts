import { describe, expect, it } from "vitest";
import type { LinhaDeLimite } from "./agregacao";
import { detectarBloqueios, horasBloqueadasEntre } from "./bloqueios";

const utc = (s: string) => new Date(`${s}Z`);

/** 429 a cada hora cheia, de `de` a `ate` (inclusive), `por` por hora. */
function recusas(
  conteiner: string,
  de: string,
  ate: string,
  por = 4,
  categoria = "rate_limit",
): LinhaDeLimite[] {
  const linhas: LinhaDeLimite[] = [];
  for (let t = utc(de).getTime(); t <= utc(ate).getTime(); t += 3_600_000) {
    linhas.push({ hora: new Date(t), conteiner, categoria, quantidade: por });
  }
  return linhas;
}

describe("detectarBloqueios", () => {
  it("o bloqueio de 22 a 25/10: da primeira recusa até a hora da última", () => {
    const limites = recusas("fkv5", "2026-10-22T16:00", "2026-10-25T18:00", 3);
    const [b] = detectarBloqueios(limites, utc("2026-10-26T11:30"));
    expect(b.inicio.toISOString()).toBe("2026-10-22T16:00:00.000Z");
    // Fim = fim da hora da última recusa: 18:32 → a conta voltou às 19:00.
    expect(b.fim.toISOString()).toBe("2026-10-25T19:00:00.000Z");
    expect(b.horas).toBe(75);
    expect(b.recusas).toBe(75 * 3);
    expect(b.emCurso).toBe(false);
  });

  it("recusa isolada não é bloqueio (pico de requisições por minuto também dá 429)", () => {
    const limites: LinhaDeLimite[] = [
      { hora: utc("2026-10-10T18:00"), conteiner: "2bpu", categoria: "rate_limit", quantidade: 1 },
      { hora: utc("2026-10-12T04:00"), conteiner: "8bgs", categoria: "rate_limit", quantidade: 4 },
    ];
    expect(detectarBloqueios(limites, utc("2026-10-26T11:30"))).toEqual([]);
  });

  it("muita recusa em poucas horas também não: bloqueio é contínuo", () => {
    const limites = recusas("lr9a", "2026-10-12T10:00", "2026-10-12T11:00", 50);
    expect(detectarBloqueios(limites, utc("2026-10-26T11:30"))).toEqual([]);
  });

  it("uma hora sem recusa no meio é falha de coleta, não o fim do bloqueio", () => {
    const limites = [
      ...recusas("fkv5", "2026-10-17T23:00", "2026-10-18T03:00", 4),
      ...recusas("fkv5", "2026-10-18T05:00", "2026-10-18T18:00", 4),
    ];
    const bloqueios = detectarBloqueios(limites, utc("2026-10-26T11:30"));
    expect(bloqueios).toHaveLength(1);
    expect(bloqueios[0].inicio.toISOString()).toBe("2026-10-17T23:00:00.000Z");
    expect(bloqueios[0].fim.toISOString()).toBe("2026-10-18T19:00:00.000Z");
  });

  it("buraco de mais de três horas separa dois bloqueios", () => {
    const limites = [
      ...recusas("fkv5", "2026-10-02T20:00", "2026-10-04T18:00", 4),
      ...recusas("fkv5", "2026-10-09T23:00", "2026-10-11T18:00", 4),
    ];
    const bloqueios = detectarBloqueios(limites, utc("2026-10-26T11:30"));
    expect(bloqueios.map((b) => b.inicio.toISOString())).toEqual([
      "2026-10-09T23:00:00.000Z",
      "2026-10-02T20:00:00.000Z",
    ]);
  });

  it("junta os OpenClaws que levaram recusa na mesma janela", () => {
    const limites = [
      ...recusas("lr9a", "2026-10-22T16:00", "2026-10-25T18:00", 1),
      ...recusas("fkv5", "2026-10-22T16:00", "2026-10-25T18:00", 3),
    ];
    const [b] = detectarBloqueios(limites, utc("2026-10-26T11:30"));
    expect(b.conteineres).toEqual(["fkv5", "lr9a"]);
    expect(b.recusas).toBe(75 * 4);
  });

  it("só olha os contêineres da conta: recusa de quem tem credencial própria não conta", () => {
    const limites = recusas("2bpu", "2026-10-22T16:00", "2026-10-25T18:00", 4);
    expect(detectarBloqueios(limites, utc("2026-10-26T11:30"), new Set(["lr9a", "fkv5"]))).toEqual([]);
    expect(detectarBloqueios(limites, utc("2026-10-26T11:30"))).toHaveLength(1);
  });

  it("ignora o que não é rate_limit", () => {
    const limites = recusas("lr9a", "2026-10-25T00:00", "2026-10-25T10:00", 6, "prompt_too_long");
    expect(detectarBloqueios(limites, utc("2026-10-26T11:30"))).toEqual([]);
  });

  it("bloqueio com recusa na última hora está em curso", () => {
    const limites = recusas("fkv5", "2026-10-26T04:00", "2026-10-26T10:00", 4);
    const [b] = detectarBloqueios(limites, utc("2026-10-26T11:10"));
    expect(b.emCurso).toBe(true);
  });

  it("o mais recente vem primeiro", () => {
    const limites = [
      ...recusas("fkv5", "2026-10-02T20:00", "2026-10-04T18:00", 4),
      ...recusas("fkv5", "2026-10-22T16:00", "2026-10-25T18:00", 4),
    ];
    const bloqueios = detectarBloqueios(limites, utc("2026-10-26T11:30"));
    expect(bloqueios[0].inicio.getTime()).toBeGreaterThan(bloqueios[1].inicio.getTime());
  });
});

describe("horasBloqueadasEntre", () => {
  const bloqueios = detectarBloqueios(
    recusas("fkv5", "2026-10-22T16:00", "2026-10-25T18:00", 3),
    utc("2026-10-26T11:30"),
  );

  it("conta só a parte que cai na janela", () => {
    // Ciclo 18/10 19h → 25/10 19h pega 22/10 16h → 25/10 19h = 75 h.
    expect(horasBloqueadasEntre(bloqueios, utc("2026-10-18T19:00"), utc("2026-10-25T19:00"))).toBe(75);
    // Ciclo seguinte não tem nenhuma.
    expect(horasBloqueadasEntre(bloqueios, utc("2026-10-25T19:00"), utc("2026-11-01T19:00"))).toBe(0);
    // Janela cortando o meio.
    expect(horasBloqueadasEntre(bloqueios, utc("2026-10-24T19:00"), utc("2026-10-25T19:00"))).toBe(24);
  });
});
