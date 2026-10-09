import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O lado do BANCO da emissão. Os testes de `emitir.test.ts` usam um repositório
 * em memória, e é por isso que dois defeitos de produção passaram por eles: a
 * contagem de notas autorizadas e a leitura das cobranças prontas. Aqui o `db` é
 * de mentira, mas o que se confere é a CONSULTA que o código manda.
 */
const db = vi.hoisted(() => ({
  notaFiscalEmitida: { count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  cobrancaFiscal: { findMany: vi.fn() },
  webhookEvent: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db }));

import { lerConfigNotasFiscais } from "../config";
import {
  cobrancasRetidas,
  dependenciasReais,
  MARCA_DO_N8N,
  PROVIDER_SEM_NOTA,
  prontasDoBanco,
  repositorioReal,
} from "./emitir";

const AGORA = new Date("2026-10-09T15:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("contar as notas nossas autorizadas", () => {
  it("⚠ é o total MENOS as do n8n — sem `NOT startsWith`, que em SQL descarta a nota de motivo nulo", async () => {
    // Produção em 09/10/2026: 37 autorizadas, 4 marcadas do n8n, 33 nossas (todas de motivo NULO).
    db.notaFiscalEmitida.count.mockImplementation(async ({ where }: { where: { motivo?: unknown } }) =>
      where.motivo ? 4 : 37,
    );
    expect(await repositorioReal().contarAutorizadas()).toBe(33);

    const consultas = db.notaFiscalEmitida.count.mock.calls.map((c) => c[0].where);
    expect(consultas).toEqual([
      { situacao: "AUTORIZADA" },
      { situacao: "AUTORIZADA", motivo: { startsWith: MARCA_DO_N8N } },
    ]);
    // O defeito: qualquer NOT sobre o motivo volta a zerar a contagem e a prender o sistema na cautela.
    expect(JSON.stringify(consultas)).not.toContain("NOT");
  });
});

describe("guardar as cobranças pagas que não geraram nota", () => {
  const item = (n: number) => ({
    chave: `retida:${n}:10.05.01`,
    cobrancaId: n,
    empresa: "SEAHUB",
    valorCentavos: 10000,
    tipo: "retida" as const,
    detalhe: "o código 10.05.01 está em espera",
  });

  it("guarda só as que ainda não estão guardadas", async () => {
    db.webhookEvent.findMany.mockResolvedValue([{ externalId: "retida:1:10.05.01" }]);
    await repositorioReal().registrarSemNota([item(1), item(2)]);
    expect(db.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(db.webhookEvent.create.mock.calls[0][0].data).toMatchObject({
      provider: PROVIDER_SEM_NOTA,
      externalId: "retida:2:10.05.01",
      resultado: "a avisar",
    });
  });

  it("quem perdeu a corrida (chave única) segue em frente; erro de verdade sobe", async () => {
    db.webhookEvent.findMany.mockResolvedValue([]);
    db.webhookEvent.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(repositorioReal().registrarSemNota([item(1), item(2)])).resolves.toBeUndefined();
    expect(db.webhookEvent.create).toHaveBeenCalledTimes(2);

    db.webhookEvent.create.mockRejectedValueOnce(new Error("banco fora do ar"));
    await expect(repositorioReal().registrarSemNota([item(3)])).rejects.toThrow("banco fora do ar");
  });

  it("lê as que ainda não foram ditas à equipe e marca as que o e-mail levou", async () => {
    db.webhookEvent.findMany.mockResolvedValue([{ payload: item(1) }]);
    expect(await repositorioReal().semNotaAAvisar(20)).toEqual([item(1)]);
    expect(db.webhookEvent.findMany.mock.calls[0][0].where).toEqual({ provider: PROVIDER_SEM_NOTA, resultado: "a avisar" });

    const quando = new Date();
    await repositorioReal().marcarSemNotaAvisadas(["retida:1:10.05.01"], quando);
    expect(db.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: { provider: PROVIDER_SEM_NOTA, externalId: { in: ["retida:1:10.05.01"] } },
      data: { resultado: "avisada", processedAt: quando },
    });
  });
});

describe("ler as cobranças prontas que ainda têm o que emitir", () => {
  const cfg = (emissao: Record<string, unknown>) => lerConfigNotasFiscais({ emissao: { ligada: true, ...emissao } });
  const candidata = (id: number) => ({ cobrancaId: id, notas: [{ chave: `conexa-${id}-030302` }] });

  it("⚠ 300 prontas, 250 já emitidas: lê as 50 que faltam — as 200 mais antigas escondiam as novas", async () => {
    const todas = Array.from({ length: 300 }, (_, i) => candidata(i + 1));
    db.cobrancaFiscal.findMany.mockResolvedValueOnce(todas).mockImplementationOnce(async ({ where }) =>
      (where.cobrancaId.in as number[]).map((id) => ({ cobrancaId: id })),
    );
    // As 250 primeiras já têm nota (autorizada, na fila ou rejeitada) e não ocupam vaga.
    db.notaFiscalEmitida.findMany.mockResolvedValue(
      todas.slice(0, 250).map((c, i) => ({
        chave: c.notas[0].chave,
        situacao: ["AUTORIZADA", "ENVIADA", "REJEITADA"][i % 3],
        motivo: null,
      })),
    );

    const lidas = await prontasDoBanco(cfg({ aPartirDe: "2026-10-08" }), AGORA);
    expect(lidas.map((l) => l.cobrancaId)).toEqual(Array.from({ length: 50 }, (_, i) => i + 251));
  });

  it("a cobrança com nota que PODE tentar de novo (cadastro, reservada, sem resposta) continua sendo lida", async () => {
    db.cobrancaFiscal.findMany
      .mockResolvedValueOnce([candidata(1), candidata(2), candidata(3), candidata(4)])
      .mockImplementationOnce(async ({ where }) => (where.cobrancaId.in as number[]).map((id) => ({ cobrancaId: id })));
    db.notaFiscalEmitida.findMany.mockResolvedValue([
      { chave: "conexa-1-030302", situacao: "FALHOU", motivo: "Cadastro do cliente: CEP não existe" },
      { chave: "conexa-2-030302", situacao: "INCERTA", motivo: null },
      { chave: "conexa-3-030302", situacao: "FALHOU", motivo: "Spedy respondeu 400" },
      { chave: "conexa-4-030302", situacao: "AUTORIZADA", motivo: null },
    ]);
    const lidas = await prontasDoBanco(cfg({ aPartirDe: "2026-10-08" }), AGORA);
    expect(lidas.map((l) => l.cobrancaId)).toEqual([1, 2]);
  });

  it("a consulta só pede PRONTA paga desde o corte (ou gerada, sem quitação) dentro da janela de 60 dias", async () => {
    db.cobrancaFiscal.findMany.mockResolvedValue([]);
    await prontasDoBanco(cfg({ aPartirDe: "2026-10-08" }), AGORA);
    const where = db.cobrancaFiscal.findMany.mock.calls[0][0].where;
    expect(where.situacao).toBe("PRONTA");
    expect(where.OR[0]).toEqual({ quitadaEm: { gte: "2026-10-08" } });
    expect(where.OR[1].quitadaEm).toBeNull();
  });

  it("corte mais velho que a janela: vale a janela (60 dias para trás)", async () => {
    db.cobrancaFiscal.findMany.mockResolvedValue([]);
    await prontasDoBanco(cfg({ aPartirDe: "2026-01-01" }), AGORA);
    expect(db.cobrancaFiscal.findMany.mock.calls[0][0].where.OR[0]).toEqual({ quitadaEm: { gte: "2026-08-10" } });
  });

  it("com lista de cobranças liberadas, só elas; sem lista e sem corte, nem lê", async () => {
    db.cobrancaFiscal.findMany.mockResolvedValue([]);
    await prontasDoBanco(cfg({ soCobrancas: [5, 6] }), AGORA);
    expect(db.cobrancaFiscal.findMany.mock.calls[0][0].where).toMatchObject({ cobrancaId: { in: [5, 6] } });

    db.cobrancaFiscal.findMany.mockClear();
    await prontasDoBanco(cfg({}), AGORA);
    expect(db.cobrancaFiscal.findMany.mock.calls[0][0].where).toMatchObject({ cobrancaId: -1 });
  });

  it("nada com o que fazer: não faz a segunda consulta (a pesada, com o JSON da cobrança)", async () => {
    db.cobrancaFiscal.findMany.mockResolvedValueOnce([candidata(1)]);
    db.notaFiscalEmitida.findMany.mockResolvedValue([
      { chave: "conexa-1-030302", situacao: "AUTORIZADA", motivo: null },
    ]);
    expect(await prontasDoBanco(cfg({ aPartirDe: "2026-10-08" }), AGORA)).toEqual([]);
    expect(db.cobrancaFiscal.findMany).toHaveBeenCalledTimes(1);
  });

  it("⚠ as NOVAS vão na frente das presas por cadastro, e as presas se revezam pela última olhada", async () => {
    // O banco entrega por data de criação: 1 e 2 são as mais antigas e estão presas.
    db.cobrancaFiscal.findMany
      .mockResolvedValueOnce([1, 2, 3, 4, 5].map(candidata))
      .mockImplementationOnce(async ({ where }) => (where.cobrancaId.in as number[]).map((id) => ({ cobrancaId: id })));
    db.notaFiscalEmitida.findMany.mockResolvedValue([
      { chave: "conexa-1-030302", situacao: "FALHOU", motivo: "Cadastro do cliente: x", verificadaEm: new Date("2026-10-09T14:55:00Z") },
      { chave: "conexa-2-030302", situacao: "FALHOU", motivo: "Cadastro do cliente: x", verificadaEm: new Date("2026-10-09T13:00:00Z") },
    ]);
    const lidas = await prontasDoBanco(cfg({ aPartirDe: "2026-10-08" }), AGORA);
    // Novas (3, 4, 5) primeiro; depois a olhada há mais tempo (2, às 13h) e a mais recente (1, às 14h55).
    expect(lidas.map((l) => l.cobrancaId)).toEqual([3, 4, 5, 2, 1]);
    // A leitura das linhas traz `verificadaEm`, que é o que faz as presas girarem.
    expect(db.notaFiscalEmitida.findMany.mock.calls[0][0].select).toMatchObject({ verificadaEm: true });
  });
});

describe("cobranças retidas por código em espera (o número da tela)", () => {
  const cfg = (emissao: Record<string, unknown>) =>
    lerConfigNotasFiscais({ emissao: { ligada: true, aPartirDe: "2026-10-08", ...emissao } });

  it("sem código em espera nem lê o banco", async () => {
    expect(await cobrancasRetidas(cfg({}), AGORA)).toEqual([]);
    expect(db.cobrancaFiscal.findMany).not.toHaveBeenCalled();
  });

  it("⚠ acha a retida NOVA mesmo com 299 prontas antigas já emitidas (antes eram as 200 mais antigas: dava zero)", async () => {
    const antigas = Array.from({ length: 299 }, (_, i) => ({ cobrancaId: i + 1, notas: [{ chave: `conexa-${i + 1}-030302` }] }));
    const nova = { cobrancaId: 300, notas: [{ chave: "conexa-300-100501" }] };
    db.cobrancaFiscal.findMany.mockResolvedValueOnce([...antigas, nova]).mockResolvedValueOnce([
      {
        cobrancaId: 300,
        empresaId: 3,
        clienteId: 77,
        situacao: "PRONTA",
        quitadaEm: "2026-10-09",
        evento: "quitada",
        cobranca: {},
        notas: [{ chave: "conexa-300-100501", codigo: "10.05.01", valorCentavos: 10000 }],
      },
    ]);
    db.notaFiscalEmitida.findMany.mockResolvedValue(
      antigas.map((c) => ({ chave: c.notas[0].chave, situacao: "AUTORIZADA", motivo: null })),
    );
    expect(await cobrancasRetidas(cfg({ codigosEmEspera: ["10.05.01"] }), AGORA)).toEqual([300]);
  });

  it("conta mesmo com a emissão desligada (é o tamanho da fila que sai com o código), mas só o que a rodada emitiria", async () => {
    db.cobrancaFiscal.findMany.mockResolvedValueOnce([{ cobrancaId: 1, notas: [{ chave: "conexa-1-100501" }] }]).mockResolvedValueOnce([
      {
        cobrancaId: 1,
        empresaId: 3,
        clienteId: 77,
        situacao: "PRONTA",
        quitadaEm: "2026-10-09",
        evento: "quitada",
        cobranca: {},
        notas: [{ chave: "conexa-1-100501", codigo: "10.05.01", valorCentavos: 10000 }],
      },
    ]);
    db.notaFiscalEmitida.findMany.mockResolvedValue([]);
    expect(await cobrancasRetidas(cfg({ ligada: false, codigosEmEspera: ["10.05.01"] }), AGORA)).toEqual([1]);
  });
});

describe("reivindicar a nota: a trava entre as duas rodadas", () => {
  it("⚠ muda só se a nota está como foi lida — situação e tentativas vão no WHERE do próprio UPDATE", async () => {
    db.notaFiscalEmitida.updateMany.mockResolvedValue({ count: 1 });
    const ok = await repositorioReal().reivindicar(
      "conexa-1-030302",
      { situacao: "RESERVADA" as never, tentativas: 2 },
      { tentativas: 3, enviadaEm: AGORA, avisadaEm: null },
    );
    expect(ok).toBe(true);
    expect(db.notaFiscalEmitida.updateMany).toHaveBeenCalledTimes(1);
    expect(db.notaFiscalEmitida.updateMany).toHaveBeenCalledWith({
      where: { chave: "conexa-1-030302", situacao: "RESERVADA", tentativas: 2 },
      data: expect.objectContaining({ tentativas: 3, enviadaEm: AGORA, avisadaEm: null, verificadaEm: expect.any(Date) }),
    });
  });

  it("outra rodada chegou primeiro (nenhuma linha mudou): quem perdeu recebe false e não manda nada", async () => {
    db.notaFiscalEmitida.updateMany.mockResolvedValue({ count: 0 });
    expect(await repositorioReal().reivindicar("conexa-1-030302", { situacao: "RESERVADA" as never, tentativas: 2 }, { tentativas: 3 })).toBe(false);
  });
});

describe("as notas vivas de uma cobrança e as em voo", () => {
  it("⚠ vivas são reservada, enviada, incerta e autorizada — rejeitada, parada e cancelada NÃO seguram o plano novo", async () => {
    db.notaFiscalEmitida.findMany.mockResolvedValue([]);
    await repositorioReal().vivasDaCobranca(31000);
    expect(db.notaFiscalEmitida.findMany).toHaveBeenCalledWith({
      where: { cobrancaId: 31000, situacao: { in: ["RESERVADA", "ENVIADA", "INCERTA", "AUTORIZADA"] } },
    });
  });

  it("em voo: enviada e incerta; com `exceto`, a própria nota que a rodada vai mandar fica de fora", async () => {
    db.notaFiscalEmitida.count.mockResolvedValue(0);
    await repositorioReal().contarEmVoo();
    await repositorioReal().contarEmVoo("conexa-1-030302");
    expect(db.notaFiscalEmitida.count.mock.calls[0][0]).toEqual({ where: { situacao: { in: ["ENVIADA", "INCERTA"] } } });
    expect(db.notaFiscalEmitida.count.mock.calls[1][0]).toEqual({
      where: { situacao: { in: ["ENVIADA", "INCERTA"] }, chave: { not: "conexa-1-030302" } },
    });
  });
});

describe("cobrança paga sem decisão: só as que a equipe ainda não ouviu", () => {
  const sem = (id: number, situacao = "CONFERIR") => ({ cobrancaId: id, empresaId: 3, situacao, valorCentavos: 100, motivo: null });

  it("⚠ passadas as 50 primeiras, a 51ª em diante também aparece (antes eram as 50 mais antigas, sempre as mesmas)", async () => {
    const todas = Array.from({ length: 60 }, (_, i) => sem(i + 1));
    db.cobrancaFiscal.findMany.mockResolvedValue(todas);
    // As 50 mais antigas já foram ditas.
    db.webhookEvent.findMany.mockResolvedValue(todas.slice(0, 50).map((c) => ({ externalId: `decisao:${c.cobrancaId}:CONFERIR` })));
    const lidas = await dependenciasReais().semDecisao!("2026-10-08");
    expect(lidas.map((l) => l.cobrancaId)).toEqual(Array.from({ length: 10 }, (_, i) => i + 51));
  });

  it("a situação faz parte da chave: a que mudou de 'conferir' para 'aguardando código' é notícia nova", async () => {
    db.cobrancaFiscal.findMany.mockResolvedValue([sem(1, "AGUARDANDO_CLASSIFICACAO")]);
    db.webhookEvent.findMany.mockResolvedValue([{ externalId: "decisao:1:CONFERIR" }]);
    expect((await dependenciasReais().semDecisao!("2026-10-08")).map((l) => l.cobrancaId)).toEqual([1]);
  });

  it("⚠ lê MUITO mais que 50 para achar as que faltam, e entrega no máximo 50 por rodada", async () => {
    const todas = Array.from({ length: 120 }, (_, i) => sem(i + 1));
    db.cobrancaFiscal.findMany.mockResolvedValue(todas);
    db.webhookEvent.findMany.mockResolvedValue([]);
    const lidas = await dependenciasReais().semDecisao!("2026-10-08");
    expect(lidas).toHaveLength(50);
    const consulta = db.cobrancaFiscal.findMany.mock.calls[0][0];
    expect(consulta.take).toBeGreaterThanOrEqual(1000);
    expect(consulta.where).toMatchObject({ situacao: { in: ["CONFERIR", "AGUARDANDO_CLASSIFICACAO"] }, quitadaEm: { gte: "2026-10-08" } });
    // A consulta de "já ditas" leva as chaves de todas as candidatas.
    expect(db.webhookEvent.findMany.mock.calls[0][0].where.externalId.in).toHaveLength(120);
  });

  it("nada para decidir: nem consulta as entregas", async () => {
    db.cobrancaFiscal.findMany.mockResolvedValue([]);
    expect(await dependenciasReais().semDecisao!("2026-10-08")).toEqual([]);
    expect(db.webhookEvent.findMany).not.toHaveBeenCalled();
  });
});
