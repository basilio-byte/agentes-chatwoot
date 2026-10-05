import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { lerConfigOpenAI } from "@/server/integrations/openai/config";
import type { ToolContext } from "../types";

/**
 * `clickup_ler_fotos_da_tarefa` de ponta a ponta, com o `fetch` simulado.
 *
 * O que estes testes travam é o que falharia sem erro nenhum: o toggle da
 * leitura de imagem sendo furado, o token do ClickUp indo para onde não deve, e
 * a instrução da vistoria vazando para o cache (ou vice-versa).
 */

type Capacidade = {
  ligada: boolean;
  motivo?: string;
  apiKey?: string;
  config: ReturnType<typeof lerConfigOpenAI>;
};

let capacidade: Capacidade;
let leituras: Array<Record<string, unknown>>;
let downloads: Array<{ url: string; token: string | null }>;
/** Status que o servidor de anexo responde SEM token. */
let statusSemToken = 200;

vi.mock("@/server/integrations/openai/credenciais", () => ({
  capacidadeDeMidia: async () => capacidade,
}));

vi.mock("@/server/integrations/openai/upload", () => ({
  lerArquivoEnviado: async (entrada: Record<string, unknown>) => {
    leituras.push(entrada);
    return {
      chave: entrada.chaveDoCache,
      kind: "IMAGE",
      status: "OK",
      nome: entrada.nome,
      texto: `descrição de ${entrada.nome}`,
      motivo: null,
      model: "m-visao",
    };
  },
}));

const { clickupIntegration } = await import("./index");

const ferramenta = clickupIntegration.tools.find(
  (t) => t.name === "clickup_ler_fotos_da_tarefa",
)!;

const HOST_ANEXO = "https://t1.p.clickup-attachments.com";
const AGORA = Date.now();

function anexos() {
  return [
    {
      id: "a1",
      title: "WhatsApp Image 1.jpeg",
      extension: "jpeg",
      size: 10,
      date: String(AGORA - 3_600_000),
      url: `${HOST_ANEXO}/t1/a1/foto1.jpeg`,
      user: { id: 9, username: "Ana" },
    },
    {
      id: "a2",
      title: "image.png",
      extension: "png",
      size: 20,
      date: String(AGORA - 1_800_000),
      url: `${HOST_ANEXO}/t1/a2/image.png`,
    },
    {
      id: "fora",
      title: "antiga.jpeg",
      extension: "jpeg",
      size: 30,
      date: String(AGORA - 30 * 86_400_000),
      url: `${HOST_ANEXO}/t1/fora/antiga.jpeg`,
    },
  ];
}

let anexosDaTarefa: unknown[];

beforeEach(() => {
  capacidade = {
    ligada: true,
    apiKey: "sk-teste",
    config: lerConfigOpenAI({}),
  };
  leituras = [];
  downloads = [];
  statusSemToken = 200;
  anexosDaTarefa = anexos();

  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const texto = String(url);
    const headers = (init.headers ?? {}) as Record<string, string>;

    if (texto.startsWith(HOST_ANEXO)) {
      const token = headers.Authorization ?? null;
      downloads.push({ url: texto, token });
      if (!token && statusSemToken !== 200) {
        return new Response("negado", { status: statusSemToken });
      }
      return new Response(Buffer.from("bytes-da-foto"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }

    const rota = texto.replace("https://api.clickup.com/api/v2", "");
    const corpo = rota.endsWith("/comment")
      ? {
          comments: [
            {
              id: "c1",
              comment_text: "WhatsApp Image 1.jpeg\npoldar\n",
              date: String(AGORA - 3_600_000 + 20_000),
              user: { id: 9, username: "Ana" },
            },
          ],
        }
      : {
          id: "t1",
          name: "Manutenção Jardim (fotos semanais)",
          url: "https://app.clickup.com/t/t1",
          attachments: anexosDaTarefa,
        };
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ctx: ToolContext = {
  agentId: "agente-jardim",
  credential: "pk_token_secreto",
  config: { teamId: "team-1" },
} as unknown as ToolContext;

async function executar(entrada: Record<string, unknown> = {}) {
  const args = ferramenta.inputSchema.parse({
    tarefaId: "t1",
    foco: "Canteiros: sem mato, sem folhas secas.",
    ...entrada,
  });
  return (await ferramenta.execute(args, ctx)) as Record<string, unknown>;
}

describe("clickup_ler_fotos_da_tarefa", () => {
  it("lê as fotos do período, em ordem, com a anotação de quem publicou", async () => {
    const r = await executar();

    expect(r.lidas).toBe(2);
    const fotos = r.fotos as Array<Record<string, unknown>>;
    expect(fotos.map((f) => f.arquivo)).toEqual(["WhatsApp Image 1.jpeg", "image.png"]);
    expect(fotos[0]).toMatchObject({
      lida: true,
      enviadaPor: "Ana",
      anotacao: "poldar",
      descricao: "descrição de WhatsApp Image 1.jpeg",
    });
    expect(fotos[0].enviadaEm).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    // A foto de 30 dias atrás não foi baixada nem lida.
    expect(downloads.some((d) => d.url.includes("/fora/"))).toBe(false);
  });

  it("⚠ a visão recebe a instrução da vistoria, e o cache leva a instrução na chave", async () => {
    await executar();

    expect(leituras).toHaveLength(2);
    for (const leitura of leituras) {
      expect(String(leitura.instrucaoImagem)).toContain("Canteiros: sem mato, sem folhas secas.");
      expect(String(leitura.chaveDoCache)).toMatch(/^clickup:a[12]:[0-9a-f]{16}$/);
      expect(leitura.agentId).toBe("agente-jardim");
    }
  });

  it("⚠ o download vai SEM o token quando o servidor não pede", async () => {
    await executar();

    expect(downloads).toHaveLength(2);
    expect(downloads.every((d) => d.token === null)).toBe(true);
  });

  it("o token só vai na segunda tentativa, depois de uma recusa", async () => {
    statusSemToken = 403;

    const r = await executar();

    expect(r.lidas).toBe(2);
    expect(downloads.filter((d) => d.token === "pk_token_secreto")).toHaveLength(2);
  });

  it("⚠ anexo fora dos servidores do ClickUp não é baixado", async () => {
    anexosDaTarefa = [
      {
        id: "x",
        title: "foto.jpeg",
        extension: "jpeg",
        size: 1,
        date: String(AGORA - 1000),
        url: "https://exemplo.com/foto.jpeg",
      },
    ];

    const r = await executar();

    expect(downloads).toHaveLength(0);
    expect(leituras).toHaveLength(0);
    expect(r.lido).toBe(false);
    const fotos = r.fotos as Array<Record<string, unknown>>;
    expect(String(fotos[0].erro)).toMatch(/não consegui baixar/);
  });

  it("⚠ leitura de imagem desligada não baixa nem cobra nada", async () => {
    capacidade.config = { ...capacidade.config, lerImagem: false };

    const r = await executar();

    expect(r.lido).toBe(false);
    expect(String(r.erro)).toMatch(/leitura de imagem está desligada/);
    expect(downloads).toHaveLength(0);
    expect(leituras).toHaveLength(0);
  });

  it("leitura de mídia desligada para o agente diz o que falta", async () => {
    capacidade = {
      ligada: false,
      motivo: "leitura de mídia desligada para o agente",
      config: capacidade.config,
    };

    const r = await executar();

    expect(r.lido).toBe(false);
    expect(String(r.erro)).toMatch(/desligada para o agente/);
    expect(downloads).toHaveLength(0);
  });

  it("sem foto no período, diz que não há o que avaliar", async () => {
    const r = await executar({ ultimosDias: 1 });
    // As duas fotos são de menos de 1 h; com 1 dia elas entram.
    expect(r.lidas).toBe(2);

    anexosDaTarefa = [];
    const vazio = await executar();
    expect(vazio.fotos).toEqual([]);
    expect(String(vazio.aviso)).toMatch(/Nenhuma foto/);
  });

  it("não é marcada como escrita: só lê", () => {
    expect(ferramenta.requiresConfirmation).toBeFalsy();
    expect(clickupIntegration.provider).toBe(IntegrationProvider.CLICKUP);
  });
});
