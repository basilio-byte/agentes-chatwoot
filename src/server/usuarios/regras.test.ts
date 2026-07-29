import { describe, expect, it } from "vitest";
import { podeAlterarPapel, podeAlternarAtivo, type Alvo } from "./regras";
import { UserRole } from "@/generated/prisma/enums";

const owner: Alvo = { id: "u1", role: UserRole.OWNER, active: true };
const admin: Alvo = { id: "u2", role: UserRole.ADMIN, active: true };
const eu = "eu";

describe("proteção contra ficar sem proprietário", () => {
  it("recusa rebaixar o último proprietário ativo", () => {
    const r = podeAlterarPapel(owner, UserRole.ADMIN, {
      meuId: eu,
      outrosOwnersAtivos: 0,
    });

    expect(r.permitido).toBe(false);
  });

  it("permite rebaixar quando existe outro proprietário", () => {
    const r = podeAlterarPapel(owner, UserRole.ADMIN, {
      meuId: eu,
      outrosOwnersAtivos: 1,
    });

    expect(r.permitido).toBe(true);
  });

  it("permite promover a proprietário sempre", () => {
    expect(
      podeAlterarPapel(admin, UserRole.OWNER, { meuId: eu, outrosOwnersAtivos: 0 })
        .permitido,
    ).toBe(true);
  });

  it("rebaixar quem já está inativo não tira proprietário ativo", () => {
    const inativo: Alvo = { ...owner, active: false };
    expect(
      podeAlterarPapel(inativo, UserRole.VIEWER, {
        meuId: eu,
        outrosOwnersAtivos: 0,
      }).permitido,
    ).toBe(true);
  });

  it("recusa desativar o último proprietário ativo", () => {
    expect(
      podeAlternarAtivo(owner, { meuId: eu, outrosOwnersAtivos: 0 }).permitido,
    ).toBe(false);
  });

  it("permite desativar um admin mesmo sem outro proprietário", () => {
    expect(
      podeAlternarAtivo(admin, { meuId: eu, outrosOwnersAtivos: 0 }).permitido,
    ).toBe(true);
  });

  it("reativar nunca é bloqueado pela regra do proprietário", () => {
    const inativo: Alvo = { ...owner, active: false };
    expect(
      podeAlternarAtivo(inativo, { meuId: eu, outrosOwnersAtivos: 0 }).permitido,
    ).toBe(true);
  });
});

describe("proteção contra se trancar do lado de fora", () => {
  it("ninguém desativa a própria conta", () => {
    const r = podeAlternarAtivo(
      { id: eu, role: UserRole.ADMIN, active: true },
      { meuId: eu, outrosOwnersAtivos: 5 },
    );

    expect(r.permitido).toBe(false);
    if (!r.permitido) expect(r.motivo).toContain("própria conta");
  });
});
