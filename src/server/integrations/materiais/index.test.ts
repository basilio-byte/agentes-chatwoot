import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider, RunSource } from "@/generated/prisma/enums";
import type { MacroChatwoot } from "../chatwoot/client";
import type { SinaisDoTurno, ToolContext } from "../types";

/**
 * A ferramenta de ponta a ponta, com o Chatwoot simulado: o que ela manda, por
 * qual token, e quando se recusa a mandar.
 */

const BASE = "https://chatwoot.test";
const url = (blob: number) => `${BASE}/rails/active_storage/blobs/redirect/x/${blob}.png`;

let macros: MacroChatwoot[] = [];
let aoVivo: { status: string; assigneeId: number | null; assigneeTipo: string | null } = {
  status: "open",
  assigneeId: null,
  assigneeTipo: null,
};
let enviados: Array<{ conversa: number; nome: string; tipo: string; tamanho: number }> = [];
let falharEnvioNumero: number | null = null;
let semLeitura = false;

vi.mock("../chatwoot/credenciais", () => {
  const cliente = {
    baseUrl: BASE,
    contaId: 1,
    listarMacros: async () => macros,
    obterConversa: async () => aoVivo,
    enviarArquivo: async (conversa: number, a: { nome: string; tipo: string; bytes: Buffer }) => {
      if (falharEnvioNumero === enviados.length + 1) throw new Error("Chatwoot respondeu 500");
      enviados.push({ conversa, nome: a.nome, tipo: a.tipo, tamanho: a.bytes.length });
      return { id: 900 + enviados.length };
    },
  };
  return {
    clienteDeLeitura: async () => (semLeitura ? null : { cliente, config: {} }),
    clienteDoAgente: async () => cliente,
  };
});

vi.mock("../openai/client", async (original) => ({
  ...(await original<typeof import("../openai/client")>()),
  baixarArquivo: async () => ({
    bytes: Buffer.from("png"),
    mimeType: "image/png",
    tamanhoBytes: 3,
  }),
}));

const { materiaisIntegration, esquecerMacros } = await import("./index");
const ferramenta = materiaisIntegration.tools[0];

const sala02: MacroChatwoot = {
  id: 19,
  name: "[SR] Seaway Reunião 02/6P",
  visibility: "global",
  actions: [
    { action_name: "send_attachment", action_params: [31124] },
    { action_name: "send_attachment", action_params: [31123] },
  ],
  files: [
    { blob_id: 31124, file_url: url(31124), file_type: "image/png", filename: "Sala de Reunião 02 — Capa.png" },
    { blob_id: 31123, file_url: url(31123), file_type: "image/png", filename: "Sala de Reunião 02 — Fotos.png" },
  ],
};
const passagem: MacroChatwoot = {
  id: 91,
  name: "[C] Passagem para Lucas",
  visibility: "global",
  actions: [{ action_name: "assign_agent", action_params: [28] }],
};

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  provider: IntegrationProvider.MATERIAIS,
  config: {},
  credential: null,
  agentId: "salas",
  source: RunSource.CHATWOOT,
  chatwootConversationId: 14149,
  sinais: {},
  ...extra,
});

const enviar = (material: string | undefined, c: ToolContext = ctx()) =>
  ferramenta.execute(material === undefined ? {} : { material }, c) as Promise<Record<string, unknown>>;

beforeEach(() => {
  esquecerMacros();
  macros = [sala02, passagem];
  aoVivo = { status: "open", assigneeId: null, assigneeTipo: null };
  enviados = [];
  falharEnvioNumero = null;
  semLeitura = false;
});

describe("materiais_enviar", () => {
  it("sem material, lista o que existe — e só o que é material", async () => {
    const r = await enviar(undefined);
    expect(r).toEqual({ materiais: [{ material: "[SR] Seaway Reunião 02/6P", imagens: 2 }] });
    expect(enviados).toEqual([]);
  });

  it("manda as imagens do macro, na ordem, pelo robô — e marca que o cliente recebeu", async () => {
    const sinais: SinaisDoTurno = {};
    const r = await enviar("reunião 02", ctx({ sinais }));

    expect(r.enviado).toBe(true);
    expect(enviados.map((e) => [e.conversa, e.nome])).toEqual([
      [14149, "Sala de Reunião 02 — Capa.png"],
      [14149, "Sala de Reunião 02 — Fotos.png"],
    ]);
    expect(sinais.avisouCliente).toBe(true);
    expect(sinais.materiaisEnviados).toEqual([19]);
  });

  it("o mesmo material não sai duas vezes no mesmo turno", async () => {
    const c = ctx();
    await enviar("reunião 02", c);
    const r = await enviar("[SR] Seaway Reunião 02/6P", c);

    expect(r.jaEnviado).toBe(true);
    expect(enviados).toHaveLength(2);
  });

  it("⚠ conversa com uma pessoa: o robô não manda nem imagem", async () => {
    aoVivo = { status: "open", assigneeId: 12, assigneeTipo: "User" };

    const r = await enviar("reunião 02");

    expect(r.enviado).toBe(false);
    expect(enviados).toEqual([]);
  });

  it("conversa resolvida também não", async () => {
    aoVivo = { status: "resolved", assigneeId: null, assigneeTipo: null };
    expect((await enviar("reunião 02")).enviado).toBe(false);
    expect(enviados).toEqual([]);
  });

  it("no playground só simula, e diz o que iria", async () => {
    const r = await enviar("reunião 02", ctx({ source: RunSource.PLAYGROUND, chatwootConversationId: undefined }));
    expect(r).toMatchObject({ enviado: false, simulacao: true, arquivos: ["Sala de Reunião 02 — Capa.png", "Sala de Reunião 02 — Fotos.png"] });
    expect(enviados).toEqual([]);
  });

  it("fora de uma conversa (gatilho, mesa) não manda", async () => {
    const r = await enviar("reunião 02", ctx({ source: RunSource.TRIGGER, chatwootConversationId: undefined }));
    expect(r.enviado).toBe(false);
    expect(enviados).toEqual([]);
  });

  it("macro que não é material não sai, e a recusa devolve a lista", async () => {
    const r = await enviar("Passagem para Lucas");
    expect(r.enviado).toBe(false);
    expect(r.materiais).toEqual([{ material: "[SR] Seaway Reunião 02/6P", imagens: 2 }]);
    expect(enviados).toEqual([]);
  });

  it("arquivo fora da instância do Chatwoot não é baixado nem mandado", async () => {
    macros = [
      {
        ...sala02,
        files: sala02.files!.map((f) => ({ ...f, file_url: "https://outro.host/x.png" })),
      },
    ];
    const r = await enviar("reunião 02");
    expect(r.enviado).toBe(false);
    expect(enviados).toEqual([]);
  });

  it("falha no meio: diz o que chegou e proíbe repetir", async () => {
    falharEnvioNumero = 2;
    const r = await enviar("reunião 02");
    expect(r).toMatchObject({ enviado: true, enviados: ["Sala de Reunião 02 — Capa.png"] });
    expect(String(r.comoSeguir)).toContain("Não chame de novo");
  });

  it("prefixos vazios na configuração: nada liberado, sem tocar no Chatwoot", async () => {
    const r = await enviar("reunião 02", ctx({ config: { prefixos: [] } }));
    expect(String(r.erro)).toContain("Nenhum material está liberado");
    expect(enviados).toEqual([]);
  });

  it("sem o token de leitura, explica em vez de fingir que não há material", async () => {
    semLeitura = true;
    const r = await enviar(undefined);
    expect(String(r.erro)).toContain("token de leitura");
  });
});
