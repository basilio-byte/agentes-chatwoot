import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As ações das lacunas: resolver e reabrir (a exclusão não existe mais — pedido
 * do Diego, 12/11/2026).
 *
 * Banco e sessão são simulados; o que se confere é a regra: comentário
 * obrigatório, quem e quando ficam gravados, a troca é condicionada à situação
 * (duas pessoas não se sobrescrevem) e a auditoria não repete o texto.
 */
const db = vi.hoisted(() => ({
  lacunaDoAgente: { findUnique: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));
const exigirPapel = vi.hoisted(() =>
  vi.fn(async () => ({ user: { id: "u-lucas", name: "Lucas", role: "ADMIN" } })),
);
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/server/auth-guard", () => ({ exigirPapel }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { SituacaoDaLacuna, UserRole } from "@/generated/prisma/enums";
import * as acoes from "./lacunas";

const { reabrirLacuna, resolverLacuna } = acoes;

const COMENTARIO = "Acrescentei ao prompt do Suporte o procedimento de segunda via; testei no playground.";

beforeEach(() => {
  vi.clearAllMocks();
  db.lacunaDoAgente.findUnique.mockResolvedValue({ agentId: "a1" });
  db.lacunaDoAgente.updateMany.mockResolvedValue({ count: 1 });
  db.auditLog.create.mockResolvedValue({});
});

describe("resolverLacuna", () => {
  it("grava a situação, quem resolveu, o momento e o comentário — só se ainda estiver aberta", async () => {
    const antes = Date.now();
    const r = await resolverLacuna("l1", `  ${COMENTARIO}  `);

    expect(r.erro).toBeUndefined();
    expect(r.ok).toMatch(/Histórico/);

    const { where, data } = db.lacunaDoAgente.updateMany.mock.calls[0][0];
    // A troca é condicionada a ABERTA: quem chega depois não sobrescreve.
    expect(where).toEqual({ id: "l1", situacao: SituacaoDaLacuna.ABERTA });
    expect(data).toMatchObject({
      situacao: SituacaoDaLacuna.RESOLVIDA,
      resolvidaPorId: "u-lucas",
      resolvidaPorNome: "Lucas",
      resolucao: COMENTARIO,
    });
    expect(data.resolvidaEm.getTime()).toBeGreaterThanOrEqual(antes);
  });

  it("exige Administrador", async () => {
    await resolverLacuna("l1", COMENTARIO);
    expect(exigirPapel).toHaveBeenCalledWith(UserRole.ADMIN);
  });

  it("⚠ sem comentário (ou só 'ok') NÃO resolve: o Histórico existe para dizer o que foi feito", async () => {
    for (const texto of ["", "   ", "ok", "feito.", undefined as unknown as string]) {
      const r = await resolverLacuna("l1", texto);
      expect(r.erro).toMatch(/o que foi feito/);
    }
    expect(db.lacunaDoAgente.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("comentário acima do teto é RECUSADO, não cortado em silêncio", async () => {
    const r = await resolverLacuna("l1", "a".repeat(1001));
    expect(r.erro).toMatch(/máximo é 1000/);
    expect(db.lacunaDoAgente.updateMany).not.toHaveBeenCalled();
  });

  it("outra pessoa resolveu antes: avisa e não audita um evento que não aconteceu", async () => {
    db.lacunaDoAgente.updateMany.mockResolvedValue({ count: 0 });

    const r = await resolverLacuna("l1", COMENTARIO);

    expect(r.erro).toMatch(/Outra pessoa já resolveu/);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("lacuna que não existe mais", async () => {
    db.lacunaDoAgente.findUnique.mockResolvedValue(null);

    const r = await resolverLacuna("sumiu", COMENTARIO);

    expect(r.erro).toMatch(/não existe mais/);
    expect(db.lacunaDoAgente.updateMany).not.toHaveBeenCalled();
  });

  it("a auditoria diz quem e de qual agente, mas não repete o texto do comentário", async () => {
    await resolverLacuna("l1", COMENTARIO);

    const { action, entityId, diff, userId } = db.auditLog.create.mock.calls[0][0].data;
    expect(action).toBe("lacuna.resolved");
    expect(entityId).toBe("l1");
    expect(userId).toBe("u-lucas");
    expect(diff).toEqual({ agentId: "a1" });
    expect(JSON.stringify(diff)).not.toContain("procedimento");
  });
});

describe("reabrirLacuna", () => {
  it("devolve para a fila e limpa a resolução — o comentário anterior vai para a auditoria", async () => {
    const resolvidaEm = new Date("2026-11-12T15:00:00Z");
    db.lacunaDoAgente.findUnique.mockResolvedValue({
      agentId: "a1",
      situacao: SituacaoDaLacuna.RESOLVIDA,
      resolvidaEm,
      resolvidaPorNome: "Lucas",
      resolucao: COMENTARIO,
    });

    const r = await reabrirLacuna("l1");

    expect(r.ok).toMatch(/voltou para a fila/);
    const { where, data } = db.lacunaDoAgente.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: "l1", situacao: SituacaoDaLacuna.RESOLVIDA });
    expect(data).toEqual({
      situacao: SituacaoDaLacuna.ABERTA,
      resolvidaEm: null,
      resolvidaPorId: null,
      resolvidaPorNome: null,
      resolucao: null,
    });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "lacuna.reopened",
      diff: {
        agentId: "a1",
        resolvidaPor: "Lucas",
        resolvidaEm: resolvidaEm.toISOString(),
        resolucaoAnterior: COMENTARIO,
      },
    });
  });

  it("já estava aberta: avisa, e não audita", async () => {
    db.lacunaDoAgente.findUnique.mockResolvedValue({
      agentId: "a1",
      situacao: SituacaoDaLacuna.ABERTA,
      resolvidaEm: null,
      resolvidaPorNome: null,
      resolucao: null,
    });
    db.lacunaDoAgente.updateMany.mockResolvedValue({ count: 0 });

    const r = await reabrirLacuna("l1");

    expect(r.erro).toMatch(/já voltou para a fila/);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("exige Administrador", async () => {
    db.lacunaDoAgente.findUnique.mockResolvedValue({
      agentId: "a1",
      situacao: SituacaoDaLacuna.RESOLVIDA,
      resolvidaEm: new Date(),
      resolvidaPorNome: "Lucas",
      resolucao: COMENTARIO,
    });
    await reabrirLacuna("l1");
    expect(exigirPapel).toHaveBeenCalledWith(UserRole.ADMIN);
  });
});

describe("a exclusão não existe mais", () => {
  it("⚠ não há ação de apagar lacuna: o que foi tratado fica no Histórico", () => {
    expect(Object.keys(acoes).sort()).toEqual(["reabrirLacuna", "resolverLacuna"]);
  });
});
