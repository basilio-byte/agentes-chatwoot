import { beforeEach, describe, expect, it, vi } from "vitest";
import { esquecerLeituraRemota, idadeDaLeitura } from "@/lib/leitura-remota";

/**
 * As leituras externas da tela de Integrações, com o mundo de fora simulado: o que
 * é pedido ao Chatwoot, à OpenAI e ao Conexa, quantas vezes, e o que a tela recebe
 * quando uma delas falha.
 */

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/crypto", () => ({ decifrar: () => "chave-de-teste" }));

let credencialDaOpenAI: object | null = { ciphertext: "x", iv: "y", authTag: "z" };
let idsDaConta: string[] = ["gpt-4o", "gpt-4o-mini-transcribe", "whisper-1"];
let erroDaConta: string | undefined;
let macrosDoServidor: Array<{ id: number; name: string }> = [];
let falhaNosMacros: Error | null = null;
let respostaDoConexa: { categorias: Array<{ id: number; nome: string; empresas: []; ativa: boolean }>; erro?: string } = {
  categorias: [],
};

const chamadas = { macros: [] as unknown[], modelos: [] as unknown[], categorias: [] as unknown[] };

vi.mock("@/lib/db", () => ({
  db: {
    integration: {
      findUnique: async () => ({ config: {}, credential: credencialDaOpenAI }),
    },
  },
}));

vi.mock("@/server/integrations/materiais", () => ({
  macrosDoChatwoot: async (opcoes: unknown) => {
    chamadas.macros.push(opcoes);
    if (falhaNosMacros) throw falhaNosMacros;
    return macrosDoServidor;
  },
}));

vi.mock("@/server/materiais/macros", () => ({
  // Só o que importa aqui: o prefixo é aplicado NA LEITURA, sobre os macros crus.
  materiaisDisponiveis: (macros: Array<{ name: string }>, prefixos: string[]) =>
    macros.filter((m) => prefixos.some((p) => m.name.startsWith(p))).map((m) => ({ nome: m.name, arquivos: [] })),
}));

vi.mock("@/server/integrations/openai/catalogo", async (importar) => {
  const real = await importar<typeof import("@/server/integrations/openai/catalogo")>();
  return {
    ...real,
    modelosDaConta: async (_config: unknown, _chave: string, opcoes: unknown) => {
      chamadas.modelos.push(opcoes);
      return erroDaConta ? { ids: [], erro: erroDaConta } : { ids: idsDaConta };
    },
  };
});

vi.mock("@/server/notas-fiscais/categorias", () => ({
  categoriasDoConexa: async (_agora: unknown, opcoes: unknown) => {
    chamadas.categorias.push(opcoes);
    return respostaDoConexa;
  },
}));

const {
  aquecerOPainel,
  catalogoOpenAIDoPainel,
  categoriasFiscaisDoPainel,
  materiaisDoPainel,
  organizarModelos,
} = await import("./leituras-remotas");

beforeEach(() => {
  esquecerLeituraRemota();
  credencialDaOpenAI = { ciphertext: "x", iv: "y", authTag: "z" };
  idsDaConta = ["gpt-4o", "gpt-4o-mini-transcribe", "whisper-1"];
  erroDaConta = undefined;
  macrosDoServidor = [
    { id: 1, name: "[SR] Sala 01" },
    { id: 2, name: "[X] Outra coisa" },
  ];
  falhaNosMacros = null;
  respostaDoConexa = { categorias: [{ id: 7, nome: "Serviços de Espaço", empresas: [], ativa: true }] };
  chamadas.macros = [];
  chamadas.modelos = [];
  chamadas.categorias = [];
});

describe("materiais da tela", () => {
  it("lê os macros UMA vez e aplica o prefixo na leitura, com o formato `{ lista, erro }` de sempre", async () => {
    const a = await materiaisDoPainel(["[SR]"]);
    expect(a).toEqual({ lista: [{ nome: "[SR] Sala 01", arquivos: [] }], erro: null });

    // Outro prefixo sobre os MESMOS macros: sem nova ida ao Chatwoot.
    const b = await materiaisDoPainel(["[X]"]);
    expect(b.lista.map((m) => m.nome)).toEqual(["[X] Outra coisa"]);
    expect(chamadas.macros).toHaveLength(1);
  });

  it("a leitura de renovação FURA o cache de 5 min do Chatwoot (`forcar`)", async () => {
    await materiaisDoPainel(["[SR]"]);
    expect(chamadas.macros[0]).toEqual({ forcar: true });
  });

  it("⚠ Chatwoot sem token ou fora do ar não derruba a tela: volta lista vazia com o motivo", async () => {
    falhaNosMacros = new Error("Sem o token de leitura do Chatwoot");
    expect(await materiaisDoPainel(["[SR]"])).toEqual({ lista: [], erro: "Sem o token de leitura do Chatwoot" });
    // E não guardou o fracasso: quando o token existir, a próxima leitura funciona.
    falhaNosMacros = null;
    expect((await materiaisDoPainel(["[SR]"])).erro).toBeNull();
  });
});

describe("modelos da OpenAI na tela", () => {
  it("guarda a LISTA da conta; renovar fura o cache de 1 h da OpenAI", async () => {
    const a = await catalogoOpenAIDoPainel();
    const b = await catalogoOpenAIDoPainel();
    expect(a).toEqual({ ids: idsDaConta });
    expect(b).toEqual(a);
    expect(chamadas.modelos).toEqual([{ forcar: true }]);
  });

  it("⚠ sem chave, ou lista vazia por erro, NÃO fica guardado: quando a chave existir, a tela já vê", async () => {
    credencialDaOpenAI = null;
    expect(await catalogoOpenAIDoPainel()).toEqual({
      ids: [],
      erro: "Salve a chave da OpenAI para ver a lista de modelos da conta.",
    });
    expect(idadeDaLeitura("openai:modelos")).toBeNull();

    credencialDaOpenAI = { ciphertext: "x", iv: "y", authTag: "z" };
    expect((await catalogoOpenAIDoPainel()).ids).toHaveLength(3);
  });

  it("⚠ erro da OpenAI (403/rede) não vira a verdade por 50 minutos", async () => {
    erroDaConta = "A OpenAI recusou a chave (401).";
    expect((await catalogoOpenAIDoPainel()).ids).toEqual([]);
    expect(idadeDaLeitura("openai:modelos")).toBeNull();
  });
});

describe("os seletores de modelo", () => {
  const gravados = { modeloAudio: "whisper-1", modeloVisao: "gpt-4o", modeloDocumento: "gpt-4o" };

  it("monta os grupos de cada campo e conta quantos modelos a conta tem", () => {
    const r = organizarModelos({ ids: ["gpt-4o", "gpt-4o-mini-transcribe", "whisper-1"] }, gravados);
    expect(r.total).toBe(3);
    expect(r.audio.flatMap((g) => g.ids)).toContain("whisper-1");
    expect(r.visao.flatMap((g) => g.ids)).toContain("gpt-4o");
    expect(r.erro).toBeUndefined();
  });

  it("⚠ o modelo GRAVADO sempre é opção, mesmo que a conta não o liste mais — senão o <select> troca o modelo de todo mundo em silêncio", () => {
    const r = organizarModelos(
      { ids: ["gpt-4o", "whisper-1"] },
      { modeloAudio: "modelo-que-sumiu", modeloVisao: "gpt-4o", modeloDocumento: "outro-que-sumiu" },
    );
    expect(r.audio[0]).toEqual({ rotulo: "Gravado (não aparece na conta agora)", ids: ["modelo-que-sumiu"] });
    expect(r.documento[0]).toEqual({ rotulo: "Gravado (não aparece na conta agora)", ids: ["outro-que-sumiu"] });
    // Cada campo garante o SEU valor: o de visão está na conta e não ganha grupo extra.
    expect(r.visao.some((g) => g.rotulo.startsWith("Gravado"))).toBe(false);
  });

  it("lista vazia: sem seletor, com o motivo — a tela cai para texto livre", () => {
    expect(organizarModelos({ ids: [], erro: "Chave ilegível — recadastre." }, gravados)).toEqual({
      audio: [],
      visao: [],
      documento: [],
      total: 0,
      erro: "Chave ilegível — recadastre.",
    });
  });
});

describe("categorias do Conexa na tela", () => {
  it("guarda a lista e renova furando o cache de 1 h do Conexa", async () => {
    const a = await categoriasFiscaisDoPainel();
    await categoriasFiscaisDoPainel();
    expect(a.categorias).toHaveLength(1);
    expect(chamadas.categorias).toHaveLength(1);
    expect(chamadas.categorias[0]).toEqual({ forcar: true });
  });

  it("⚠ leitura que falhou (lista de reserva COM erro) não vale como lida", async () => {
    respostaDoConexa = { categorias: [], erro: "o Conexa não respondeu a tempo" };
    expect((await categoriasFiscaisDoPainel()).erro).toBe("o Conexa não respondeu a tempo");
    expect(idadeDaLeitura("conexa:categorias")).toBeNull();

    respostaDoConexa = { categorias: [{ id: 7, nome: "Serviços", empresas: [], ativa: true }] };
    expect((await categoriasFiscaisDoPainel()).erro).toBeUndefined();
  });
});

describe("aquecimento", () => {
  it("deixa as TRÊS leituras quentes ao mesmo tempo, e a tela, depois, não faz nenhuma ida ao serviço", async () => {
    const tempos = await aquecerOPainel();
    expect(Object.keys(tempos)).toEqual(["macros do Chatwoot", "modelos da OpenAI", "categorias do Conexa"]);
    expect(chamadas.macros).toHaveLength(1);
    expect(chamadas.modelos).toHaveLength(1);
    expect(chamadas.categorias).toHaveLength(1);

    await materiaisDoPainel(["[SR]"]);
    await catalogoOpenAIDoPainel();
    await categoriasFiscaisDoPainel();
    expect(chamadas.macros).toHaveLength(1);
    expect(chamadas.modelos).toHaveLength(1);
    expect(chamadas.categorias).toHaveLength(1);
  });

  it("⚠ a falha de uma leitura não impede as outras, e o aquecimento nunca lança", async () => {
    falhaNosMacros = new Error("Chatwoot fora do ar");
    const tempos = await aquecerOPainel();
    expect(tempos["macros do Chatwoot"]).toContain("falhou");
    expect(tempos["modelos da OpenAI"]).not.toContain("falhou");
    expect(tempos["categorias do Conexa"]).not.toContain("falhou");
    expect(idadeDaLeitura("openai:modelos")).not.toBeNull();
  });
});
