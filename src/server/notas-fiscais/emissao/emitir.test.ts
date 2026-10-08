import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { SituacaoDaNota } from "@/generated/prisma/enums";
import { SpedyApiError, SpedyRedeError, type CorpoDeNota, type NotaDaSpedy } from "@/server/integrations/spedy/client";
import { lerConfigNotasFiscais } from "../config";
import {
  acompanharNotas,
  avisarProblemas,
  enviarNota,
  MARCA_DO_N8N,
  rodarEmissao,
  type Dependencias,
  type LinhaDaNota,
  type LinhaPronta,
  type Repositorio,
} from "./emitir";
import type { CepLido, Tomador } from "./regras";

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
  return { repo, linhas, avisadas };
}

function montar(extra: Partial<Dependencias> = {}) {
  const { repo, linhas, avisadas } = repositorioEmMemoria();
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
  return { dep, spedy, linhas, avisadas };
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
});
