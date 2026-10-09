import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As ações da tela de notas fiscais: o que elas recusam e o que dizem a quem clicou.
 *
 * Banco, sessão e a reclassificação são simulados; o que se confere é a regra da ação —
 * a tela desatualizada que não pode religar a emissão, e a resposta de "Tentar de novo",
 * que não pode prometer "sai em até 5 minutos" a uma nota que não vai sair.
 */
const db = vi.hoisted(() => ({
  integration: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
  notaFiscalEmitida: { findUnique: vi.fn() },
  cobrancaFiscal: { findUnique: vi.fn() },
}));
const emitir = vi.hoisted(() => ({
  liberarNotaParaNovaTentativa: vi.fn(),
  repositorioReal: vi.fn(() => ({})),
}));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/server/auth-guard", () => ({ exigirPapel: vi.fn(async () => ({ user: { id: "u1", role: "ADMIN" } })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/notas-fiscais/conferir", () => ({
  reclassificar: vi.fn(async () => ({ mudadas: 0, apagadas: 0, preservadas: 0 })),
}));
vi.mock("@/server/notas-fiscais/emissao/emitir", () => emitir);
vi.mock("@/server/gatilho/token", () => ({ gerarToken: () => "token-novo" }));

import { reclassificar } from "@/server/notas-fiscais/conferir";
import { TELA_DESATUALIZADA, versaoDaConfig } from "@/server/notas-fiscais/versao";
import { salvarConfigNotasFiscais, tentarEmitirDeNovo } from "./notas-fiscais";

const formulario = (campos: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.set(k, v);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  db.integration.upsert.mockResolvedValue({});
  db.auditLog.create.mockResolvedValue({});
});

describe("salvar a configuração das notas fiscais", () => {
  /** O que o banco guarda: a emissão ligada, com o corte. */
  const gravada = { emissao: { ligada: true, aPartirDe: "2026-10-08" } };
  /** O que a tela manda ao salvar, com a versão do que ela viu. */
  const envio = (versao: string | undefined) =>
    formulario({
      enabled: "on",
      emissaoLigada: "on",
      aPartirDe: "2026-10-08",
      ...(versao === undefined ? {} : { versao }),
    });

  it("com a versão de agora, grava", async () => {
    db.integration.findUnique.mockResolvedValue({ config: gravada });
    const r = await salvarConfigNotasFiscais({}, envio(versaoDaConfig(gravada)));
    expect(r.erro).toBeUndefined();
    expect(r.ok).toMatch(/Emissão LIGADA/);
    expect(db.integration.upsert).toHaveBeenCalledTimes(1);
  });

  it("⚠ tela aberta ANTES de o sistema desligar a emissão sozinho: recusa, e a pausa continua à vista", async () => {
    // A tela abriu com a emissão ligada (versão da `gravada`); depois o sistema a desligou e anotou o motivo.
    const versaoQueATelaViu = versaoDaConfig(gravada);
    db.integration.findUnique.mockResolvedValue({
      config: { emissao: { ligada: false, aPartirDe: "2026-10-08", pausadaMotivo: "09/10/2026 — valor diferente do planejado" } },
    });
    const r = await salvarConfigNotasFiscais({}, envio(versaoQueATelaViu));
    expect(r).toEqual({ erro: TELA_DESATUALIZADA });
    expect(db.integration.upsert).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(reclassificar).not.toHaveBeenCalled();
  });

  it("⚠ tela aberta antes de outra pessoa mexer na lista de códigos em espera: recusa", async () => {
    const versaoQueATelaViu = versaoDaConfig({ emissao: { ligada: true, aPartirDe: "2026-10-08", codigosEmEspera: ["10.05.01"] } });
    db.integration.findUnique.mockResolvedValue({ config: gravada }); // alguém tirou o código da espera
    expect(await salvarConfigNotasFiscais({}, envio(versaoQueATelaViu))).toEqual({ erro: TELA_DESATUALIZADA });
    expect(db.integration.upsert).not.toHaveBeenCalled();
  });

  it("tela de antes desta regra, sem versão nenhuma: recusa e pede para recarregar", async () => {
    db.integration.findUnique.mockResolvedValue({ config: gravada });
    expect(await salvarConfigNotasFiscais({}, envio(undefined))).toEqual({ erro: TELA_DESATUALIZADA });
    expect(db.integration.upsert).not.toHaveBeenCalled();
  });

  it("primeira vez (nada gravado ainda): a versão do vazio é a mesma dos dois lados", async () => {
    db.integration.findUnique.mockResolvedValue(null);
    const r = await salvarConfigNotasFiscais({}, formulario({ enabled: "on", versao: versaoDaConfig(undefined) }));
    expect(r.erro).toBeUndefined();
    expect(db.integration.upsert).toHaveBeenCalledTimes(1);
  });

  it("⚠ avisa quantas cobranças com nota emitida foram deixadas como estavam", async () => {
    db.integration.findUnique.mockResolvedValue({ config: gravada });
    vi.mocked(reclassificar).mockResolvedValueOnce({ mudadas: 2, apagadas: 0, preservadas: 5 });
    const r = await salvarConfigNotasFiscais({}, envio(versaoDaConfig(gravada)));
    expect(r.ok).toMatch(/2 cobrança\(s\) já vista\(s\) refeita\(s\)/);
    expect(r.ok).toMatch(/5 cobrança\(s\) que já têm nota emitida foram deixadas como estavam/);
  });
});

describe("tentar de novo: o que a resposta diz", () => {
  const nota = { codigo: "10.05.01", empresa: "SEAHUB", cobrancaId: 30594 };
  const cobranca = { cobrancaId: 30594, empresaId: 3, situacao: "PRONTA", quitadaEm: "2026-10-09", cobranca: {} };
  const integracao = (emissao: Record<string, unknown>, enabled = true) => ({
    enabled,
    config: { emissao: { ligada: true, aPartirDe: "2026-10-08", ...emissao } },
  });

  beforeEach(() => {
    emitir.liberarNotaParaNovaTentativa.mockResolvedValue({ ok: true, situacaoAnterior: "REJEITADA" });
    db.notaFiscalEmitida.findUnique.mockResolvedValue(nota);
    db.cobrancaFiscal.findUnique.mockResolvedValue(cobranca);
    db.integration.findUnique.mockResolvedValue(integracao({}));
    process.env.SPEDY_KEY_SEAHUB = "chave-de-teste";
  });
  afterEach(() => {
    delete process.env.SPEDY_KEY_SEAHUB;
  });

  it("tudo em ordem: promete a próxima rodada, e só isso", async () => {
    const r = await tentarEmitirDeNovo("conexa-30594-100501");
    expect(r.ok).toBe("Liberada. A mesma nota é reenviada na próxima rodada (até 5 minutos), sem gastar outro número.");
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("⚠ emissão desligada: diz que NÃO vai sair, em vez de prometer 5 minutos", async () => {
    db.integration.findUnique.mockResolvedValue(integracao({ ligada: false }));
    const r = await tentarEmitirDeNovo("conexa-30594-100501");
    expect(r.ok).toMatch(/Liberada, mas NÃO vai sair agora: a emissão está desligada/);
    expect(r.ok).not.toMatch(/até 5 minutos\), sem gastar outro número\.$/);
  });

  it("código ainda em espera, sem a chave da Spedy e cobrança fora do corte: todas as causas, numa frase", async () => {
    db.integration.findUnique.mockResolvedValue(integracao({ codigosEmEspera: ["10.05.01"], aPartirDe: "2026-10-10" }));
    delete process.env.SPEDY_KEY_SEAHUB;
    const r = await tentarEmitirDeNovo("conexa-30594-100501");
    expect(r.ok).toContain("o código 10.05.01 está em espera");
    expect(r.ok).toContain("falta a chave da Spedy da empresa SEAHUB no servidor");
    expect(r.ok).toContain("é anterior ao corte com o n8n");
  });

  it("integração desligada na tela vale uma frase só", async () => {
    db.integration.findUnique.mockResolvedValue(integracao({ ligada: false }, false));
    const r = await tentarEmitirDeNovo("conexa-30594-100501");
    expect(r.ok).toContain("a integração de notas fiscais está desligada");
    expect(r.ok).not.toContain("a emissão está desligada");
  });

  it("nota que não pode ser liberada (autorizada, na fila): devolve o erro e não grava nada", async () => {
    emitir.liberarNotaParaNovaTentativa.mockResolvedValue({ ok: false, erro: 'Só nota rejeitada ou parada pode tentar de novo; esta está "autorizada".' });
    const r = await tentarEmitirDeNovo("conexa-30594-100501");
    expect(r).toEqual({ erro: expect.stringContaining('"autorizada"') });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("chave inválida: recusa antes de tocar no banco", async () => {
    expect(await tentarEmitirDeNovo("")).toEqual({ erro: "Nota inválida." });
    expect(await tentarEmitirDeNovo("x".repeat(101))).toEqual({ erro: "Nota inválida." });
    expect(emitir.liberarNotaParaNovaTentativa).not.toHaveBeenCalled();
  });
});
