import { describe, expect, it } from "vitest";
import type { MacroChatwoot } from "@/server/integrations/chatwoot/client";
import {
  arquivosDoMacro,
  escolherMaterial,
  lerPrefixos,
  liberado,
  limitarPassos,
  materiaisDisponiveis,
  passosDoMacro,
  PREFIXOS_PADRAO,
  textoComVariavel,
} from "./macros";

const BASE = "https://chatwoot.test/rails/active_storage/blobs/redirect";
const arquivo = (blob_id: number, filename: string) => ({
  blob_id,
  filename,
  file_type: "image/png",
  file_url: `${BASE}/${blob_id}/${encodeURIComponent(filename)}`,
});

/** No formato de `GET /macros`, com os nomes reais da conta. */
const sala01: MacroChatwoot = {
  id: 18,
  name: "[SR] Seaway Reunião 01/8P",
  visibility: "global",
  actions: [
    { action_name: "send_attachment", action_params: [31112] },
    { action_name: "send_attachment", action_params: [31115] },
  ],
  // ⚠ Como na conta real: a foto antiga continua em `files`.
  files: [
    arquivo(192, "Sala de Reunião 01 (2).jpg"),
    arquivo(31112, "Sala de Reunião 01 — Capa.png"),
    arquivo(31115, "Sala de Reunião 01 — Fotos.png"),
  ],
};
const sala02: MacroChatwoot = {
  id: 19,
  name: "[SR] Seaway Reunião 02/6P",
  visibility: "global",
  actions: [{ action_name: "send_attachment", action_params: [31124] }],
  files: [arquivo(31124, "Sala de Reunião 02 — Capa.png")],
};
const atendimento02: MacroChatwoot = {
  id: 25,
  name: "[SA] Seaway Atendimento 02/3P",
  visibility: "global",
  actions: [{ action_name: "send_attachment", action_params: [44268] }],
  files: [arquivo(44268, "Sala de Atendimento 02 — Capa.png")],
};
const passagem: MacroChatwoot = {
  id: 91,
  name: "[C] Passagem para Lucas",
  visibility: "global",
  actions: [
    { action_name: "assign_agent", action_params: [28] },
    { action_name: "send_message", action_params: ["estou passando o seu contato"] },
  ],
};
const pessoal: MacroChatwoot = { ...sala02, id: 500, name: "[SR] minha foto", visibility: "personal" };
const semAnexo: MacroChatwoot = {
  id: 73,
  name: "[SR] Texto sem imagem",
  visibility: "global",
  actions: [{ action_name: "send_message", action_params: ["oi"] }],
};

describe("arquivosDoMacro", () => {
  it("manda o que as AÇÕES mandam hoje, na ordem — não a foto antiga que ficou em files", () => {
    expect(arquivosDoMacro(sala01).map((a) => a.nome)).toEqual([
      "Sala de Reunião 01 — Capa.png",
      "Sala de Reunião 01 — Fotos.png",
    ]);
  });

  it("macro sem anexo não tem arquivo", () => {
    expect(arquivosDoMacro(passagem)).toEqual([]);
  });
});

describe("materiaisDisponiveis", () => {
  const todos = [sala01, sala02, atendimento02, passagem, pessoal, semAnexo];

  it("só macros globais, com prefixo liberado e com imagem", () => {
    expect(materiaisDisponiveis(todos, ["[SR]"]).map((m) => m.nome)).toEqual([
      "[SR] Seaway Reunião 01/8P",
      "[SR] Seaway Reunião 02/6P",
    ]);
  });

  it("nenhum prefixo, nenhum material", () => {
    expect(materiaisDisponiveis(todos, [])).toEqual([]);
  });

  it("o prefixo casa sem acento nem caixa", () => {
    expect(liberado("[sa] Seaway Atendimento 02/3P", ["[SA]"])).toBe(true);
    expect(liberado("[C] Passagem", ["[SA]"])).toBe(false);
  });

  it("⚠ exclusão vence: a promoção vencida sai do padrão sem tirar as salas", () => {
    expect(liberado("[SA] Promoção de Pacotes de Horas — Maio.25", PREFIXOS_PADRAO)).toBe(false);
    expect(liberado("[SA] Seaway Atendimento 02/3P", PREFIXOS_PADRAO)).toBe(true);
  });
});

describe("escolherMaterial — palavra inteira", () => {
  const auditorio = (id: number, formato: string): MacroChatwoot => ({
    id,
    name: `[A] Auditório Seaway — ${formato}`,
    visibility: "global",
    actions: [{ action_name: "send_attachment", action_params: [id] }],
    files: [arquivo(id, `${formato}.png`)],
  });
  const materiais = materiaisDisponiveis(
    [
      sala01,
      sala02,
      auditorio(1, "Formato Sala de Aula"),
      auditorio(2, "Formato U"),
      auditorio(3, "Formato Somente Cadeiras"),
    ],
    PREFIXOS_PADRAO,
  );

  it("⚠ \"formato U\" acha o U — por trecho, o u de \"Auditório\" casava com todos", () => {
    const e = escolherMaterial("auditório seaway formato U", materiais);
    expect(e).toMatchObject({ tipo: "achado", material: { id: 2 } });
  });

  it("palavras vazias do pedido não atrapalham: \"fotos da sala de reunião 02\"", () => {
    const e = escolherMaterial("fotos da sala de reunião 02", materiais);
    expect(e).toMatchObject({ tipo: "achado", material: { id: 19 } });
  });

  it("começo de palavra longa casa: \"reuni 01\"", () => {
    expect(escolherMaterial("reuni 01", materiais)).toMatchObject({ material: { id: 18 } });
  });
});

describe("escolherMaterial", () => {
  const materiais = materiaisDisponiveis([sala01, sala02, atendimento02], PREFIXOS_PADRAO);

  it("o nome exato ganha", () => {
    const e = escolherMaterial("[SR] Seaway Reunião 02/6P", materiais);
    expect(e).toMatchObject({ tipo: "achado", material: { id: 19 } });
  });

  it("todas as palavras do pedido, sem acento: acha a única sala", () => {
    const e = escolherMaterial("reuniao 02 seaway", materiais);
    expect(e).toMatchObject({ tipo: "achado", material: { id: 19 } });
  });

  it("⚠ mais de uma sala não vira palpite", () => {
    const e = escolherMaterial("seaway reunião", materiais);
    expect(e).toEqual({
      tipo: "ambiguo",
      candidatos: ["[SR] Seaway Reunião 01/8P", "[SR] Seaway Reunião 02/6P"],
    });
  });

  it("nada parecido devolve o que existe", () => {
    const e = escolherMaterial("auditório", materiais);
    expect(e).toMatchObject({ tipo: "nenhum" });
    expect(e.tipo === "nenhum" && e.disponiveis).toHaveLength(3);
  });
});

describe("lerPrefixos", () => {
  it("sem configuração, vale o padrão das salas", () => {
    expect(lerPrefixos(undefined)).toEqual(PREFIXOS_PADRAO);
  });

  it("aceita lista ou texto com um por linha ou vírgula", () => {
    expect(lerPrefixos(["[SR]", " [SA] ", ""])).toEqual(["[SR]", "[SA]"]);
    expect(lerPrefixos("[SR]\n[CA], [A]")).toEqual(["[SR]", "[CA]", "[A]"]);
  });

  it("lista vazia gravada é vazia — desligar tudo é escolha de quem configura", () => {
    expect(lerPrefixos([])).toEqual([]);
  });
});

describe("os passos do macro (texto e imagem, na ordem)", () => {
  const macro = (acoes: MacroChatwoot["actions"]): MacroChatwoot => ({
    id: 1,
    name: "[SR] Catálogo (Preços)",
    visibility: "global",
    actions: acoes,
    files: [
      { blob_id: 7, file_url: "https://c/7.png", file_type: "image/png", filename: "a.png" },
      { blob_id: 8, file_url: "https://c/8.png", file_type: "image/png", filename: "b.png" },
    ],
  });

  it("segue a ordem das ações: o texto antes da imagem, como a equipe monta", () => {
    const passos = passosDoMacro(
      macro([
        { action_name: "send_message", action_params: ["  Seguem os valores  "] },
        { action_name: "send_attachment", action_params: [7] },
      ]),
    );
    expect(passos.map((p) => p.tipo)).toEqual(["texto", "arquivo"]);
    expect(passos[0]).toEqual({ tipo: "texto", texto: "Seguem os valores" });
  });

  it("⚠ atribuir, etiquetar e mudar status NÃO são passos: o macro não é executado", () => {
    const passos = passosDoMacro(
      macro([
        { action_name: "assign_agent", action_params: [28] },
        { action_name: "add_label", action_params: ["x"] },
        { action_name: "send_attachment", action_params: [7] },
      ]),
    );
    expect(passos).toHaveLength(1);
    expect(passos[0].tipo).toBe("arquivo");
  });

  it("texto vazio e arquivo repetido ou desconhecido ficam de fora", () => {
    const passos = passosDoMacro(
      macro([
        { action_name: "send_message", action_params: ["   "] },
        { action_name: "send_attachment", action_params: [7] },
        { action_name: "send_attachment", action_params: [7, 999] },
      ]),
    );
    expect(passos).toHaveLength(1);
  });

  it("reconhece variável do Chatwoot no texto", () => {
    expect(textoComVariavel("Olá {{ contact.name }}")).toBe(true);
    expect(textoComVariavel("Pacote de 10h: R$49")).toBe(false);
  });

  it("respeita os tetos sem trocar a ordem", () => {
    const muitos = Array.from({ length: 9 }, (_, i) => ({
      tipo: "arquivo" as const,
      arquivo: { blobId: i + 1, nome: `${i}.png`, tipo: "image/png", url: "u" },
    }));
    const limitados = limitarPassos([{ tipo: "texto", texto: "oi" }, ...muitos]);
    expect(limitados.filter((p) => p.tipo === "arquivo")).toHaveLength(6);
    expect(limitados[0].tipo).toBe("texto");
  });
});
