import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { SituacaoDaNota } from "@/generated/prisma/enums";
import { SpedyApiError, SpedyRedeError, type CorpoDeNota, type NotaDaSpedy } from "@/server/integrations/spedy/client";
import { lerConfigNotasFiscais } from "../config";
import {
  acompanharNotas,
  avisarProblemas,
  enviarNota,
  faltaEmitir,
  liberarNotaParaNovaTentativa,
  MARCA_DO_N8N,
  rodarEmissao,
  type Dependencias,
  type LinhaDaNota,
  type LinhaPronta,
  type Repositorio,
} from "./emitir";
import type { CepLido, CobrancaSemNota, Tomador } from "./regras";

const NOTA = {
  chave: "conexa-900-030302",
  codigo: "03.03.02",
  valorCentavos: 14900,
  descricao: "Reserva de sala",
  competencia: "2026-10",
  vendas: [1],
};

const TOMADOR: Tomador = {
  nome: "Maria da Silva",
  documento: "04578999483",
  email: "maria@exemplo.com",
  telefone: null,
  cep: "59056000",
  rua: "Rua A",
  numero: "10",
  bairro: "Centro",
  complemento: "",
  cidade: "Natal",
  uf: "RN",
};
const CEP_OK: CepLido = { estado: "ok", ibge: 2408102, cidade: "Natal", uf: "RN" };

function repositorioEmMemoria() {
  const linhas = new Map<string, LinhaDaNota>();
  const avisadas = new Set<string>();
  /** As cobranças sem nota guardadas (retida, conferir...) e se a equipe já foi avisada. */
  const semNota = new Map<string, { item: CobrancaSemNota; avisada: boolean }>();
  const repo: Repositorio = {
    async obter(chave) {
      return linhas.get(chave) ? { ...linhas.get(chave)! } : null;
    },
    async criar(l) {
      if (linhas.has(l.chave)) return false;
      linhas.set(l.chave, { ...l, spedyId: null, numero: null, motivo: null, tentativas: 0, enviadaEm: null });
      return true;
    },
    async atualizar(chave, dados) {
      linhas.set(chave, { ...linhas.get(chave)!, ...dados });
      // Liberada de novo: o próximo problema desta nota volta a ser avisado.
      if (dados.avisadaEm === null) avisadas.delete(chave);
    },
    async registrarSemNota(itens) {
      for (const item of itens) if (!semNota.has(item.chave)) semNota.set(item.chave, { item, avisada: false });
    },
    async semNotaAAvisar() {
      return [...semNota.values()].filter((e) => !e.avisada).map((e) => e.item);
    },
    async marcarSemNotaAvisadas(chaves) {
      for (const c of chaves) {
        const e = semNota.get(c);
        if (e) e.avisada = true;
      }
    },
    async aAvisar() {
      return [...linhas.values()].filter(
        (l) => (l.situacao === SituacaoDaNota.REJEITADA || l.situacao === SituacaoDaNota.FALHOU) && !avisadas.has(l.chave),
      );
    },
    async marcarAvisadas(chaves) {
      for (const c of chaves) avisadas.add(c);
    },
    async aAcompanhar() {
      return [...linhas.values()].filter(
        (l) => l.situacao === SituacaoDaNota.ENVIADA || l.situacao === SituacaoDaNota.INCERTA,
      );
    },
    async contarAutorizadas() {
      return [...linhas.values()].filter(
        (l) => l.situacao === SituacaoDaNota.AUTORIZADA && !l.motivo?.startsWith(MARCA_DO_N8N),
      ).length;
    },
    async contarEmVoo() {
      return [...linhas.values()].filter(
        (l) => l.situacao === SituacaoDaNota.ENVIADA || l.situacao === SituacaoDaNota.INCERTA,
      ).length;
    },
  };
  return { repo, linhas, avisadas, semNota };
}

function montar(extra: Partial<Dependencias> = {}) {
  const { repo, linhas, avisadas, semNota } = repositorioEmMemoria();
  const spedy = {
    criarNota: vi.fn<(c: CorpoDeNota) => Promise<NotaDaSpedy>>(async (c) => ({
      id: "spedy-1",
      integrationId: c.integrationId,
      status: "enqueued",
      number: null,
      processingDetail: null,
    })),
    obterNota: vi.fn<(id: string) => Promise<NotaDaSpedy>>(),
    buscarPorIntegrationId: vi.fn<(id: string) => Promise<NotaDaSpedy | null>>(async () => null),
  };
  const dep: Dependencias = {
    repo,
    spedy: () => spedy,
    tomador: async () => TOMADOR,
    cep: async () => CEP_OK,
    agora: () => new Date("2026-10-07T15:00:00Z"),
    avisar: async () => "enviado",
    ...extra,
  };
  return { dep, spedy, linhas, avisadas, semNota };
}

const args = { nota: NOTA, cobrancaId: 900, clienteId: 77, empresa: "SEATECH", enviarEmailAoCliente: true };

describe("enviar a nota", () => {
  let ctx: ReturnType<typeof montar>;
  beforeEach(() => {
    ctx = montar();
  });

  it("reserva, manda e guarda o que a Spedy respondeu", async () => {
    expect(await enviarNota(ctx.dep, args)).toBe("enviada");
    const l = ctx.linhas.get(NOTA.chave)!;
    expect(l).toMatchObject({ situacao: "ENVIADA", spedyId: "spedy-1", tentativas: 1 });
    const corpo = ctx.spedy.criarNota.mock.calls[0][0];
    expect(corpo).toMatchObject({
      integrationId: "conexa-900-030302",
      nationalTaxationCode: "030302",
      issue: true,
      total: { invoiceAmount: 149 },
    });
  });

  it("⚠ a mesma nota NUNCA é enviada duas vezes", async () => {
    await enviarNota(ctx.dep, args);
    expect(await enviarNota(ctx.dep, args)).toBe("ja existe");
    expect(await enviarNota(ctx.dep, args)).toBe("ja existe");
    expect(ctx.spedy.criarNota).toHaveBeenCalledTimes(1);
  });

  it("⚠ a tentativa é anotada ANTES de o envio sair", async () => {
    let visto: LinhaDaNota | undefined;
    ctx.spedy.criarNota.mockImplementation(async (c) => {
      visto = { ...ctx.linhas.get(NOTA.chave)! };
      return { id: "x", integrationId: c.integrationId, status: "enqueued", number: null, processingDetail: null };
    });
    await enviarNota(ctx.dep, args);
    expect(visto?.tentativas).toBe(1);
    expect(visto?.enviadaEm).not.toBeNull();
  });

  it("⚠ recusa da Spedy (4xx) é FALHOU e não é repetida sozinha", async () => {
    ctx.spedy.criarNota.mockRejectedValue(new SpedyApiError(400, "Spedy respondeu 400: dado inválido"));
    expect(await enviarNota(ctx.dep, args)).toBe("falhou");
    expect(ctx.linhas.get(NOTA.chave)).toMatchObject({ situacao: "FALHOU", motivo: expect.stringContaining("dado inválido") });
    expect(await enviarNota(ctx.dep, args)).toBe("ja existe");
    expect(ctx.spedy.criarNota).toHaveBeenCalledTimes(1);
  });

  it("⚠ erro de rede é INCERTA, e a rodada seguinte procura a nota ANTES de mandar de novo", async () => {
    ctx.spedy.criarNota.mockRejectedValueOnce(new SpedyRedeError("timeout"));
    expect(await enviarNota(ctx.dep, args)).toBe("incerta");
    expect(ctx.linhas.get(NOTA.chave)?.situacao).toBe("INCERTA");

    // A nota tinha saído: a procura acha e NÃO manda de novo.
    ctx.spedy.buscarPorIntegrationId.mockResolvedValueOnce({
      id: "spedy-9",
      integrationId: NOTA.chave,
      status: "enqueued",
      number: null,
      processingDetail: null,
    });
    expect(await enviarNota(ctx.dep, args)).toBe("enviada");
    expect(ctx.spedy.criarNota).toHaveBeenCalledTimes(1);
    expect(ctx.linhas.get(NOTA.chave)).toMatchObject({ situacao: "ENVIADA", spedyId: "spedy-9" });
  });

  it("INCERTA que a Spedy não conhece sai de verdade na rodada seguinte", async () => {
    ctx.spedy.criarNota.mockRejectedValueOnce(new SpedyApiError(503, "Spedy respondeu 503"));
    expect(await enviarNota(ctx.dep, args)).toBe("incerta");
    expect(await enviarNota(ctx.dep, args)).toBe("enviada");
    expect(ctx.spedy.criarNota).toHaveBeenCalledTimes(2);
  });

  it("429 é 'tente depois': não saiu, e volta a ser tentada", async () => {
    ctx.spedy.criarNota.mockRejectedValueOnce(new SpedyApiError(429, "Spedy respondeu 429"));
    expect(await enviarNota(ctx.dep, args)).toBe("adiada");
    expect(ctx.linhas.get(NOTA.chave)?.situacao).toBe("RESERVADA");
    expect(await enviarNota(ctx.dep, args)).toBe("enviada");
  });

  it("⚠ cadastro ruim NÃO chama a Spedy nem gasta número, e a nota sai quando o cadastro é corrigido", async () => {
    let cep: CepLido = { estado: "inexistente" };
    const c = montar({ cep: async () => cep });
    expect(await enviarNota(c.dep, args)).toBe("falhou");
    expect(c.linhas.get(NOTA.chave)).toMatchObject({
      situacao: "FALHOU",
      motivo: expect.stringMatching(/^Cadastro do cliente: o CEP 59056000 do cadastro não existe/),
    });
    expect(c.spedy.criarNota).not.toHaveBeenCalled();

    cep = CEP_OK; // alguém corrigiu o CEP no Conexa
    expect(await enviarNota(c.dep, args)).toBe("enviada");
    expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
  });

  it("sem a chave da empresa no servidor: não reserva nada e diz isso", async () => {
    const c = montar({ spedy: () => null });
    expect(await enviarNota(c.dep, args)).toBe("sem chave");
    expect(c.linhas.size).toBe(0);
  });

  it("não conseguiu ler o cliente no Conexa: adia, sem reservar e sem acusar o cadastro", async () => {
    const c = montar({ tomador: async () => null });
    expect(await enviarNota(c.dep, args)).toBe("adiada");
    expect(c.linhas.size).toBe(0);
    expect(c.spedy.criarNota).not.toHaveBeenCalled();
  });

  it("a Spedy já devolver 'authorized' não precisa esperar", async () => {
    ctx.spedy.criarNota.mockResolvedValueOnce({
      id: "s",
      integrationId: NOTA.chave,
      status: "authorized",
      number: 42641,
      processingDetail: null,
    });
    await enviarNota(ctx.dep, args);
    expect(ctx.linhas.get(NOTA.chave)).toMatchObject({ situacao: "AUTORIZADA", numero: 42641 });
  });
});

describe("acompanhar as notas enviadas", () => {
  it("autorizada ganha o número; rejeitada guarda o motivo da prefeitura", async () => {
    const c = montar();
    await enviarNota(c.dep, args);
    await enviarNota(c.dep, { ...args, nota: { ...NOTA, chave: "conexa-901-030302" }, cobrancaId: 901 });
    c.spedy.obterNota
      .mockResolvedValueOnce({ id: "spedy-1", integrationId: NOTA.chave, status: "authorized", number: 6794, processingDetail: null })
      .mockResolvedValueOnce({
        id: "spedy-1",
        integrationId: "conexa-901-030302",
        status: "rejected",
        number: null,
        processingDetail: { code: "E0240", message: "O CEP do tomador não existe." },
      });
    const r = await acompanharNotas(c.dep);
    expect(r).toMatchObject({ autorizadas: 1, rejeitadas: 1, naFila: 0 });
    expect(c.linhas.get(NOTA.chave)).toMatchObject({ situacao: "AUTORIZADA", numero: 6794 });
    expect(c.linhas.get("conexa-901-030302")).toMatchObject({
      situacao: "REJEITADA",
      motivo: "E0240: O CEP do tomador não existe.",
    });
  });

  it("nota ainda na fila continua sendo acompanhada", async () => {
    const c = montar();
    await enviarNota(c.dep, args);
    c.spedy.obterNota.mockResolvedValue({ id: "spedy-1", integrationId: NOTA.chave, status: "enqueued", number: null, processingDetail: null });
    expect((await acompanharNotas(c.dep)).naFila).toBe(1);
    expect(c.linhas.get(NOTA.chave)?.situacao).toBe("ENVIADA");
  });

  it("falha ao perguntar à Spedy não muda a nota", async () => {
    const c = montar();
    await enviarNota(c.dep, args);
    c.spedy.obterNota.mockRejectedValue(new SpedyRedeError("fora do ar"));
    expect((await acompanharNotas(c.dep)).falhas).toBe(1);
    expect(c.linhas.get(NOTA.chave)?.situacao).toBe("ENVIADA");
  });
});

describe("aviso à equipe", () => {
  const rejeitar = async (c: ReturnType<typeof montar>) => {
    await enviarNota(c.dep, args);
    c.spedy.obterNota.mockResolvedValue({
      id: "spedy-1",
      integrationId: NOTA.chave,
      status: "rejected",
      number: null,
      processingDetail: { code: "E0240", message: "O CEP do tomador não existe." },
    });
    await acompanharNotas(c.dep);
  };

  it("⚠ leva a rejeição num e-mail só e marca como avisada SÓ depois de enviada", async () => {
    const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
    const c = montar({ avisar });
    await rejeitar(c);
    const r = await avisarProblemas(c.dep, ["suporte@seahubcoworking.com.br"]);
    expect(r).toEqual({ avisadas: 1, pendentes: 0 });
    expect(avisar).toHaveBeenCalledTimes(1);
    expect(avisar.mock.calls[0][0][0]).toMatchObject({
      cobrancaId: 900,
      situacao: "REJEITADA",
      motivo: "E0240: O CEP do tomador não existe.",
    });
    expect(avisar.mock.calls[0][1]).toEqual(["suporte@seahubcoworking.com.br"]);
    expect(c.avisadas.has(NOTA.chave)).toBe(true);

    // Já avisada: não manda de novo.
    expect(await avisarProblemas(c.dep, ["suporte@seahubcoworking.com.br"])).toEqual({ avisadas: 0, pendentes: 0 });
    expect(avisar).toHaveBeenCalledTimes(1);
  });

  it("⚠ aviso que NÃO saiu continua pendente e tenta de novo na rodada seguinte", async () => {
    const avisar = vi.fn<Dependencias["avisar"]>().mockResolvedValueOnce("falhou").mockResolvedValue("enviado");
    const c = montar({ avisar });
    await rejeitar(c);
    expect(await avisarProblemas(c.dep, ["a@b.com"])).toMatchObject({ avisadas: 0, pendentes: 1, motivo: "falhou" });
    expect(c.avisadas.size).toBe(0);
    expect(await avisarProblemas(c.dep, ["a@b.com"])).toEqual({ avisadas: 1, pendentes: 0 });
  });

  it("sem destinatário na tela ou sem a Resend no servidor, nada é marcado como avisado", async () => {
    const c = montar({ avisar: async () => "sem provedor" });
    await rejeitar(c);
    expect(await avisarProblemas(c.dep, [])).toMatchObject({
      avisadas: 0,
      pendentes: 1,
      motivo: "sem destinatário na tela",
    });
    expect(await avisarProblemas(c.dep, ["a@b.com"])).toMatchObject({ avisadas: 0, motivo: "sem provedor" });
    expect(c.avisadas.size).toBe(0);
  });

  it("cadastro do cliente parado também vai no aviso, e nota boa não", async () => {
    const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
    const c = montar({ avisar, cep: async () => ({ estado: "inexistente" }) });
    await enviarNota(c.dep, args);
    await avisarProblemas(c.dep, ["a@b.com"]);
    expect(avisar.mock.calls[0][0][0]).toMatchObject({
      situacao: "FALHOU",
      motivo: expect.stringMatching(/^Cadastro do cliente:/),
    });

    const bom = montar({ avisar });
    await enviarNota(bom.dep, args);
    avisar.mockClear();
    expect(await avisarProblemas(bom.dep, ["a@b.com"])).toEqual({ avisadas: 0, pendentes: 0 });
    expect(avisar).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A cautela: as primeiras notas saem uma de cada vez, e problema desliga tudo
// ---------------------------------------------------------------------------

describe("a rodada de emissão com cautela", () => {
  const nota = (n: number) => ({ ...NOTA, chave: `conexa-${n}-030302`, valorCentavos: 14900 });
  const pronta = (n: number): LinhaPronta => ({
    cobrancaId: n,
    empresaId: 3,
    clienteId: 77,
    situacao: "PRONTA",
    quitadaEm: "2026-10-08",
    cobranca: {},
    notas: [nota(n)],
  });
  const config = (emissao: Record<string, unknown> = {}) =>
    lerConfigNotasFiscais({ emissao: { ligada: true, soCobrancas: [1, 2, 3, 4], cautela: 2, ...emissao } });
  const autorizada = (id: string, amount = 149): NotaDaSpedy => ({
    id,
    integrationId: null,
    status: "authorized",
    number: 11,
    amount,
    processingDetail: null,
  });
  const naFila = (id: string): NotaDaSpedy => ({
    id,
    integrationId: null,
    status: "enqueued",
    number: null,
    amount: 149,
    processingDetail: null,
  });
  const rejeitada = (id: string): NotaDaSpedy => ({
    id,
    integrationId: null,
    status: "rejected",
    number: null,
    amount: 149,
    processingDetail: { status: "rejected", message: "E0240: o CEP do tomador não existe" },
  });

  /** `resposta` diz o que a prefeitura responde quando a nota é conferida. */
  function cenario(resposta: (id: string) => NotaDaSpedy, prontas: LinhaPronta[]) {
    const ctx = montar({ prontas: async () => prontas });
    const desligar = vi.fn<(motivo: string) => Promise<void>>(async () => {});
    ctx.dep.desligar = desligar;
    ctx.spedy.criarNota.mockImplementation(async (c) => ({
      ...naFila(`spedy-${c.integrationId}`),
      integrationId: c.integrationId,
    }));
    ctx.spedy.obterNota.mockImplementation(async (id) => resposta(id));
    return { ...ctx, desligar, pausar: vi.fn(async () => {}) };
  }

  it("⚠ as primeiras saem uma de cada vez, cada uma conferida antes da próxima, e depois a fila anda", async () => {
    const c = cenario((id) => autorizada(id), [1, 2, 3, 4].map(pronta));
    const r = await rodarEmissao(c.dep, config(), c.pausar);
    expect(r.enviadas).toBe(4);
    expect(r.pausada).toBeUndefined();
    expect(c.desligar).not.toHaveBeenCalled();
    // As duas da cautela foram conferidas na hora; as outras saíram em seguida, sem esperar.
    expect(c.linhas.get("conexa-1-030302")?.situacao).toBe("AUTORIZADA");
    expect(c.linhas.get("conexa-2-030302")?.situacao).toBe("AUTORIZADA");
    expect(c.linhas.get("conexa-3-030302")?.situacao).toBe("ENVIADA");
  });

  it("⚠ prefeitura que não respondeu SEGURA a seguinte: nada de mandar a segunda por cima", async () => {
    const c = cenario((id) => naFila(id), [1, 2, 3].map(pronta));
    const r = await rodarEmissao(c.dep, config(), c.pausar);
    expect(r.enviadas).toBe(1);
    expect(r.aguardando).toBe(true);
    expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
    expect(c.desligar).not.toHaveBeenCalled();

    // Na rodada seguinte a prefeitura já autorizou: a fila anda.
    c.spedy.obterNota.mockImplementation(async (id) => autorizada(id));
    const r2 = await rodarEmissao(c.dep, config(), c.pausar);
    expect(r2.enviadas).toBe(2);
    expect(c.spedy.criarNota).toHaveBeenCalledTimes(3);
  });

  it("⚠ UMA rejeição na cautela desliga a emissão sozinha e nada mais sai", async () => {
    const c = cenario((id) => rejeitada(id), [1, 2, 3].map(pronta));
    const r = await rodarEmissao(c.dep, config(), c.pausar);
    expect(r.enviadas).toBe(1);
    expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
    expect(r.pausada).toMatch(/nas primeiras notas.*cobrança 1.*rejeitada pela prefeitura.*E0240/);
    expect(c.desligar).toHaveBeenCalledTimes(1);
    expect(c.linhas.get("conexa-1-030302")?.situacao).toBe("REJEITADA");
  });

  it("⚠ rejeição achada na conferência das notas já enviadas desliga ANTES de mandar mais", async () => {
    const c = cenario((id) => rejeitada(id), [1, 2].map(pronta));
    // Uma nota enviada na rodada anterior, ainda na fila da prefeitura.
    c.linhas.set("conexa-9-030302", {
      chave: "conexa-9-030302",
      cobrancaId: 9,
      empresa: "SEAHUB",
      codigo: "03.03.02",
      valorCentavos: 14900,
      competencia: "2026-10",
      situacao: SituacaoDaNota.ENVIADA,
      spedyId: "spedy-antiga",
      numero: null,
      motivo: null,
      tentativas: 1,
      enviadaEm: new Date(),
    });
    const r = await rodarEmissao(c.dep, config(), c.pausar);
    expect(r.pausada).toMatch(/cobrança 9/);
    expect(c.spedy.criarNota).not.toHaveBeenCalled();
    expect(c.desligar).toHaveBeenCalledTimes(1);
  });

  it("⚠ valor registrado na Spedy diferente do planejado desliga, mesmo com a nota autorizada", async () => {
    const c = cenario((id) => autorizada(id, 99.99), [1, 2].map(pronta));
    const r = await rodarEmissao(c.dep, config(), c.pausar);
    expect(r.pausada).toMatch(/registrou R\$ 99,99 e o planejado era R\$ 149,00/);
    expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
    expect(c.desligar).toHaveBeenCalledTimes(1);
  });

  it("cadastro ruim do cliente NÃO desliga: não gasta número e não é defeito nosso", async () => {
    const c = cenario((id) => autorizada(id), [1, 2].map(pronta));
    let primeira = true;
    c.dep.tomador = async () => {
      if (primeira) {
        primeira = false;
        return { ...TOMADOR, cep: "590" };
      }
      return TOMADOR;
    };
    const r = await rodarEmissao(c.dep, config(), c.pausar);
    expect(r.falhas).toBe(1);
    expect(r.enviadas).toBe(1);
    expect(r.pausada).toBeUndefined();
    expect(c.desligar).not.toHaveBeenCalled();
  });

  it("passada a cautela, UMA rejeição não para a emissão (cadastro de cliente não pode parar o resto)", async () => {
    const c = cenario((id) => (id.includes("conexa-3-") ? rejeitada(id) : autorizada(id)), [1, 2, 3, 4].map(pronta));
    const r = await rodarEmissao(c.dep, config({ cautela: 0 }), c.pausar);
    expect(r.enviadas).toBe(4);
    expect(r.pausada).toBeUndefined();
    expect(c.desligar).not.toHaveBeenCalled();
  });

  it("emissão desligada: só acompanha, não manda nem desliga nada", async () => {
    const c = cenario((id) => autorizada(id), [1].map(pronta));
    const r = await rodarEmissao(c.dep, config({ ligada: false }), c.pausar);
    expect(r.enviadas).toBe(0);
    expect(c.spedy.criarNota).not.toHaveBeenCalled();
  });

  it("cobrança que o n8n já emitiu (marcada na tabela) NÃO é emitida de novo e não conta como nossa", async () => {
    const c = cenario((id) => autorizada(id), [1, 2].map(pronta));
    c.linhas.set("conexa-1-030302", {
      chave: "conexa-1-030302",
      cobrancaId: 1,
      empresa: "SEAHUB",
      codigo: "03.03.02",
      valorCentavos: 14900,
      competencia: "2026-10",
      situacao: SituacaoDaNota.AUTORIZADA,
      spedyId: null,
      numero: null,
      motivo: `${MARCA_DO_N8N} antes do corte`,
      tentativas: 0,
      enviadaEm: null,
    });
    const r = await rodarEmissao(c.dep, config({ cautela: 1 }), c.pausar);
    expect(r.enviadas).toBe(1);
    expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
    expect(c.spedy.criarNota.mock.calls[0][0].integrationId).toBe("conexa-2-030302");
    expect(await c.dep.repo.contarAutorizadas()).toBe(1);
  });

  describe("tipo de operação da sala privativa na rodada", () => {
    const sala = (n: number, evento?: string): LinhaPronta => ({
      ...pronta(n),
      evento,
      notas: [{ ...nota(n), chave: `conexa-${n}-100501`, codigo: "10.05.01" }],
    });

    it("⚠ cobrança paga manda 'pagamento já realizado'; gerada (cliente antes) manda 'pagamento posterior'", async () => {
      const c = cenario((id) => autorizada(id), [sala(1, "quitada"), sala(2, "gerada"), sala(3), pronta(4)]);
      const r = await rodarEmissao(c.dep, config({ cautela: 0, soCobrancas: [1, 2, 3, 4] }), c.pausar);
      expect(r.enviadas).toBe(4);
      const corpos = new Map(c.spedy.criarNota.mock.calls.map(([corpo]) => [corpo.integrationId, corpo]));
      expect(corpos.get("conexa-1-100501")?.ibsCbs).toEqual({ operationType: "supplyWithPriorPayment" });
      expect(corpos.get("conexa-2-100501")?.ibsCbs).toEqual({ operationType: "supplyWithSubsequentPayment" });
      // Sem evento gravado, vale o pagamento já realizado, que é o padrão.
      expect(corpos.get("conexa-3-100501")?.ibsCbs).toEqual({ operationType: "supplyWithPriorPayment" });
      // A nota comum não muda.
      expect(corpos.get("conexa-4-030302")).not.toHaveProperty("ibsCbs");
    });

    it("⚠ a nota rejeitada que foi liberada sai de novo COM o campo, no mesmo identificador", async () => {
      const c = cenario((id) => autorizada(id), [sala(1, "quitada")]);
      c.linhas.set("conexa-1-100501", {
        chave: "conexa-1-100501",
        cobrancaId: 1,
        empresa: "SEAHUB",
        codigo: "10.05.01",
        valorCentavos: 14900,
        competencia: "2026-10",
        situacao: SituacaoDaNota.REJEITADA,
        spedyId: "spedy-rejeitada",
        numero: null,
        motivo: "E0903: o tipo de operação deve ser informado",
        tentativas: 1,
        enviadaEm: new Date(),
      });
      // Rejeitada não tenta de novo sozinha...
      await rodarEmissao(c.dep, config({ cautela: 0 }), c.pausar);
      expect(c.spedy.criarNota).not.toHaveBeenCalled();
      // ...e só sai quando alguém libera.
      expect((await liberarNotaParaNovaTentativa(c.dep.repo, "conexa-1-100501")).ok).toBe(true);
      const r = await rodarEmissao(c.dep, config({ cautela: 0 }), c.pausar);
      expect(r.enviadas).toBe(1);
      expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
      expect(c.spedy.criarNota.mock.calls[0][0]).toMatchObject({
        integrationId: "conexa-1-100501",
        ibsCbs: { operationType: "supplyWithPriorPayment" },
      });
      expect(c.spedy.buscarPorIntegrationId).not.toHaveBeenCalled();
    });
  });

  describe("códigos em espera", () => {
    /** Uma cobrança de sala privativa (10.05.01), com uma nota só. */
    const salaPrivativa = (n: number): LinhaPronta => ({
      ...pronta(n),
      notas: [{ ...nota(n), chave: `conexa-${n}-100501`, codigo: "10.05.01" }],
    });
    /** Cobrança com DUAS notas: um serviço comum e uma sala privativa. */
    const mista = (n: number): LinhaPronta => ({
      ...pronta(n),
      notas: [nota(n), { ...nota(n), chave: `conexa-${n}-100501`, codigo: "10.05.01" }],
    });

    it("⚠ segura a cobrança de sala privativa e deixa o resto sair, sem gastar número", async () => {
      const c = cenario((id) => autorizada(id), [salaPrivativa(1), pronta(2), pronta(3)]);
      const r = await rodarEmissao(c.dep, config({ cautela: 0, codigosEmEspera: ["10.05.01"] }), c.pausar);
      expect(r.enviadas).toBe(2);
      expect(r.retidas).toEqual([1]);
      expect(r.pausada).toBeUndefined();
      expect(c.spedy.criarNota).toHaveBeenCalledTimes(2);
      expect(c.linhas.has("conexa-1-100501")).toBe(false);
    });

    it("⚠ a cobrança com dois códigos fica retida INTEIRA: a nota comum também espera", async () => {
      const c = cenario((id) => autorizada(id), [mista(1), pronta(2)]);
      const r = await rodarEmissao(c.dep, config({ cautela: 0, codigosEmEspera: ["10.05.01"] }), c.pausar);
      expect(r.enviadas).toBe(1);
      expect(r.retidas).toEqual([1]);
      expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
      expect(c.spedy.criarNota.mock.calls[0][0].integrationId).toBe("conexa-2-030302");
      expect(c.linhas.has("conexa-1-030302")).toBe(false);
    });

    it("tirou o código da espera: a cobrança retida sai na rodada seguinte, ainda pronta", async () => {
      const c = cenario((id) => autorizada(id), [salaPrivativa(1)]);
      await rodarEmissao(c.dep, config({ cautela: 0, codigosEmEspera: ["10.05.01"] }), c.pausar);
      expect(c.spedy.criarNota).not.toHaveBeenCalled();

      const r = await rodarEmissao(c.dep, config({ cautela: 0, codigosEmEspera: [] }), c.pausar);
      expect(r.enviadas).toBe(1);
      expect(r.retidas).toBeUndefined();
      expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
      expect(c.spedy.criarNota.mock.calls[0][0].integrationId).toBe("conexa-1-100501");
      expect(c.linhas.get("conexa-1-100501")?.situacao).toBe("ENVIADA");
    });

    it("sem nada em espera a rodada é a de antes (nenhuma cobrança retida)", async () => {
      const c = cenario((id) => autorizada(id), [salaPrivativa(1), pronta(2)]);
      const r = await rodarEmissao(c.dep, config({ cautela: 0 }), c.pausar);
      expect(r.enviadas).toBe(2);
      expect(r.retidas).toBeUndefined();
    });

    it("⚠ nota liberada para tentar de novo, mas com o código ainda em espera, continua guardada", async () => {
      const c = cenario((id) => autorizada(id), [salaPrivativa(1)]);
      c.linhas.set("conexa-1-100501", {
        chave: "conexa-1-100501",
        cobrancaId: 1,
        empresa: "SEAHUB",
        codigo: "10.05.01",
        valorCentavos: 14900,
        competencia: "2026-10",
        situacao: SituacaoDaNota.RESERVADA,
        spedyId: "spedy-antiga",
        numero: null,
        motivo: null,
        tentativas: 0,
        enviadaEm: null,
      });
      const r = await rodarEmissao(c.dep, config({ cautela: 0, codigosEmEspera: ["10.05.01"] }), c.pausar);
      expect(r.retidas).toEqual([1]);
      expect(c.spedy.criarNota).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Nota NÃO emitida avisa a equipe e NÃO desliga a emissão (pedido de 09/10/2026)
  // -------------------------------------------------------------------------

  describe("o que desliga a emissão e o que só avisa", () => {
    const suporte = ["suporte@seahubcoworking.com.br"];

    it("⚠ passada a cautela, TRÊS rejeições da prefeitura NÃO desligam: ficam guardadas e avisadas, e as outras saem", async () => {
      const c = cenario((id) => (/conexa-[123]-/.test(id) ? rejeitada(id) : autorizada(id)), [1, 2, 3, 4, 5].map(pronta));
      const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
      c.dep.avisar = avisar;
      const cfg = config({ cautela: 0, soCobrancas: [1, 2, 3, 4, 5], emailsDeAviso: suporte });

      const r1 = await rodarEmissao(c.dep, cfg, c.pausar);
      expect(r1.enviadas).toBe(5);

      // A prefeitura só responde na rodada seguinte; é ali que as rejeições aparecem.
      const r2 = await rodarEmissao(c.dep, cfg, c.pausar);
      expect(r2.acompanhamento?.rejeitadas).toBe(3);
      expect(r2.pausada).toBeUndefined();
      expect(c.desligar).not.toHaveBeenCalled();
      expect(r2.aviso?.avisadas).toBe(3);
      expect(avisar.mock.calls[0][0].map((n) => n.situacao)).toEqual(["REJEITADA", "REJEITADA", "REJEITADA"]);
      expect(c.linhas.get("conexa-1-030302")?.situacao).toBe("REJEITADA");
      expect(c.linhas.get("conexa-4-030302")?.situacao).toBe("AUTORIZADA");
    });

    it("⚠ com três notas nossas autorizadas a cautela JÁ ACABOU: uma rejeição não desliga", async () => {
      const c = cenario((id) => rejeitada(id), [pronta(1)]);
      for (const n of [91, 92, 93]) {
        c.linhas.set(`conexa-${n}-030302`, {
          chave: `conexa-${n}-030302`,
          cobrancaId: n,
          empresa: "SEAHUB",
          codigo: "03.03.02",
          valorCentavos: 14900,
          competencia: "2026-10",
          situacao: SituacaoDaNota.AUTORIZADA,
          spedyId: `s-${n}`,
          numero: n,
          motivo: null, // ⚠ nota nossa autorizada tem motivo NULO: foi isso que a contagem real errava
          tentativas: 1,
          enviadaEm: new Date(),
        });
      }
      // A cautela é 3 (a de produção): com 3 nossas autorizadas ela terminou.
      const cfg = config({ cautela: 3, soCobrancas: [1] });
      const r = await rodarEmissao(c.dep, cfg, c.pausar);
      await rodarEmissao(c.dep, cfg, c.pausar);
      expect(r.enviadas).toBe(1);
      expect(c.desligar).not.toHaveBeenCalled();
      expect(c.linhas.get("conexa-1-030302")?.situacao).toBe("REJEITADA");
    });

    it("⚠ valor diferente do planejado desliga SEMPRE, mesmo passada a cautela: é nota fiscal errada", async () => {
      const c = cenario((id) => autorizada(id, 99.99), [1, 2].map(pronta));
      const cfg = config({ cautela: 0 });
      await rodarEmissao(c.dep, cfg, c.pausar);
      const r2 = await rodarEmissao(c.dep, cfg, c.pausar);
      expect(r2.pausada).toMatch(/^valor diferente do planejado: cobrança 1: a Spedy registrou R\$ 99,99/);
      expect(c.desligar).toHaveBeenCalledTimes(1);
    });

    it("três recusas da Spedy numa rodada desligam (chave, formato ou conta); duas não", async () => {
      const recusar = (c: ReturnType<typeof cenario>) =>
        c.spedy.criarNota.mockRejectedValue(new SpedyApiError(400, "dado inválido"));

      const tres = cenario((id) => autorizada(id), [1, 2, 3, 4].map(pronta));
      recusar(tres);
      const r = await rodarEmissao(tres.dep, config({ cautela: 0 }), tres.pausar);
      expect(r.pausada).toMatch(/^3 recusas da Spedy numa rodada/);
      expect(tres.desligar).toHaveBeenCalledTimes(1);
      expect(tres.spedy.criarNota).toHaveBeenCalledTimes(3);

      const duas = cenario((id) => autorizada(id), [1, 2].map(pronta));
      recusar(duas);
      const r2 = await rodarEmissao(duas.dep, config({ cautela: 0 }), duas.pausar);
      expect(r2.falhas).toBe(2);
      expect(r2.pausada).toBeUndefined();
      expect(duas.desligar).not.toHaveBeenCalled();
    });
  });

  describe("cobrança paga que não gerou nota avisa a equipe, uma vez", () => {
    const suporte = ["suporte@seahubcoworking.com.br"];
    const salaPrivativa = (n: number): LinhaPronta => ({
      ...pronta(n),
      notas: [{ ...nota(n), chave: `conexa-${n}-100501`, codigo: "10.05.01" }],
    });

    it("⚠ retida por código em espera: e-mail na primeira rodada, e nunca mais o mesmo", async () => {
      const c = cenario((id) => autorizada(id), [salaPrivativa(1), pronta(2)]);
      const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
      c.dep.avisar = avisar;
      const cfg = config({ cautela: 0, codigosEmEspera: ["10.05.01"], emailsDeAviso: suporte });

      const r1 = await rodarEmissao(c.dep, cfg, c.pausar);
      expect(r1.enviadas).toBe(1);
      expect(avisar).toHaveBeenCalledTimes(1);
      const [notas, destinos, semNota] = avisar.mock.calls[0];
      expect(notas).toEqual([]);
      expect(destinos).toEqual(suporte);
      expect(semNota).toEqual([
        {
          chave: "retida:1:10.05.01",
          cobrancaId: 1,
          empresa: "SEAHUB",
          valorCentavos: 14900,
          tipo: "retida",
          detalhe: expect.stringContaining("10.05.01"),
        },
      ]);

      await rodarEmissao(c.dep, cfg, c.pausar);
      await rodarEmissao(c.dep, cfg, c.pausar);
      expect(avisar).toHaveBeenCalledTimes(1);
    });

    it("sem destinatário na tela ela fica guardada, e o aviso sai quando houver um (nada se perde)", async () => {
      const c = cenario((id) => autorizada(id), [salaPrivativa(1)]);
      const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
      c.dep.avisar = avisar;

      const r1 = await rodarEmissao(c.dep, config({ cautela: 0, codigosEmEspera: ["10.05.01"] }), c.pausar);
      expect(r1.aviso).toMatchObject({ avisadas: 0, pendentes: 1, motivo: "sem destinatário na tela" });
      expect(avisar).not.toHaveBeenCalled();

      const r2 = await rodarEmissao(c.dep, config({ cautela: 0, codigosEmEspera: ["10.05.01"], emailsDeAviso: suporte }), c.pausar);
      expect(r2.aviso).toMatchObject({ avisadas: 1, pendentes: 0 });
      expect(avisar).toHaveBeenCalledTimes(1);
    });

    it("⚠ e-mail que NÃO saiu não é dado como dito: a cobrança retida volta no aviso seguinte", async () => {
      const c = cenario((id) => autorizada(id), [salaPrivativa(1)]);
      const avisar = vi.fn<Dependencias["avisar"]>().mockResolvedValueOnce("falhou").mockResolvedValue("enviado");
      c.dep.avisar = avisar;
      const cfg = config({ cautela: 0, codigosEmEspera: ["10.05.01"], emailsDeAviso: suporte });
      await rodarEmissao(c.dep, cfg, c.pausar);
      await rodarEmissao(c.dep, cfg, c.pausar);
      expect(avisar).toHaveBeenCalledTimes(2);
      expect(avisar.mock.calls[1][2]).toHaveLength(1);
    });

    it("paga e sem decisão (conferir, aguardando código) também é nota não emitida: avisa uma vez", async () => {
      const c = cenario((id) => autorizada(id), []);
      c.dep.semDecisao = async () => [
        { cobrancaId: 77, empresaId: 3, situacao: "CONFERIR", valorCentavos: 5000, motivo: "as vendas não somam a cobrança" },
        { cobrancaId: 78, empresaId: 4, situacao: "AGUARDANDO_CLASSIFICACAO", valorCentavos: 9000, motivo: "categoria 23 sem código" },
      ];
      const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
      c.dep.avisar = avisar;
      const cfg = lerConfigNotasFiscais({ emissao: { ligada: true, aPartirDe: "2026-10-08", cautela: 0, emailsDeAviso: suporte } });

      await rodarEmissao(c.dep, cfg, c.pausar);
      expect(avisar).toHaveBeenCalledTimes(1);
      expect(avisar.mock.calls[0][2]).toEqual([
        expect.objectContaining({ chave: "decisao:77:CONFERIR", tipo: "conferir", empresa: "SEAHUB", detalhe: "as vendas não somam a cobrança" }),
        expect.objectContaining({ chave: "decisao:78:AGUARDANDO_CLASSIFICACAO", tipo: "aguardando código", empresa: "SEATECH" }),
      ]);
      await rodarEmissao(c.dep, cfg, c.pausar);
      expect(avisar).toHaveBeenCalledTimes(1);
    });

    it("com lista de cobranças liberadas (primeira nota real) não avisa decisão: o resto não é para emitir mesmo", async () => {
      const c = cenario((id) => autorizada(id), []);
      const semDecisao = vi.fn(async () => []);
      c.dep.semDecisao = semDecisao;
      await rodarEmissao(c.dep, config({ cautela: 0, emailsDeAviso: suporte }), c.pausar);
      expect(semDecisao).not.toHaveBeenCalled();
    });

    it("com a emissão desligada ninguém é avisado de cobrança sem nota (tudo estaria sem nota)", async () => {
      const c = cenario((id) => autorizada(id), [salaPrivativa(1)]);
      const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
      c.dep.avisar = avisar;
      await rodarEmissao(c.dep, config({ ligada: false, codigosEmEspera: ["10.05.01"], emailsDeAviso: suporte }), c.pausar);
      expect(avisar).not.toHaveBeenCalled();
      expect(c.semNota.size).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Guardada para emitir depois do ajuste: "Tentar de novo"
// ---------------------------------------------------------------------------

describe("tentar de novo a nota rejeitada ou parada", () => {
  const rejeitar = async (c: ReturnType<typeof montar>) => {
    await enviarNota(c.dep, args);
    c.spedy.obterNota.mockResolvedValue({
      id: "spedy-1",
      integrationId: NOTA.chave,
      status: "rejected",
      number: null,
      processingDetail: { code: "E0903", message: "O tipo de operação deve ser informado." },
    });
    await acompanharNotas(c.dep);
  };

  it("⚠ a rejeitada volta à fila e a MESMA nota é reenviada, sem procurar antes e sem criar outra", async () => {
    const c = montar();
    await rejeitar(c);
    expect(c.linhas.get(NOTA.chave)?.situacao).toBe("REJEITADA");
    await avisarProblemas(c.dep, ["a@b.com"]);
    expect(c.avisadas.has(NOTA.chave)).toBe(true);

    expect(await liberarNotaParaNovaTentativa(c.dep.repo, NOTA.chave)).toEqual({ ok: true, situacaoAnterior: "REJEITADA" });
    expect(c.linhas.get(NOTA.chave)).toMatchObject({ situacao: "RESERVADA", motivo: null, tentativas: 0 });
    // O próximo problema desta nota volta a ser avisado.
    expect(c.avisadas.has(NOTA.chave)).toBe(false);

    c.spedy.criarNota.mockClear();
    c.spedy.buscarPorIntegrationId.mockClear();
    expect(await enviarNota(c.dep, args)).toBe("enviada");
    expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
    expect(c.spedy.criarNota.mock.calls[0][0].integrationId).toBe(NOTA.chave);
    // Sem tentativa anotada, não adota a nota rejeitada que a Spedy já tem: reenvia.
    expect(c.spedy.buscarPorIntegrationId).not.toHaveBeenCalled();
    expect(c.linhas.get(NOTA.chave)?.situacao).toBe("ENVIADA");
  });

  it("a nota parada por recusa da Spedy (FALHOU) também pode tentar de novo", async () => {
    const c = montar();
    c.spedy.criarNota.mockRejectedValueOnce(new SpedyApiError(400, "dado inválido"));
    expect(await enviarNota(c.dep, args)).toBe("falhou");
    expect(await liberarNotaParaNovaTentativa(c.dep.repo, NOTA.chave)).toEqual({ ok: true, situacaoAnterior: "FALHOU" });
    expect(await enviarNota(c.dep, args)).toBe("enviada");
  });

  it("⚠ só rejeitada ou parada: autorizada, na fila ou inexistente não são liberadas", async () => {
    const c = montar();
    await enviarNota(c.dep, args);
    expect(await liberarNotaParaNovaTentativa(c.dep.repo, NOTA.chave)).toEqual({
      ok: false,
      erro: expect.stringContaining('"enviada"'),
    });
    expect(await liberarNotaParaNovaTentativa(c.dep.repo, "conexa-1-nao-existe")).toEqual({
      ok: false,
      erro: "Não achei esta nota.",
    });
    expect(c.linhas.get(NOTA.chave)?.situacao).toBe("ENVIADA");
  });
});

describe("a cobrança ainda tem o que emitir?", () => {
  const notas = [{ chave: "a" }, { chave: "b" }];
  const linha = (situacao: SituacaoDaNota, motivo: string | null = null) => ({ situacao, motivo });

  it("sem linha, ou com linha que pode tentar de novo: sim", () => {
    expect(faltaEmitir(notas, new Map())).toBe(true);
    expect(faltaEmitir([{ chave: "a" }], new Map([["a", linha(SituacaoDaNota.RESERVADA)]]))).toBe(true);
    expect(faltaEmitir([{ chave: "a" }], new Map([["a", linha(SituacaoDaNota.INCERTA)]]))).toBe(true);
    expect(
      faltaEmitir([{ chave: "a" }], new Map([["a", linha(SituacaoDaNota.FALHOU, "Cadastro do cliente: CEP não existe")]])),
    ).toBe(true);
  });

  it("⚠ já autorizada, na fila, rejeitada ou recusada: não — senão ocupariam a leitura para sempre", () => {
    for (const situacao of [SituacaoDaNota.AUTORIZADA, SituacaoDaNota.ENVIADA, SituacaoDaNota.REJEITADA, SituacaoDaNota.CANCELADA]) {
      expect(faltaEmitir([{ chave: "a" }], new Map([["a", linha(situacao)]]))).toBe(false);
    }
    expect(faltaEmitir([{ chave: "a" }], new Map([["a", linha(SituacaoDaNota.FALHOU, "Spedy respondeu 400")]]))).toBe(false);
  });

  it("cobrança com duas notas: basta uma faltar", () => {
    const linhas = new Map([["a", linha(SituacaoDaNota.AUTORIZADA)]]);
    expect(faltaEmitir(notas, linhas)).toBe(true);
    linhas.set("b", linha(SituacaoDaNota.AUTORIZADA));
    expect(faltaEmitir(notas, linhas)).toBe(false);
  });
});
