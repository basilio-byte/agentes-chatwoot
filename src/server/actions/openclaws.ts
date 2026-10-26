"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { UserRole } from "@/generated/prisma/enums";
import { exigirPapel } from "@/server/auth-guard";
import { lerConteineres } from "@/server/openclaws/config";
import { novoTokenDoColetor } from "@/server/openclaws/token";

// ⚠ Arquivo "use server": só função assíncrona e tipo podem ser exportados
// (ver `use-server.test.ts`). Os tetos abaixo ficam sem `export` por isso.
const MAX_DO_NOME = 60;
const MAX_DA_COTA_USD = 100_000;

export type EstadoConfigOpenClaws = { ok?: string; erro?: string };
export type EstadoTokenDoColetor = {
  ok?: string;
  erro?: string;
  /** Texto puro do token recém-gerado. Só existe nesta resposta. */
  token?: string;
};

/**
 * Nomes, conta compartilhada, cota e horário do reset. **Só Proprietário**: a
 * tela mostra o consumo POR PESSOA, e quem a edita define quem aparece como quê.
 *
 * ⚠ A lista de contêineres não cresce por aqui: quem encontra um OpenClaw novo é
 * o coletor. O formulário só edita os que já existem — um id inventado no
 * console do navegador não vira linha na tela.
 */
export async function salvarConfigOpenClaws(
  _estado: EstadoConfigOpenClaws,
  formData: FormData,
): Promise<EstadoConfigOpenClaws> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const ids = formData.getAll("id").map(String);
  const nomes = formData.getAll("nome").map(String);
  const compartilhadas = new Set(formData.getAll("compartilhada").map(String));
  if (ids.length !== nomes.length) {
    return { erro: "O formulário veio incompleto. Recarregue a página e tente de novo." };
  }

  const submetidos = new Map<string, { nome: string | null; compartilhada: boolean }>();
  for (const [i, id] of ids.entries()) {
    const nome = nomes[i].trim();
    if (nome.length > MAX_DO_NOME) {
      return { erro: `O nome do OpenClaw ${id} passa de ${MAX_DO_NOME} caracteres.` };
    }
    submetidos.set(id, { nome: nome || null, compartilhada: compartilhadas.has(id) });
  }

  const cotaBruta = String(formData.get("cotaManual") ?? "").trim().replace(",", ".");
  let cotaSemanalUsd: number | null = null;
  if (cotaBruta !== "") {
    const n = Number(cotaBruta);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_DA_COTA_USD) {
      return {
        erro: `A cota precisa ser um número maior que zero, até US$ ${MAX_DA_COTA_USD}. Deixe em branco para usar a estimada pelos bloqueios.`,
      };
    }
    cotaSemanalUsd = n;
  }

  const dia = Number(formData.get("resetDia"));
  const hora = Number(formData.get("resetHora"));
  if (!Number.isInteger(dia) || dia < 0 || dia > 6) {
    return { erro: "Escolha o dia da semana em que a cota recomeça." };
  }
  if (!Number.isInteger(hora) || hora < 0 || hora > 23) {
    return { erro: "A hora do reset vai de 0 a 23 (UTC)." };
  }

  const atual = await db.openClawConfig.findUnique({
    where: { id: "unico" },
    select: { conteineres: true },
  });
  const conteineres = lerConteineres(atual?.conteineres).map((c) => {
    const novo = submetidos.get(c.id);
    return novo ? { ...c, ...novo } : c;
  });

  await db.openClawConfig.upsert({
    where: { id: "unico" },
    update: {
      conteineres,
      cotaSemanalUsd,
      resetDiaSemana: dia,
      resetHoraUtc: hora,
      atualizadoPorId: sessao.user.id,
    },
    create: {
      id: "unico",
      conteineres,
      cotaSemanalUsd,
      resetDiaSemana: dia,
      resetHoraUtc: hora,
      atualizadoPorId: sessao.user.id,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "openclaws.config.updated",
      entity: "OpenClawConfig",
      entityId: "unico",
      // Os nomes ficam: dizem quem foi cadastrado como quê. Não há telefone aqui.
      diff: {
        conteineres: conteineres.map((c) => ({
          id: c.id,
          nome: c.nome,
          compartilhada: c.compartilhada,
        })),
        cotaSemanalUsd,
        reset: { dia, hora },
      },
    },
  });

  revalidatePath("/openclaws");
  return { ok: "Salvo." };
}

/**
 * Gera o token do coletor e o devolve em texto puro — a única vez.
 *
 * ⚠ Gerar outro **derruba o coletor que usa o anterior**, no próximo envio. É o
 * que se quer ao rotacionar, e a tela avisa antes.
 */
export async function gerarTokenDoColetor(): Promise<EstadoTokenDoColetor> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const { token, hash, dica } = novoTokenDoColetor();
  await db.openClawConfig.upsert({
    where: { id: "unico" },
    update: { tokenHash: hash, tokenDica: dica, atualizadoPorId: sessao.user.id },
    create: { id: "unico", tokenHash: hash, tokenDica: dica, atualizadoPorId: sessao.user.id },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "openclaws.coletor.token.generated",
      entity: "OpenClawConfig",
      entityId: "unico",
    },
  });

  revalidatePath("/openclaws");
  return {
    ok: "Token gerado. Copie agora — ele não aparece de novo. O coletor que usava o anterior para de enviar até receber este.",
    token,
  };
}
