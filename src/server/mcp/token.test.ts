import { describe, expect, it } from "vitest";
import {
  dicaDoToken,
  extrairBearer,
  hashDoToken,
  novoTokenMcp,
  pareceTokenMcp,
  PREFIXO_DO_TOKEN,
} from "./token";

describe("token pessoal do MCP", () => {
  it("nasce com o prefixo e com entropia de sobra", () => {
    const { token } = novoTokenMcp();
    expect(token.startsWith(PREFIXO_DO_TOKEN)).toBe(true);
    // 32 bytes em base64url = 43 caracteres depois do prefixo.
    expect(token.length).toBe(PREFIXO_DO_TOKEN.length + 43);
    expect(pareceTokenMcp(token)).toBe(true);
  });

  it("dois tokens nunca se repetem", () => {
    const vistos = new Set(Array.from({ length: 50 }, () => novoTokenMcp().token));
    expect(vistos.size).toBe(50);
  });

  it("o hash guardado é determinístico e não contém o token", () => {
    const { token, hash } = novoTokenMcp();
    expect(hashDoToken(token)).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token.slice(PREFIXO_DO_TOKEN.length, PREFIXO_DO_TOKEN.length + 8));
  });

  it("a dica mostra só a ponta", () => {
    const { token, hint } = novoTokenMcp();
    expect(hint).toBe(dicaDoToken(token));
    expect(hint.endsWith(token.slice(-4))).toBe(true);
    expect(hint.length).toBeLessThan(PREFIXO_DO_TOKEN.length + 10);
  });

  it("só aceita o esquema Bearer", () => {
    expect(extrairBearer("Bearer abc")).toBe("abc");
    expect(extrairBearer("bearer   abc  ")).toBe("abc");
    expect(extrairBearer("Basic abc")).toBeNull();
    expect(extrairBearer("abc")).toBeNull();
    expect(extrairBearer("Bearer a b")).toBeNull();
    expect(extrairBearer(null)).toBeNull();
  });

  it("recusa de graça o que nem parece token", () => {
    expect(pareceTokenMcp("pk_123")).toBe(false);
    expect(pareceTokenMcp(`${PREFIXO_DO_TOKEN}curto`)).toBe(false);
  });
});
