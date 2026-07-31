import { describe, expect, it } from "vitest";
import { proximoDoRodizio } from "./rodizio";

const DUPLA = ["Kelly", "Alan"];

describe("proximoDoRodizio", () => {
  it("sem registro anterior, começa pelo primeiro", () => {
    expect(proximoDoRodizio(DUPLA, null)).toBe("Kelly");
    expect(proximoDoRodizio(DUPLA, undefined)).toBe("Kelly");
  });

  it("alterna e volta ao começo", () => {
    expect(proximoDoRodizio(DUPLA, "Kelly")).toBe("Alan");
    expect(proximoDoRodizio(DUPLA, "Alan")).toBe("Kelly");
  });

  it("gira por três ou mais sem pular ninguém", () => {
    const trio = ["Ana", "Bruno", "Carla"];
    const visitados: string[] = [];
    let ultimo: string | null = null;

    for (let i = 0; i < 6; i++) {
      ultimo = proximoDoRodizio(trio, ultimo);
      visitados.push(ultimo!);
    }

    expect(visitados).toEqual(["Ana", "Bruno", "Carla", "Ana", "Bruno", "Carla"]);
  });

  it("ignora acento e caixa ao localizar o último", () => {
    expect(proximoDoRodizio(["Ítalo", "Laércio"], "italo")).toBe("Laércio");
    expect(proximoDoRodizio(["Ítalo", "Laércio"], "LAERCIO")).toBe("Ítalo");
  });

  it("quem saiu da lista não trava o rodízio", () => {
    // Kelly deixou a equipe; o registro ainda aponta para ela.
    expect(proximoDoRodizio(["Alan", "Bruno"], "Kelly")).toBe("Alan");
  });

  it("um participante só recebe sempre", () => {
    expect(proximoDoRodizio(["Alan"], "Alan")).toBe("Alan");
  });

  it("lista vazia não escolhe ninguém", () => {
    expect(proximoDoRodizio([], "Alan")).toBeNull();
    expect(proximoDoRodizio(["  ", ""], null)).toBeNull();
  });
});
