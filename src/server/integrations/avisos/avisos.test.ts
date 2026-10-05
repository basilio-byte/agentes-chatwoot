import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider, RunSource } from "@/generated/prisma/enums";
import { assinaturaDoTexto } from "@/server/avisos/regras";
import type { ToolContext } from "../types";

/**
 * `avisar_equipe_whatsapp` de ponta a ponta, com banco e Chatwoot simulados.
 *
 * O que se trava aqui é o que tocaria o celular de alguém sem querer: número
 * fora do cadastro, teste do playground, e o mesmo recado repetido pela fila ou
 * pelo modelo.
 */

let chamadasAnteriores: { output: unknown }[] = [];
let envios: Array<{ caixaId: number; para: string[]; texto: string }> = [];
let semToken = false;
let falhaNoEnvio: string | null = null;

vi.mock("@/lib/db", () => ({
  db: {
    toolCall: { findMany: async () => chamadasAnteriores },
    agent: { findUnique: async () => ({ name: "Jardim — Padrão Ouro" }) },
  },
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteComTokenDeUsuario: async () => (semToken ? null : {}),
}));

vi.mock("@/server/alerta-de-saldo/conversa", () => ({
  entregarAviso: async (
    _cliente: unknown,
    caixaId: number,
    destinatarios: { nome: string }[],
    texto: string,
  ) => {
    envios.push({ caixaId, para: destinatarios.map((d) => d.nome), texto });
    return destinatarios.map((d) =>
      falhaNoEnvio
        ? { nome: d.nome, ok: false, detalhe: falhaNoEnvio, conversaId: null }
        : { nome: d.nome, ok: true, detalhe: "entregue ao Chatwoot", conversaId: 1 },
    );
  },
}));

const { avisosIntegration } = await import("./index");
const ferramenta = avisosIntegration.tools[0];

const CONFIG = {
  destinatarios: [
    { nome: "Maria do Socorro", telefone: "+5584999990001" },
    { nome: "Wellington", telefone: "+5584999990002" },
  ],
  caixaId: 31,
};

const TEXTO = "Jardim — semana até 05/10: NEGATIVO. 4 pontos em atenção. Detalhes: https://app.clickup.com/t/x";

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  provider: IntegrationProvider.AVISOS,
  config: CONFIG,
  credential: null,
  agentId: "jardim",
  source: RunSource.SCHEDULE,
  ...extra,
});

async function executar(entrada: Record<string, unknown>, c = ctx()) {
  const args = ferramenta.inputSchema.parse(entrada);
  return (await ferramenta.execute(args, c)) as Record<string, unknown>;
}

beforeEach(() => {
  chamadasAnteriores = [];
  envios = [];
  semToken = false;
  falhaNoEnvio = null;
});

describe("avisar_equipe_whatsapp", () => {
  it("manda pela caixa da configuração, com o carimbo do sistema", async () => {
    const r = await executar({ para: ["Socorro", "Wellington"], texto: TEXTO });

    expect(r.enviado).toBe(true);
    expect(envios).toHaveLength(1);
    expect(envios[0].caixaId).toBe(31);
    expect(envios[0].para).toEqual(["Maria do Socorro", "Wellington"]);
    expect(envios[0].texto).toBe(`🤖 Aviso automático · Jardim — Padrão Ouro\n${TEXTO}`);
    expect(r.assinatura).toBe(assinaturaDoTexto(TEXTO));
  });

  it("⚠ nome fora do cadastro recusa o envio INTEIRO", async () => {
    const r = await executar({ para: ["Wellington", "Fulano"], texto: TEXTO });

    expect(r.enviado).toBe(false);
    expect(r.naoEstaoNoCadastro).toEqual(["Fulano"]);
    expect(r.cadastrados).toEqual(["Maria do Socorro", "Wellington"]);
    expect(envios).toHaveLength(0);
  });

  it("⚠ no playground não sai nada — só mostra o que sairia", async () => {
    const r = await executar(
      { para: ["Wellington"], texto: TEXTO },
      ctx({ source: RunSource.PLAYGROUND }),
    );

    expect(r).toMatchObject({ enviado: false, simulado: true, para: ["Wellington"] });
    expect(envios).toHaveLength(0);
  });

  it("⚠ o mesmo recado não sai de novo para quem já recebeu", async () => {
    chamadasAnteriores = [
      {
        output: {
          assinatura: assinaturaDoTexto(TEXTO),
          entregas: [{ nome: "Wellington", ok: true }],
        },
      },
    ];

    const r = await executar({ para: ["Socorro", "Wellington"], texto: TEXTO });

    expect(envios[0].para).toEqual(["Maria do Socorro"]);
    expect(r.jaAvisadosAntes).toEqual(["Wellington"]);
  });

  it("todos já avisados: não chama o envio", async () => {
    chamadasAnteriores = [
      {
        output: {
          assinatura: assinaturaDoTexto(TEXTO),
          entregas: [
            { nome: "Wellington", ok: true },
            { nome: "Maria do Socorro", ok: true },
          ],
        },
      },
    ];

    const r = await executar({ para: ["Socorro", "Wellington"], texto: TEXTO });

    expect(r.enviado).toBe(false);
    expect(envios).toHaveLength(0);
  });

  it("ninguém cadastrado diz que falta configuração", async () => {
    const r = await executar(
      { para: ["Wellington"], texto: TEXTO },
      ctx({ config: { destinatarios: [] } }),
    );

    expect(r.enviado).toBe(false);
    expect(String(r.erro)).toMatch(/Ninguém está cadastrado/);
  });

  it("sem token de usuário do Chatwoot, não envia e diz por quê", async () => {
    semToken = true;

    const r = await executar({ para: ["Wellington"], texto: TEXTO });

    expect(r.enviado).toBe(false);
    expect(String(r.erro)).toMatch(/token de usuário/);
  });

  it("falha de envio volta sem o número de telefone", async () => {
    falhaNoEnvio = "phone +5584999990002 has already been taken";

    const r = await executar({ para: ["Wellington"], texto: TEXTO });

    expect(r.enviado).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/99999/);
  });

  it("é marcada como escrita", () => {
    expect(ferramenta.requiresConfirmation).toBe(true);
  });
});
