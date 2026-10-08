import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import type { CobrancaDoAviso } from "./conferir";
import type { RodadaDeEmissao } from "./emissao/emitir";
import {
  avisoDizQueFoiPaga,
  esquecerAvisosRecentes,
  hashDoToken,
  idDaCobrancaNoAviso,
  processarAviso,
  tokenDoAvisoConfere,
  type DependenciasDoAviso,
} from "./aviso";

describe("o endereço do aviso", () => {
  it("só o hash é guardado, e só o token certo confere", () => {
    const hash = hashDoToken("segredo-123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("segredo");
    expect(tokenDoAvisoConfere("segredo-123", hash)).toBe(true);
    expect(tokenDoAvisoConfere("segredo-124", hash)).toBe(false);
    expect(tokenDoAvisoConfere("", hash)).toBe(false);
  });

  it("⚠ sem hash guardado nada confere (endereço ainda não gerado)", () => {
    expect(tokenDoAvisoConfere("qualquer", null)).toBe(false);
    expect(tokenDoAvisoConfere("qualquer", undefined)).toBe(false);
    expect(tokenDoAvisoConfere("qualquer", "não é hash")).toBe(false);
  });
});

describe("o que se aproveita do corpo do aviso", () => {
  it("só o número da cobrança, de chargeId (ou id)", () => {
    expect(idDaCobrancaNoAviso({ chargeId: 31035, amount: 1 })).toBe(31035);
    expect(idDaCobrancaNoAviso({ id: "31035" })).toBe(31035);
    expect(idDaCobrancaNoAviso({ chargeId: "abc" })).toBeNull();
    expect(idDaCobrancaNoAviso({ chargeId: -3 })).toBeNull();
    expect(idDaCobrancaNoAviso({ chargeId: 1.5 })).toBeNull();
    expect(idDaCobrancaNoAviso(null)).toBeNull();
    expect(idDaCobrancaNoAviso("texto")).toBeNull();
  });

  it("sabe se o aviso diz que a cobrança foi paga", () => {
    expect(avisoDizQueFoiPaga({ status: "paid" })).toBe(true);
    expect(avisoDizQueFoiPaga({ paymentDate: "2026-10-08" })).toBe(true);
    expect(avisoDizQueFoiPaga({ status: "unpaid" })).toBe(false);
    expect(avisoDizQueFoiPaga(null)).toBe(false);
  });
});

describe("processar o aviso", () => {
  let relogio = 1_000_000;
  const rodada = (extra: Partial<RodadaDeEmissao> = {}): RodadaDeEmissao => ({ acao: "emitido", ...extra });

  function montar(extra: Partial<DependenciasDoAviso> = {}) {
    const dep = {
      conferir: vi.fn<DependenciasDoAviso["conferir"]>(async () => ({
        acao: "gravada",
        detalhe: "evento quitada",
        situacao: "PRONTA",
      })),
      emitir: vi.fn<DependenciasDoAviso["emitir"]>(async () => rodada({ enviadas: 1 })),
      notasDaCobranca: vi.fn<DependenciasDoAviso["notasDaCobranca"]>(async () => [{ situacao: "AUTORIZADA", numero: 2704 }]),
      pausar: vi.fn(async () => {}),
      agora: () => relogio,
      ...extra,
    };
    return dep;
  }

  beforeEach(() => {
    esquecerAvisosRecentes();
    relogio += 10 * 60_000;
  });

  it("⚠ cobrança paga: registra, emite NA HORA e conta a nota", async () => {
    const dep = montar();
    const r = await processarAviso(31035, { dependencias: dep });
    expect(r.resultado).toBe("emitida");
    expect(r.detalhe).toMatch(/autorizada nº 2704/);
    expect(dep.conferir).toHaveBeenCalledWith(31035);
    expect(dep.emitir).toHaveBeenCalledTimes(1);
  });

  it("⚠ o mesmo aviso reenviado em menos de 1 minuto não lê nem emite de novo", async () => {
    const dep = montar();
    await processarAviso(31035, { dependencias: dep });
    const r = await processarAviso(31035, { dependencias: dep });
    expect(r.resultado).toBe("ignorado");
    expect(dep.conferir).toHaveBeenCalledTimes(1);
    expect(dep.emitir).toHaveBeenCalledTimes(1);

    relogio += 61_000;
    const depois = await processarAviso(31035, { dependencias: dep });
    expect(depois.resultado).toBe("emitida");
  });

  it("cobrança já registrada pela rodada de 30 min também dispara a emissão", async () => {
    const dep = montar({ conferir: vi.fn(async () => ({ acao: "ja vista", detalhe: "já registrada" }) as CobrancaDoAviso) });
    const r = await processarAviso(31035, { dependencias: dep });
    expect(r.resultado).toBe("emitida");
    expect(dep.emitir).toHaveBeenCalled();
  });

  it("⚠ o aviso chegou antes de a API mostrar o pagamento: espera, olha de novo e emite", async () => {
    const conferir = vi
      .fn<DependenciasDoAviso["conferir"]>()
      .mockResolvedValueOnce({ acao: "ignorada", detalhe: 'a cobrança está "unpaid" no Conexa', naoPaga: true })
      .mockResolvedValueOnce({ acao: "gravada", detalhe: "evento quitada", situacao: "PRONTA" });
    const dep = montar({ conferir });
    const r = await processarAviso(31035, { esperavaPaga: true, dependencias: dep });
    expect(conferir).toHaveBeenCalledTimes(2);
    expect(dep.pausar).toHaveBeenCalledWith(15_000);
    expect(r.resultado).toBe("emitida");
  });

  it("desiste depois de esperar: a conferência de 30 min cuida, e nada é emitido", async () => {
    const conferir = vi.fn<DependenciasDoAviso["conferir"]>(async () => ({
      acao: "ignorada",
      detalhe: 'a cobrança está "unpaid" no Conexa',
      naoPaga: true,
    }));
    const dep = montar({ conferir });
    const r = await processarAviso(31035, { esperavaPaga: true, dependencias: dep });
    expect(conferir).toHaveBeenCalledTimes(3);
    expect(r.resultado).toBe("ignorado");
    expect(dep.emitir).not.toHaveBeenCalled();
  });

  it("aviso de cobrança que não é paga não insiste", async () => {
    const conferir = vi.fn<DependenciasDoAviso["conferir"]>(async () => ({
      acao: "ignorada",
      detalhe: 'a cobrança está "unpaid" no Conexa',
      naoPaga: true,
    }));
    const dep = montar({ conferir });
    const r = await processarAviso(31036, { esperavaPaga: false, dependencias: dep });
    expect(conferir).toHaveBeenCalledTimes(1);
    expect(r.resultado).toBe("ignorado");
    expect(dep.pausar).not.toHaveBeenCalled();
  });

  it("cobrança que ficou 'conferir' ou 'fora' é registrada e NÃO dispara emissão", async () => {
    const dep = montar({
      conferir: vi.fn(async () => ({ acao: "gravada", detalhe: "item sem código", situacao: "CONFERIR" }) as CobrancaDoAviso),
    });
    const r = await processarAviso(31037, { dependencias: dep });
    expect(r.resultado).toBe("registrada");
    expect(r.detalhe).toMatch(/CONFERIR/);
    expect(dep.emitir).not.toHaveBeenCalled();
  });

  it("emissão já em andamento: espera e tenta de novo, sem perder a nota", async () => {
    const emitir = vi
      .fn<DependenciasDoAviso["emitir"]>()
      .mockResolvedValueOnce(rodada({ acao: "em andamento" }))
      .mockResolvedValueOnce(rodada({ enviadas: 1 }));
    const dep = montar({ emitir });
    const r = await processarAviso(31038, { dependencias: dep });
    expect(emitir).toHaveBeenCalledTimes(2);
    expect(dep.pausar).toHaveBeenCalledWith(5_000);
    expect(r.resultado).toBe("emitida");
  });

  it("emissão desligada ou pausada: diz por que a nota não saiu", async () => {
    const dep = montar({
      emitir: vi.fn(async () => rodada({ pausada: "nas primeiras notas: cobrança 9 rejeitada" })),
      notasDaCobranca: vi.fn(async () => []),
    });
    const r = await processarAviso(31039, { dependencias: dep });
    expect(r.resultado).toBe("registrada");
    expect(r.detalhe).toMatch(/emissão desligada: nas primeiras notas/);
  });

  it("⚠ erro inesperado vira 'falhou' e NÃO trava o aviso seguinte do mesmo número", async () => {
    const dep = montar({
      conferir: vi.fn<DependenciasDoAviso["conferir"]>().mockRejectedValueOnce(new Error("Conexa fora do ar")),
    });
    const r = await processarAviso(31040, { dependencias: dep });
    expect(r.resultado).toBe("falhou");
    const outra = await processarAviso(31040, { dependencias: montar() });
    expect(outra.resultado).toBe("emitida");
  });
});
