import { describe, expect, it } from "vitest";
import { gerarToken, tokenConfere } from "./token";

describe("gerarToken", () => {
  it("gera token seguro como segmento de URL, sem encoding", () => {
    const token = gerarToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("não repete entre chamadas", () => {
    const a = gerarToken();
    const b = gerarToken();
    expect(a).not.toBe(b);
  });

  it("tem entropia alta o bastante para não precisar de rate-limit de brute-force", () => {
    // 32 bytes crus viram pelo menos 32 caracteres em base64url (compacta, não expande).
    expect(gerarToken().length).toBeGreaterThanOrEqual(32);
  });
});

describe("tokenConfere", () => {
  it("aceita o token certo", () => {
    const token = gerarToken();
    expect(tokenConfere(token, token)).toBe(true);
  });

  it("recusa token errado", () => {
    expect(tokenConfere("token-errado", gerarToken())).toBe(false);
  });

  it("recusa string vazia", () => {
    expect(tokenConfere("", gerarToken())).toBe(false);
  });

  it("comprimentos diferentes não estouram — timingSafeEqual exige tamanhos iguais", () => {
    expect(tokenConfere("curto", "um-token-bem-mais-longo-do-que-isso")).toBe(false);
  });
});
