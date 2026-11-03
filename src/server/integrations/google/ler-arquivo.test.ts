import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaKind, MediaStatus } from "@/generated/prisma/enums";
import { lerConfigOpenAI } from "@/server/integrations/openai/config";

/**
 * `google_drive_ler_arquivo` é o único caminho em que a leitura de documento
 * não serve ao atendimento: o texto volta como retorno de ferramenta, numa
 * rodada só. Estes testes travam a LIGAÇÃO — teto de saída, teto de caracteres,
 * chave de cache e o aviso de corte —, que é o que nenhum teste do módulo de
 * mídia enxerga.
 *
 * Achado em 02/11/2026: com o teto do atendimento (900 tokens), a conta de
 * energia saía cortada antes do número do medidor, `lido: true`, e 7 de 8 contas
 * foram para `Conferir`.
 */

type ChamadaDeLeitura = {
  maxTokens?: number | null;
  tetoDeCaracteres?: number | null;
  chaveDoCache?: string | null;
  nome: string;
};

let leituras: ChamadaDeLeitura[];
/** O que a leitura devolve a seguir. */
let resposta: { texto: string | null; cortado: boolean };

vi.mock("./client", async () => {
  const real = await vi.importActual<typeof import("./client")>("./client");
  class GoogleClientFalso {
    async listarArquivos() {
      return {
        files: [
          {
            id: "arq1",
            name: "ENERGIA_loja21_setembro26.pdf",
            mimeType: "application/pdf",
            webViewLink: "https://drive.google.com/file/d/arq1/view",
          },
        ],
      };
    }
    async baixarArquivo() {
      return { bytes: Buffer.from("%PDF"), mimeType: "application/pdf" };
    }
  }
  return { ...real, GoogleClient: GoogleClientFalso };
});

vi.mock("@/server/integrations/openai/credenciais", () => ({
  capacidadeDeMidia: async () => ({
    ligada: true,
    apiKey: "chave-de-teste",
    motivo: null,
    config: lerConfigOpenAI({}),
  }),
}));

vi.mock("@/server/integrations/openai/upload", () => ({
  lerArquivoEnviado: async (entrada: ChamadaDeLeitura) => {
    leituras.push(entrada);
    return {
      chave: entrada.chaveDoCache ?? null,
      kind: MediaKind.DOCUMENT,
      status: MediaStatus.OK,
      nome: entrada.nome,
      texto: resposta.texto,
      motivo: resposta.texto == null ? "não consegui ler" : null,
      model: "m-doc",
      cortado: resposta.cortado,
    };
  },
}));

const { googleIntegration } = await import("./index");

const ferramenta = googleIntegration.tools.find(
  (t) => t.name === "google_drive_ler_arquivo",
)!;

const ctx = {
  provider: "GOOGLE",
  agentId: "agente-1",
  config: { pastas: [{ nome: "Contas Cosern", id: "pasta-entrada" }] },
  credential: JSON.stringify({
    type: "service_account",
    project_id: "p",
    private_key_id: "k",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    client_email: "bot@p.iam.gserviceaccount.com",
  }),
} as never;

async function ler() {
  return (await ferramenta.execute(
    { pasta: "Contas Cosern", nome: "ENERGIA_loja21" },
    ctx,
  )) as Record<string, unknown>;
}

beforeEach(() => {
  leituras = [];
  resposta = { texto: "conta inteira, com medidor 2171155463", cortado: false };
});

describe("google_drive_ler_arquivo", () => {
  it("lê com o teto de leitura completa, e não com o do atendimento", async () => {
    await ler();

    expect(leituras).toHaveLength(1);
    expect(leituras[0].maxTokens).toBe(4000);
    expect(leituras[0].tetoDeCaracteres).toBe(12_000);
  });

  it("⚠ a chave de cache leva o teto — a leitura cortada de antes não volta", async () => {
    await ler();

    // `drive:<id>` puro era a chave da leitura cortada pelos 900 tokens, que
    // ficou guardada como OK (definitivo). Reusá-la devolveria o texto sem
    // medidor para sempre, por mais que o teto tenha subido.
    expect(leituras[0].chaveDoCache).toBe("drive:arq1:t4000");
    expect(leituras[0].chaveDoCache).not.toBe("drive:arq1");
  });

  it("leitura inteira volta sem aviso nenhum", async () => {
    const r = await ler();

    expect(r.lido).toBe(true);
    expect(r.texto).toBe("conta inteira, com medidor 2171155463");
    expect(r).not.toHaveProperty("cortado");
    expect(r).not.toHaveProperty("aviso");
  });

  it("⚠ leitura cortada diz que o texto está incompleto, sem esconder o que veio", async () => {
    resposta = { texto: "ITENS DA FATURA … G2Comp.oUC-Ma-NP-TE", cortado: true };

    const r = await ler();

    expect(r.lido).toBe(true);
    expect(r.cortado).toBe(true);
    expect(String(r.aviso)).toContain("INCOMPLETO");
    // O aviso proíbe concluir que o dado não existe; não manda fazer nada com a
    // conta — o que fazer é do prompt do agente.
    expect(String(r.aviso)).toContain("não conclua");
    expect(r.texto).toBe("ITENS DA FATURA … G2Comp.oUC-Ma-NP-TE");
  });

  it("leitura que falhou continua devolvendo o erro", async () => {
    resposta = { texto: null, cortado: false };

    const r = await ler();

    expect(r.lido).toBe(false);
    expect(r.erro).toBe("não consegui ler");
  });
});
