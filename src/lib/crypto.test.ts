import { describe, expect, it } from "vitest";
import { cifrar, decifrar, gerarHint } from "./crypto";

describe("cifra de credenciais", () => {
  it("faz round-trip do segredo", () => {
    const segredo = "chatwoot_bot_token_9f3a2b1c";
    const cifrado = cifrar(segredo);

    expect(cifrado.ciphertext).not.toContain(segredo);
    expect(decifrar(cifrado)).toBe(segredo);
  });

  it("gera IV diferente a cada cifragem do mesmo texto", () => {
    const a = cifrar("mesmo-segredo");
    const b = cifrar("mesmo-segredo");

    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejeita ciphertext adulterado em vez de decifrar em lixo", () => {
    const cifrado = cifrar("token-original");
    const adulterado = Buffer.from(cifrado.ciphertext, "base64");
    adulterado[0] ^= 0xff;

    expect(() =>
      decifrar({ ...cifrado, ciphertext: adulterado.toString("base64") }),
    ).toThrow();
  });

  it("rejeita authTag adulterado", () => {
    const cifrado = cifrar("token-original");
    const tag = Buffer.from(cifrado.authTag, "base64");
    tag[0] ^= 0xff;

    expect(() =>
      decifrar({ ...cifrado, authTag: tag.toString("base64") }),
    ).toThrow();
  });

  it("o hint não vaza o segredo", () => {
    const segredo = "sk-super-secreto-abcd";
    expect(gerarHint(segredo)).toBe("••••abcd");
    expect(gerarHint(segredo)).not.toContain("super");
  });
});
