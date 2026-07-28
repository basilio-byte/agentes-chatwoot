import pino from "pino";

/**
 * Lê `process.env` direto em vez de `env()`: o logger é usado por módulos que o
 * `next build` avalia sem variáveis de ambiente, e um nível de log errado não é
 * motivo para derrubar o build. A validação estrita fica para quem precisa de
 * segredo (banco, cifra, OpenRouter).
 */
const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Em produção o Easypanel coleta stdout — JSON puro é o formato certo.
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }
    : {}),
  // Nunca logar segredo, nem por acidente.
  redact: {
    paths: [
      "*.password",
      "*.passwordHash",
      "*.apiKey",
      "*.api_access_token",
      "*.authorization",
      "*.ciphertext",
      "*.access_token",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[redacted]",
  },
});
