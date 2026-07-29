import { UserRole } from "@/generated/prisma/enums";

export type Alvo = {
  id: string;
  role: UserRole;
  active: boolean;
};

export type Contexto = {
  /** Quem está executando a ação. */
  meuId: string;
  /** Proprietários ativos **além** do alvo. */
  outrosOwnersAtivos: number;
};

export type Veredito = { permitido: true } | { permitido: false; motivo: string };

const SEM_OWNER =
  "Este é o último proprietário ativo. Promova outra pessoa antes.";

/**
 * Regras que impedem o painel de ficar sem ninguém capaz de administrá-lo.
 *
 * Puras de propósito: é a parte em que um engano tranca todo mundo do lado de
 * fora, então merece teste sem banco.
 */
export function podeAlterarPapel(
  alvo: Alvo,
  novoPapel: UserRole,
  ctx: Contexto,
): Veredito {
  const perdeUmOwner =
    alvo.role === UserRole.OWNER &&
    alvo.active &&
    novoPapel !== UserRole.OWNER;

  if (perdeUmOwner && ctx.outrosOwnersAtivos === 0) {
    return { permitido: false, motivo: SEM_OWNER };
  }
  return { permitido: true };
}

export function podeAlternarAtivo(alvo: Alvo, ctx: Contexto): Veredito {
  if (alvo.id === ctx.meuId) {
    return {
      permitido: false,
      motivo: "Você não pode desativar a própria conta.",
    };
  }

  const vaiDesativar = alvo.active;
  if (
    vaiDesativar &&
    alvo.role === UserRole.OWNER &&
    ctx.outrosOwnersAtivos === 0
  ) {
    return { permitido: false, motivo: SEM_OWNER };
  }

  return { permitido: true };
}
