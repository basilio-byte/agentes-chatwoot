import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Cifra de credenciais de integração — AES-256-GCM.
 *
 * GCM (e não CBC) porque é autenticado: um ciphertext adulterado no banco falha
 * na verificação em vez de decifrar em lixo silencioso.
 */

const ALGORITMO = "aes-256-gcm";
const IV_BYTES = 12; // recomendação do NIST para GCM

function chave(): Buffer {
  const raw = Buffer.from(env().ENCRYPTION_KEY, "base64");
  if (raw.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY deve ter 32 bytes em base64 (tem ${raw.length}). Gere com: openssl rand -base64 32`,
    );
  }
  return raw;
}

export type SegredoCifrado = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

export function cifrar(textoPlano: string): SegredoCifrado & { hint: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITMO, chave(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(textoPlano, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    hint: gerarHint(textoPlano),
  };
}

export function decifrar(segredo: SegredoCifrado): string {
  const decipher = createDecipheriv(
    ALGORITMO,
    chave(),
    Buffer.from(segredo.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(segredo.authTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(segredo.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Máscara para conferência visual no painel — nunca o segredo inteiro. */
export function gerarHint(textoPlano: string): string {
  const fim = textoPlano.slice(-4);
  return `••••${fim}`;
}
