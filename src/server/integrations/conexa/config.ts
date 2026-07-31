import { z } from "zod";

/**
 * Config não-sensível do Conexa — vale para todos os agentes.
 *
 * Tem mais cadastro manual que as outras integrações porque a API do Conexa
 * **esconde ids que ela mesma exige**: não existe endpoint para listar salas,
 * nem usuários, nem a taxonomia do CRM. O que não dá para descobrir, o operador
 * cadastra uma vez aqui — mesmo princípio das listas nomeadas do ClickUp.
 */
export const conexaConfigSchema = z.object({
  /**
   * URL da API, com o subdomínio da instância.
   * Ex.: `https://seahub.conexa.app/index.php/api/v2`
   */
  baseUrl: z
    .string()
    .min(1, "Informe a URL da API do Conexa")
    .refine((v) => v.startsWith("http"), "A URL precisa começar com http"),

  /**
   * Unidades, por nome. A Seahub tem mais de uma, e `companyId` aparece em 38
   * pontos da API — deixá-lo implícito faria o agente vender para a unidade
   * errada sem ninguém perceber.
   */
  unidades: z
    .array(z.object({ nome: z.string().min(1), companyId: z.number().int().positive() }))
    .default([]),

  /**
   * Vendedor a quem as vendas da IA são atribuídas.
   *
   * Com API Token permanente não existe usuário logado, e a Conexa passa a
   * **exigir** `sellerId` em venda, contrato e venda recorrente. Como não há
   * endpoint que liste usuários, o id vem daqui.
   */
  sellerId: z.number().int().positive().optional(),

  /**
   * Salas, por nome. Não existe `GET /rooms` — só listagem de reservas. Sem
   * este cadastro, o agente não tem como descobrir o id de uma sala.
   */
  salas: z
    .array(z.object({ nome: z.string().min(1), roomId: z.number().int().positive() }))
    .default([]),

  /** Origem obrigatória ao registrar lead (`POST /potentialCustomer`). */
  crmPartnerId: z.number().int().positive().optional(),
  /** Status inicial do lead, quando a instância usa status. */
  crmStatusId: z.number().int().positive().optional(),
});

export type ConexaConfig = z.infer<typeof conexaConfigSchema>;

/**
 * Token permanente de API, criado por um administrador no Conexa.
 *
 * Vai como `Authorization: Bearer <token>`, o mesmo header do JWT de
 * `POST /auth` — confirmado com o node de produção do usuário em 31/07/2026.
 * Preferimos o token permanente justamente para não ter de renovar sessão
 * dentro de um atendimento.
 */
export const conexaSegredoSchema = z.object({
  apiToken: z.string().min(10, "Token muito curto"),
});

export type ConexaSegredo = z.infer<typeof conexaSegredoSchema>;

/** Acha a unidade pelo nome cadastrado, ou pelo id cru. */
export function resolverUnidade(
  termo: string | number | undefined,
  config: ConexaConfig,
): { companyId?: number; nomes: string[] } {
  const nomes = config.unidades.map((u) => u.nome);

  if (termo === undefined || termo === "") {
    // Uma unidade só cadastrada não precisa ser escolhida a cada chamada.
    return { companyId: config.unidades[0]?.companyId, nomes };
  }

  if (typeof termo === "number") return { companyId: termo, nomes };

  const cru = Number(termo);
  if (Number.isInteger(cru) && cru > 0) return { companyId: cru, nomes };

  const alvo = termo.trim().toLowerCase();
  const achada = config.unidades.find((u) => u.nome.trim().toLowerCase() === alvo);
  return { companyId: achada?.companyId, nomes };
}

/** Acha a sala pelo nome cadastrado, ou pelo id cru. */
export function resolverSala(
  termo: string | number | undefined,
  config: ConexaConfig,
): { roomId?: number; nomes: string[] } {
  const nomes = config.salas.map((s) => s.nome);

  if (termo === undefined || termo === "") return { nomes };
  if (typeof termo === "number") return { roomId: termo, nomes };

  const cru = Number(termo);
  if (Number.isInteger(cru) && cru > 0) return { roomId: cru, nomes };

  const alvo = termo.trim().toLowerCase();
  const achada = config.salas.find((s) => s.nome.trim().toLowerCase() === alvo);
  return { roomId: achada?.roomId, nomes };
}
