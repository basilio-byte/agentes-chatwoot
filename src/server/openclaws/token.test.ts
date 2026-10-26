import { describe, expect, it } from "vitest";
import { hashDoToken } from "@/server/mcp/token";
import { novoTokenDoColetor, PREFIXO_DO_COLETOR, tokenDoColetorConfere } from "./token";

describe("token do coletor", () => {
  it("nasce com prefixo reconhecível e 256 bits de entropia", () => {
    const { token, hash, dica } = novoTokenDoColetor();
    expect(token.startsWith(PREFIXO_DO_COLETOR)).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(PREFIXO_DO_COLETOR.length + 43);
    expect(hash).toBe(hashDoToken(token));
    expect(dica).toBe(`${PREFIXO_DO_COLETOR}…${token.slice(-4)}`);
    expect(dica).not.toContain(token);
  });

  it("dois tokens nunca saem iguais", () => {
    expect(novoTokenDoColetor().token).not.toBe(novoTokenDoColetor().token);
  });

  it("confere o token certo contra o hash guardado", () => {
    const { token, hash } = novoTokenDoColetor();
    expect(tokenDoColetorConfere(token, hash)).toBe(true);
  });

  it("recusa token errado, vazio ou de outro tipo", () => {
    const { token, hash } = novoTokenDoColetor();
    expect(tokenDoColetorConfere(`${token}x`, hash)).toBe(false);
    expect(tokenDoColetorConfere(novoTokenDoColetor().token, hash)).toBe(false);
    expect(tokenDoColetorConfere("", hash)).toBe(false);
    expect(tokenDoColetorConfere(null, hash)).toBe(false);
    // Um token do MCP, mesmo que o hash fosse o dele, não abre esta porta.
    expect(tokenDoColetorConfere("seahub_mcp_abc", hashDoToken("seahub_mcp_abc"))).toBe(false);
  });

  it("sem hash guardado, nada confere", () => {
    expect(tokenDoColetorConfere(novoTokenDoColetor().token, null)).toBe(false);
    expect(tokenDoColetorConfere(novoTokenDoColetor().token, undefined)).toBe(false);
    expect(tokenDoColetorConfere(novoTokenDoColetor().token, "")).toBe(false);
  });
});
