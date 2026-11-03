import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CARACTERES_POR_AGENTE } from "./regras";

const db = vi.hoisted(() => ({
  documentoDeConhecimento: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  documentoDoAgente: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  agent: { findMany: vi.fn(), findUnique: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(async (operacoes: unknown[]) => operacoes),
}));

vi.mock("@/lib/db", () => ({ db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./consulta", () => ({
  setoresGravados: vi.fn(async () => ["Comercial", null]),
}));

const {
  atualizarDocumento,
  criarDocumento,
  definirAgentesDoDocumento,
  definirDocumentosDoAgente,
  excluirDocumento,
} = await import("./servico");

const autor = { userId: "u1", nome: "Teste" };
const dados = {
  nome: "Playbook comercial",
  descricao: "",
  setor: "",
  texto: "conteúdo",
  origem: "",
};
const enorme = "a".repeat(MAX_CARACTERES_POR_AGENTE - 10);

beforeEach(() => {
  vi.clearAllMocks();
  db.documentoDeConhecimento.findUnique.mockResolvedValue(null);
  db.documentoDeConhecimento.create.mockResolvedValue({ id: "d1" });
  db.documentoDoAgente.findMany.mockResolvedValue([]);
  db.agent.findMany.mockResolvedValue([]);
});

describe("criarDocumento", () => {
  it("grava o texto com quebra \\n e a grafia do setor que já existe", async () => {
    const r = await criarDocumento(
      { ...dados, setor: " comercial ", texto: "linha 1\r\nlinha 2\r\n" },
      autor,
    );

    expect(r).toEqual({ ok: true, id: "d1" });
    expect(db.documentoDeConhecimento.create).toHaveBeenCalledWith({
      data: {
        nome: "Playbook comercial",
        descricao: null,
        setor: "Comercial",
        texto: "linha 1\nlinha 2",
        origem: null,
      },
      select: { id: true },
    });
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("recusa nome já usado, e não grava nada", async () => {
    db.documentoDeConhecimento.findUnique.mockResolvedValue({ id: "outro" });
    const r = await criarDocumento(dados, autor);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.camposComErro).toEqual({ nome: "Nome em uso" });
    expect(db.documentoDeConhecimento.create).not.toHaveBeenCalled();
  });

  it("recusa documento vazio antes de olhar o banco", async () => {
    const r = await criarDocumento({ ...dados, texto: "  \r\n " }, autor);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.camposComErro?.texto).toContain("vazio");
    expect(db.documentoDeConhecimento.findUnique).not.toHaveBeenCalled();
    expect(db.documentoDeConhecimento.create).not.toHaveBeenCalled();
  });
});

describe("atualizarDocumento", () => {
  beforeEach(() => {
    db.documentoDeConhecimento.findUnique.mockImplementation(
      async ({ where }: { where: { id?: string; nome?: string } }) =>
        where.id === "d1" ? { nome: "Playbook comercial", texto: "antigo" } : null,
    );
  });

  it("recusa o texto que faria um agente vinculado passar do teto — e diz qual", async () => {
    db.documentoDoAgente.findMany.mockResolvedValue([
      { agent: { name: "Vendedor EV", documentos: [{ documento: { texto: enorme } }] } },
    ]);

    const r = await atualizarDocumento("d1", { ...dados, texto: "b".repeat(100) }, autor);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toContain('"Vendedor EV"');
    expect(db.documentoDeConhecimento.update).not.toHaveBeenCalled();
  });

  it("grava quando todos os agentes vinculados continuam dentro do teto", async () => {
    db.documentoDoAgente.findMany.mockResolvedValue([
      { agent: { name: "Vendedor EV", documentos: [{ documento: { texto: "curto" } }] } },
    ]);

    const r = await atualizarDocumento("d1", { ...dados, texto: "novo texto" }, autor);

    expect(r).toEqual({ ok: true, id: "d1" });
    const { data } = db.documentoDeConhecimento.update.mock.calls[0][0];
    expect(data.texto).toBe("novo texto");
    // Editar o texto não apaga de onde o documento veio.
    expect(data).not.toHaveProperty("origem");
  });

  it("a auditoria guarda o texto de ANTES — não há outro histórico para recuperá-lo", async () => {
    await atualizarDocumento("d1", { ...dados, texto: "novo texto" }, autor);

    const { diff } = db.auditLog.create.mock.calls[0][0].data;
    expect(diff).toMatchObject({ mudouOTexto: true, textoAnterior: "antigo" });
  });

  it("sem mudar o texto, não repete o texto na auditoria", async () => {
    await atualizarDocumento("d1", { ...dados, texto: "antigo" }, autor);

    const { diff } = db.auditLog.create.mock.calls[0][0].data;
    expect(diff).toMatchObject({ mudouOTexto: false });
    expect(diff).not.toHaveProperty("textoAnterior");
  });

  it("documento que não existe devolve recusa, não exceção", async () => {
    const r = await atualizarDocumento("nao-existe", dados, autor);
    expect(r).toEqual({ ok: false, erro: "Documento não encontrado." });
  });
});

describe("excluirDocumento", () => {
  it("diz quantos agentes deixam de recebê-lo", async () => {
    db.documentoDeConhecimento.findUnique.mockResolvedValue({
      nome: "Playbook",
      texto: "o texto que vai embora",
      _count: { agentes: 3 },
    });

    const r = await excluirDocumento("d1", autor);

    expect(db.documentoDeConhecimento.delete).toHaveBeenCalledWith({ where: { id: "d1" } });
    // Apagar leva o texto junto: a auditoria é o único lugar onde ele sobra.
    expect(db.auditLog.create.mock.calls[0][0].data.diff).toMatchObject({
      texto: "o texto que vai embora",
    });
    expect(r).toEqual({
      ok: "Documento apagado. 3 agentes deixam de recebê-lo na próxima mensagem.",
    });
  });
});

describe("definirAgentesDoDocumento", () => {
  beforeEach(() => {
    db.documentoDeConhecimento.findUnique.mockResolvedValue({
      nome: "Playbook",
      texto: "conteúdo",
    });
  });

  it("só olha agentes NÃO arquivados, e só desfaz vínculo de quem também não é", async () => {
    db.agent.findMany.mockResolvedValue([
      { id: "a1", name: "Vendas", documentos: [] },
    ]);

    const r = await definirAgentesDoDocumento("d1", ["a1", "a1", ""], autor);

    expect(db.agent.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ["a1"] },
      archivedAt: null,
    });
    // O arquivado não aparece na tela: "substituir o conjunto" a partir dela não
    // pode apagar o vínculo de quem ela nunca mostrou.
    expect(db.documentoDoAgente.deleteMany).toHaveBeenCalledWith({
      where: { documentoId: "d1", agentId: { notIn: ["a1"] }, agent: { archivedAt: null } },
    });
    expect(db.documentoDoAgente.createMany).toHaveBeenCalledWith({
      data: [{ documentoId: "d1", agentId: "a1" }],
      skipDuplicates: true,
    });
    expect(r).toEqual({
      ok: "1 agente recebe este documento a partir da próxima mensagem.",
    });
  });

  it("recusa, sem gravar nada, se um agente passaria do teto", async () => {
    db.agent.findMany.mockResolvedValue([
      { id: "a1", name: "Vendas", documentos: [{ documento: { texto: enorme } }] },
    ]);
    db.documentoDeConhecimento.findUnique.mockResolvedValue({
      nome: "Playbook",
      texto: "b".repeat(100),
    });

    const r = await definirAgentesDoDocumento("d1", ["a1"], autor);

    expect("erro" in r && r.erro).toContain('"Vendas"');
    expect(db.documentoDoAgente.deleteMany).not.toHaveBeenCalled();
    expect(db.documentoDoAgente.createMany).not.toHaveBeenCalled();
  });

  it("lista vazia tira o documento de todos os agentes em circulação", async () => {
    const r = await definirAgentesDoDocumento("d1", [], autor);

    expect(db.documentoDoAgente.deleteMany).toHaveBeenCalledWith({
      where: { documentoId: "d1", agentId: { notIn: [] }, agent: { archivedAt: null } },
    });
    expect(r).toEqual({ ok: "Nenhum agente recebe este documento." });
  });
});

describe("definirDocumentosDoAgente", () => {
  it("agente arquivado não recebe documento", async () => {
    db.agent.findUnique.mockResolvedValue({ name: "Antigo", archivedAt: new Date() });

    const r = await definirDocumentosDoAgente("a1", ["d1"], autor);

    expect("erro" in r && r.erro).toContain("arquivado");
    expect(db.documentoDoAgente.createMany).not.toHaveBeenCalled();
  });

  it("recusa a soma que passa do teto", async () => {
    db.agent.findUnique.mockResolvedValue({ name: "Vendas", archivedAt: null });
    db.documentoDeConhecimento.findMany.mockResolvedValue([
      { id: "d1", nome: "A", texto: enorme },
      { id: "d2", nome: "B", texto: "b".repeat(100) },
    ]);

    const r = await definirDocumentosDoAgente("a1", ["d1", "d2"], autor);

    expect("erro" in r && r.erro).toContain("estouraria a janela do modelo");
    expect(db.documentoDoAgente.deleteMany).not.toHaveBeenCalled();
  });

  it("substitui o conjunto inteiro quando cabe", async () => {
    db.agent.findUnique.mockResolvedValue({ name: "Vendas", archivedAt: null });
    db.documentoDeConhecimento.findMany.mockResolvedValue([
      { id: "d1", nome: "A", texto: "curto" },
    ]);

    const r = await definirDocumentosDoAgente("a1", ["d1", "fantasma"], autor);

    expect(db.documentoDoAgente.deleteMany).toHaveBeenCalledWith({
      where: { agentId: "a1", documentoId: { notIn: ["d1"] } },
    });
    // Id que não existe é ignorado, em vez de virar vínculo para o nada.
    expect(db.documentoDoAgente.createMany).toHaveBeenCalledWith({
      data: [{ documentoId: "d1", agentId: "a1" }],
      skipDuplicates: true,
    });
    expect(r).toEqual({
      ok: "1 documento no prompt deste agente, a partir da próxima mensagem.",
    });
  });
});
