import { describe, expect, it } from "vitest";
import { assinar, verificarAssinatura } from "./assinatura";

const SECRET = "segredo-do-webhook-do-bot";
const CORPO = JSON.stringify({ event: "message_created", id: 42 });
const AGORA = 1_780_000_000;
const TS = String(AGORA);

function assinatura(corpo = CORPO, secret = SECRET, ts = TS) {
  return assinar(secret, ts, corpo);
}

describe("verificação da assinatura do webhook", () => {
  it("aceita entrega legítima", () => {
    expect(
      verificarAssinatura({
        corpoCru: CORPO,
        assinatura: assinatura(),
        timestamp: TS,
        secret: SECRET,
        agoraEmSegundos: AGORA,
      }),
    ).toEqual({ ok: true });
  });

  it("recusa corpo adulterado", () => {
    const adulterado = JSON.stringify({ event: "message_created", id: 99 });

    const r = verificarAssinatura({
      corpoCru: adulterado,
      assinatura: assinatura(), // assinada com o corpo original
      timestamp: TS,
      secret: SECRET,
      agoraEmSegundos: AGORA,
    });

    expect(r).toEqual({ ok: false, motivo: "assinatura não confere" });
  });

  it("recusa assinatura feita com outro secret", () => {
    const r = verificarAssinatura({
      corpoCru: CORPO,
      assinatura: assinatura(CORPO, "secret-de-outro-bot"),
      timestamp: TS,
      secret: SECRET,
      agoraEmSegundos: AGORA,
    });

    expect(r.ok).toBe(false);
  });

  it("recusa replay fora da janela de tolerância", () => {
    const r = verificarAssinatura({
      corpoCru: CORPO,
      assinatura: assinatura(),
      timestamp: TS,
      secret: SECRET,
      agoraEmSegundos: AGORA + 600, // 10 min depois
    });

    expect(r).toEqual({
      ok: false,
      motivo: "timestamp fora da janela de tolerância",
    });
  });

  it("aceita pequena diferença de relógio", () => {
    expect(
      verificarAssinatura({
        corpoCru: CORPO,
        assinatura: assinatura(),
        timestamp: TS,
        secret: SECRET,
        agoraEmSegundos: AGORA + 120,
      }).ok,
    ).toBe(true);
  });

  it("recusa timestamp muito à frente do relógio", () => {
    expect(
      verificarAssinatura({
        corpoCru: CORPO,
        assinatura: assinatura(),
        timestamp: TS,
        secret: SECRET,
        agoraEmSegundos: AGORA - 600,
      }).ok,
    ).toBe(false);
  });

  it("recusa quando falta cabeçalho", () => {
    expect(
      verificarAssinatura({
        corpoCru: CORPO,
        assinatura: null,
        timestamp: TS,
        secret: SECRET,
        agoraEmSegundos: AGORA,
      }),
    ).toEqual({ ok: false, motivo: "sem X-Chatwoot-Signature" });

    expect(
      verificarAssinatura({
        corpoCru: CORPO,
        assinatura: assinatura(),
        timestamp: null,
        secret: SECRET,
        agoraEmSegundos: AGORA,
      }),
    ).toEqual({ ok: false, motivo: "sem X-Chatwoot-Timestamp" });
  });

  it("recusa quando o secret não foi configurado", () => {
    expect(
      verificarAssinatura({
        corpoCru: CORPO,
        assinatura: assinatura(),
        timestamp: TS,
        secret: "",
        agoraEmSegundos: AGORA,
      }),
    ).toEqual({ ok: false, motivo: "secret do webhook não configurado" });
  });

  it("não estoura com assinatura de tamanho diferente", () => {
    // timingSafeEqual lança se os buffers têm tamanhos distintos — o guard de
    // length tem de vir antes.
    expect(() =>
      verificarAssinatura({
        corpoCru: CORPO,
        assinatura: "sha256=curta",
        timestamp: TS,
        secret: SECRET,
        agoraEmSegundos: AGORA,
      }),
    ).not.toThrow();
  });

  it("assina no formato documentado pelo Chatwoot", () => {
    // sha256=HMAC-SHA256(secret, "{timestamp}.{corpo}")
    expect(assinatura()).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
