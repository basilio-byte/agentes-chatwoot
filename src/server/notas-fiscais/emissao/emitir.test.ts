import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { SituacaoDaNota } from "@/generated/prisma/enums";
import { SpedyApiError, SpedyRedeError, type CorpoDeNota, type NotaDaSpedy } from "@/server/integrations/spedy/client";
import { lerConfigNotasFiscais } from "../config";
import {
  acompanharNotas,
  avisarProblemas,
  enviarNota,
  envioEmCurso,
  faltaEmitir,
  liberarNotaParaNovaTentativa,
  emitirNotasFiscais,
  MARCA_DO_N8N,
  notasForaDoPlano,
  ordenarParaARodada,
  reiniciarRelogioDaEmissao,
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
    // Como o banco: só muda a nota se ela ainda está como a rodada a leu.
    async reivindicar(chave, esperado, dados) {
      const l = linhas.get(chave);
      if (!l || l.situacao !== esperado.situacao || l.tentativas !== esperado.tentativas) return false;
      linhas.set(chave, { ...l, ...dados });
      if (dados.avisadaEm === null) avisadas.delete(chave);
      return true;
    },
    async vivasDaCobranca(cobrancaId) {
      return [...linhas.values()]
        .filter(
          (l) =>
            l.cobrancaId === cobrancaId &&
            (l.situacao === SituacaoDaNota.RESERVADA ||
              l.situacao === SituacaoDaNota.ENVIADA ||
              l.situacao === SituacaoDaNota.INCERTA ||
              l.situacao === SituacaoDaNota.AUTORIZADA),
        )
        .map((l) => ({ ...l }));
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
    async contarEmVoo(exceto) {
      return [...linhas.values()].filter(
        (l) => (l.situacao === SituacaoDaNota.ENVIADA || l.situacao === SituacaoDaNota.INCERTA) && l.chave !== exceto,
      ).length;
    },
  };
  return { repo, linhas, avisadas, semNota };
}

function montar(extra: Partial<Dependencias> = {}) {
  const { repo, linhas, avisadas, semNota } = repositorioEmMemoria();
  /** O relógio da rodada: o que mede "tentativa em curso" (ver `envioEmCurso`). */
  const relogio = { agora: new Date("2026-10-07T15:00:00Z") };
  const passar = (ms: number) => {
    relogio.agora = new Date(relogio.agora.getTime() + ms);
  };
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
    agora: () => new Date(relogio.agora),
    avisar: async () => "enviado",
    ...extra,
  };
  return { dep, spedy, linhas, avisadas, semNota, passar };
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

    // A nota tinha saído: a procura acha e NÃO manda de novo (passou o prazo da tentativa anterior).
    ctx.passar(5 * 60_000);
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
    ctx.passar(5 * 60_000); // a rodada seguinte
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
    expect(await enviarNota(c.dep, args)).toBe("cadastro");
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
    expect(await enviarNota(c.dep, args)).toBe("sem cliente");
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

  describe("⚠ duas rodadas olhando a mesma nota (o vigia no worker e o aviso do Conexa no web)", () => {
    /** A nota como o banco a guarda depois de "Tentar de novo". */
    const liberada = (c: ReturnType<typeof montar>, extra: Partial<LinhaDaNota> = {}) =>
      c.linhas.set(NOTA.chave, {
        chave: NOTA.chave,
        cobrancaId: 900,
        empresa: "SEATECH",
        codigo: NOTA.codigo,
        valorCentavos: NOTA.valorCentavos,
        competencia: NOTA.competencia,
        situacao: SituacaoDaNota.RESERVADA,
        spedyId: null,
        numero: null,
        motivo: null,
        tentativas: 0,
        enviadaEm: null,
        ...extra,
      });

    it("nota NOVA nas duas ao mesmo tempo: a chave única decide, e só uma manda", async () => {
      const resultados = await Promise.all([enviarNota(ctx.dep, args), enviarNota(ctx.dep, args)]);
      expect([...resultados].sort()).toEqual(["enviada", "ja existe"]);
      expect(ctx.spedy.criarNota).toHaveBeenCalledTimes(1);
    });

    it("nota JÁ reservada (liberada, ou cadastro corrigido) nas duas: a reivindicação decide, e só uma manda", async () => {
      liberada(ctx);
      const resultados = await Promise.all([enviarNota(ctx.dep, args), enviarNota(ctx.dep, args)]);
      expect([...resultados].sort()).toEqual(["em andamento", "enviada"]);
      expect(ctx.spedy.criarNota).toHaveBeenCalledTimes(1);
      expect(ctx.linhas.get(NOTA.chave)?.tentativas).toBe(1);
    });

    it("tentativa que outra rodada acabou de fazer (em curso) não é refeita; passado o prazo, é retomada procurando antes", async () => {
      liberada(ctx, { tentativas: 1, enviadaEm: new Date(ctx.dep.agora().getTime() - 10_000) });
      expect(await enviarNota(ctx.dep, args)).toBe("em andamento");
      expect(ctx.spedy.criarNota).not.toHaveBeenCalled();
      expect(ctx.spedy.buscarPorIntegrationId).not.toHaveBeenCalled();

      ctx.passar(3 * 60_000);
      expect(await enviarNota(ctx.dep, args)).toBe("enviada");
      // Havia tentativa anotada: procura na Spedy antes de mandar.
      expect(ctx.spedy.buscarPorIntegrationId).toHaveBeenCalledTimes(1);
      expect(ctx.spedy.criarNota).toHaveBeenCalledTimes(1);
    });

    it("⚠ a recusa que chega tarde NUNCA sobrescreve a nota que a outra rodada mandou e foi autorizada", async () => {
      ctx.dep.alertas = [];
      ctx.spedy.criarNota.mockImplementation(async () => {
        // Enquanto esta rodada esperava a Spedy, a outra mandou a mesma nota e a prefeitura autorizou.
        ctx.linhas.set(NOTA.chave, {
          ...ctx.linhas.get(NOTA.chave)!,
          situacao: SituacaoDaNota.AUTORIZADA,
          spedyId: "spedy-da-outra",
          numero: 2731,
        });
        throw new SpedyApiError(400, "SPD004: a nota já foi autorizada");
      });
      expect(await enviarNota(ctx.dep, args)).toBe("falhou");
      expect(ctx.linhas.get(NOTA.chave)).toMatchObject({ situacao: "AUTORIZADA", numero: 2731, spedyId: "spedy-da-outra" });
      // E não conta como recusa (três delas desligariam a emissão).
      expect(ctx.dep.alertas).toEqual([]);
    });

    it("⚠ o erro de rede que chega tarde também não desfaz a nota que a outra rodada mandou", async () => {
      ctx.spedy.criarNota.mockImplementation(async () => {
        ctx.linhas.set(NOTA.chave, { ...ctx.linhas.get(NOTA.chave)!, situacao: SituacaoDaNota.ENVIADA, spedyId: "spedy-da-outra" });
        throw new SpedyRedeError("timeout");
      });
      expect(await enviarNota(ctx.dep, args)).toBe("incerta");
      expect(ctx.linhas.get(NOTA.chave)).toMatchObject({ situacao: "ENVIADA", spedyId: "spedy-da-outra" });
    });
  });

  describe("a linha reaproveitada num reenvio", () => {
    it("⚠ ganha o valor do plano de AGORA (senão o acompanhamento desliga a emissão por 'valor diferente')", async () => {
      let cep: CepLido = { estado: "inexistente" };
      const c = montar({ cep: async () => cep });
      // A linha nasceu com R$ 100,00...
      await enviarNota(c.dep, { ...args, nota: { ...NOTA, valorCentavos: 10000 } });
      expect(c.linhas.get(NOTA.chave)?.valorCentavos).toBe(10000);
      // ...o plano passou a R$ 149,00 e o cadastro foi corrigido.
      cep = CEP_OK;
      expect(await enviarNota(c.dep, args)).toBe("enviada");
      expect(c.spedy.criarNota.mock.calls[0][0].total.invoiceAmount).toBe(149);
      expect(c.linhas.get(NOTA.chave)?.valorCentavos).toBe(14900);
    });

    it("⚠ a rejeição que vem DEPOIS de um aviso de cadastro volta a ser avisada", async () => {
      const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
      let cep: CepLido = { estado: "inexistente" };
      const c = montar({ avisar, cep: async () => cep });
      await enviarNota(c.dep, args);
      await avisarProblemas(c.dep, ["a@b.com"]);
      expect(avisar).toHaveBeenCalledTimes(1);
      expect(c.avisadas.has(NOTA.chave)).toBe(true);

      cep = CEP_OK; // a equipe corrigiu o cadastro e a nota saiu...
      expect(await enviarNota(c.dep, args)).toBe("enviada");
      c.spedy.obterNota.mockResolvedValue({
        id: "spedy-1",
        integrationId: NOTA.chave,
        status: "rejected",
        number: null,
        processingDetail: { code: "E0903", message: "O tipo de operação deve ser informado." },
      });
      await acompanharNotas(c.dep); // ...e a prefeitura rejeitou.
      expect(await avisarProblemas(c.dep, ["a@b.com"])).toEqual({ avisadas: 1, pendentes: 0 });
      expect(avisar).toHaveBeenCalledTimes(2);
      expect(avisar.mock.calls[1][0][0]).toMatchObject({ situacao: "REJEITADA", motivo: expect.stringContaining("E0903") });
    });

    it("cadastro que muda de problema é avisado de novo; o mesmo problema, não", async () => {
      const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
      let tomador: Tomador = { ...TOMADOR, cep: "590" }; // CEP sem 8 dígitos
      const c = montar({ avisar, tomador: async () => tomador });
      await enviarNota(c.dep, args);
      await avisarProblemas(c.dep, ["a@b.com"]);
      expect(avisar).toHaveBeenCalledTimes(1);

      // A mesma coisa na rodada seguinte: nada de novo a dizer.
      await enviarNota(c.dep, args);
      expect(await avisarProblemas(c.dep, ["a@b.com"])).toEqual({ avisadas: 0, pendentes: 0 });

      // Corrigiram o CEP, mas o documento também está errado: é outra notícia.
      tomador = { ...TOMADOR, documento: "123" };
      await enviarNota(c.dep, args);
      expect(await avisarProblemas(c.dep, ["a@b.com"])).toEqual({ avisadas: 1, pendentes: 0 });
      expect(avisar).toHaveBeenCalledTimes(2);
      expect(avisar.mock.calls[1][0][0].motivo).toContain("CPF/CNPJ");
    });
  });
});

describe("tentativa em curso", () => {
  const agora = new Date("2026-10-09T15:00:00Z");
  const haMs = (ms: number) => new Date(agora.getTime() - ms);

  it("reservada ou incerta com a última tentativa de segundos atrás: é outra rodada mandando", () => {
    expect(envioEmCurso({ situacao: SituacaoDaNota.RESERVADA, enviadaEm: haMs(10_000) }, agora)).toBe(true);
    expect(envioEmCurso({ situacao: SituacaoDaNota.INCERTA, enviadaEm: haMs(90_000) }, agora)).toBe(true);
  });

  it("passado o prazo, ou sem tentativa anotada (nota nova, liberada), não é", () => {
    expect(envioEmCurso({ situacao: SituacaoDaNota.RESERVADA, enviadaEm: haMs(3 * 60_000) }, agora)).toBe(false);
    expect(envioEmCurso({ situacao: SituacaoDaNota.RESERVADA, enviadaEm: null }, agora)).toBe(false);
  });

  it("só reservada e incerta: as outras situações nunca estão 'em curso'", () => {
    for (const situacao of [
      SituacaoDaNota.ENVIADA,
      SituacaoDaNota.AUTORIZADA,
      SituacaoDaNota.REJEITADA,
      SituacaoDaNota.FALHOU,
      SituacaoDaNota.CANCELADA,
    ]) {
      expect(envioEmCurso({ situacao, enviadaEm: haMs(1_000) }, agora), situacao).toBe(false);
    }
  });

  it("tentativa 'no futuro' (relógios diferentes) é tratada como em curso: na dúvida, não manda", () => {
    expect(envioEmCurso({ situacao: SituacaoDaNota.RESERVADA, enviadaEm: new Date(agora.getTime() + 5_000) }, agora)).toBe(true);
  });
});

describe("notas vivas fora do plano", () => {
  const plano = [{ chave: "conexa-1-030302" }, { chave: "conexa-1-100501" }];

  it("as vivas que o plano prevê não contam", () => {
    expect(notasForaDoPlano([{ chave: "conexa-1-030302" }], plano)).toEqual([]);
    expect(notasForaDoPlano([], plano)).toEqual([]);
    expect(notasForaDoPlano([{ chave: "conexa-1-030302" }, { chave: "conexa-1-100501" }], plano)).toEqual([]);
  });

  it("⚠ a que o plano NÃO prevê (o código mudou depois de a nota sair) aparece", () => {
    const fora = notasForaDoPlano([{ chave: "conexa-1-030302" }, { chave: "conexa-1-110401" }], plano);
    expect(fora).toEqual([{ chave: "conexa-1-110401" }]);
  });
});

describe("a ordem em que a rodada olha as cobranças", () => {
  const cobranca = (id: number) => ({ id, notas: [{ chave: `conexa-${id}-030302` }] });
  const linha = (minutosAtras: number | null) => ({
    verificadaEm: minutosAtras == null ? null : new Date(Date.UTC(2026, 9, 9, 15, 0) - minutosAtras * 60_000),
  });

  it("⚠ as NOVAS vão primeiro, na ordem de chegada; as presas depois, a olhada há mais tempo na frente", () => {
    const candidatas = [1, 2, 3, 4, 5, 6].map(cobranca); // por data de criação
    const linhas = new Map([
      ["conexa-1-030302", linha(5)], // presa, olhada há 5 min
      ["conexa-3-030302", linha(60)], // presa, olhada há 1 h (a mais esquecida)
      ["conexa-4-030302", linha(null)], // presa, nunca registrou a verificação
    ]);
    expect(ordenarParaARodada(candidatas, linhas).map((c) => c.id)).toEqual([2, 5, 6, 4, 3, 1]);
  });

  it("sem nenhuma presa, a ordem de chegada é mantida", () => {
    const candidatas = [3, 1, 2].map(cobranca);
    expect(ordenarParaARodada(candidatas, new Map()).map((c) => c.id)).toEqual([3, 1, 2]);
  });

  it("a cobrança com várias notas vale pela olhada mais RECENTE de qualquer uma delas", () => {
    const duas = { id: 7, notas: [{ chave: "a" }, { chave: "b" }] };
    const outra = cobranca(8);
    const linhas = new Map([
      ["a", linha(120)],
      ["b", linha(2)], // a cobrança 7 foi olhada há 2 min por causa desta
      ["conexa-8-030302", linha(30)],
    ]);
    expect(ordenarParaARodada([duas, outra], linhas).map((c) => c.id)).toEqual([8, 7]);
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
  // O módulo guarda em memória as cobranças de molho: cada caso começa limpo.
  beforeEach(() => reiniciarRelogioDaEmissao());
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

    it("⚠ cobrança paga e cobrança gerada (cliente antes) levam o tipo de cada momento da configuração", async () => {
      const c = cenario((id) => autorizada(id), [sala(1, "quitada"), sala(2, "gerada"), sala(3), pronta(4)]);
      const r = await rodarEmissao(c.dep, config({ cautela: 0, soCobrancas: [1, 2, 3, 4] }), c.pausar);
      expect(r.enviadas).toBe(4);
      const corpos = new Map(c.spedy.criarNota.mock.calls.map(([corpo]) => [corpo.integrationId, corpo]));
      // O padrão é a última resposta do Laércio ("opção 1 e 4"): quitação = 1, geração = 4.
      expect(corpos.get("conexa-1-100501")?.ibsCbs).toEqual({ operationType: "supplyWithSubsequentPayment" });
      expect(corpos.get("conexa-2-100501")?.ibsCbs).toEqual({ operationType: "paymentReceivedBeforeSupply" });
      // Sem evento gravado, vale a quitação, que é o padrão.
      expect(corpos.get("conexa-3-100501")?.ibsCbs).toEqual({ operationType: "supplyWithSubsequentPayment" });
      // A nota comum não muda.
      expect(corpos.get("conexa-4-030302")).not.toHaveProperty("ibsCbs");
    });

    it("⚠ trocar o tipo na configuração vale na rodada seguinte, sem publicar nada", async () => {
      const c = cenario((id) => autorizada(id), [sala(1, "quitada"), sala(2, "gerada")]);
      await rodarEmissao(
        c.dep,
        config({
          cautela: 0,
          soCobrancas: [1, 2],
          tipoDeOperacao: { quitacao: "simultaneousSupplyAndPayment", geracao: "supplyWithSubsequentPayment" },
        }),
        c.pausar,
      );
      const corpos = new Map(c.spedy.criarNota.mock.calls.map(([corpo]) => [corpo.integrationId, corpo]));
      expect(corpos.get("conexa-1-100501")?.ibsCbs).toEqual({ operationType: "simultaneousSupplyAndPayment" });
      expect(corpos.get("conexa-2-100501")?.ibsCbs).toEqual({ operationType: "supplyWithSubsequentPayment" });
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
        ibsCbs: { operationType: "supplyWithSubsequentPayment" },
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
      // ⚠ COM corte: é só a lista liberada que barra (sem corte, a outra metade da guarda já barraria).
      await rodarEmissao(c.dep, config({ cautela: 0, aPartirDe: "2026-10-08", soCobrancas: [1], emailsDeAviso: suporte }), c.pausar);
      expect(semDecisao).not.toHaveBeenCalled();
    });

    it("com corte e sem lista liberada, as duas metades da guarda deixam passar: a decisão é lida", async () => {
      const c = cenario((id) => autorizada(id), []);
      const semDecisao = vi.fn(async () => []);
      c.dep.semDecisao = semDecisao;
      await rodarEmissao(c.dep, config({ cautela: 0, aPartirDe: "2026-10-08", soCobrancas: [], emailsDeAviso: suporte }), c.pausar);
      expect(semDecisao).toHaveBeenCalledTimes(1);
      expect(semDecisao).toHaveBeenCalledWith("2026-10-08");
    });

    it("sem corte e sem lista (nada é para emitir), a decisão não é lida", async () => {
      const c = cenario((id) => autorizada(id), []);
      const semDecisao = vi.fn(async () => []);
      c.dep.semDecisao = semDecisao;
      await rodarEmissao(c.dep, config({ cautela: 0, aPartirDe: null, soCobrancas: [], emailsDeAviso: suporte }), c.pausar);
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

  // -------------------------------------------------------------------------
  // O plano mudou depois de uma nota sair: nada em dobro (revisão de 09/10/2026)
  // -------------------------------------------------------------------------

  describe("⚠ o plano mudou depois de uma nota sair: a cobrança NÃO é emitida de novo", () => {
    const suporte = ["suporte@seahubcoworking.com.br"];
    /** A nota que saiu quando o código da categoria era outro (a chave leva o código). */
    const notaAntiga = (n: number, situacao: SituacaoDaNota, codigo = "11.04.01"): LinhaDaNota => ({
      chave: `conexa-${n}-${codigo.replace(/\./g, "")}`,
      cobrancaId: n,
      empresa: "SEAHUB",
      codigo,
      valorCentavos: 14900,
      competencia: "2026-10",
      situacao,
      spedyId: `s-${n}`,
      numero: situacao === SituacaoDaNota.AUTORIZADA ? 2700 + n : null,
      motivo: null,
      tentativas: 1,
      enviadaEm: new Date("2026-10-01T12:00:00Z"),
    });

    it("com nota AUTORIZADA de outro código: nada é emitido dela, a equipe é avisada UMA vez e as outras seguem", async () => {
      const c = cenario((id) => autorizada(id), [pronta(1), pronta(2)]);
      c.linhas.set("conexa-1-110401", notaAntiga(1, SituacaoDaNota.AUTORIZADA));
      const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
      c.dep.avisar = avisar;
      const cfg = config({ cautela: 0, emailsDeAviso: suporte });

      const r = await rodarEmissao(c.dep, cfg, c.pausar);
      expect(r.planoMudou).toEqual([1]);
      expect(r.enviadas).toBe(1);
      expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
      expect(c.spedy.criarNota.mock.calls[0][0].integrationId).toBe("conexa-2-030302");
      expect(c.linhas.has("conexa-1-030302")).toBe(false);
      expect(avisar).toHaveBeenCalledTimes(1);
      expect(avisar.mock.calls[0][2]).toEqual([
        expect.objectContaining({
          chave: "plano:1:conexa-1-110401",
          cobrancaId: 1,
          empresa: "SEAHUB",
          tipo: "plano mudou",
          detalhe: expect.stringMatching(/conexa-1-110401 \(11\.04\.01, autorizada, nº 2701\).*conexa-1-030302/),
        }),
      ]);

      await rodarEmissao(c.dep, cfg, c.pausar);
      await rodarEmissao(c.dep, cfg, c.pausar);
      expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
      expect(avisar).toHaveBeenCalledTimes(1);
    });

    it.each([SituacaoDaNota.RESERVADA, SituacaoDaNota.ENVIADA, SituacaoDaNota.INCERTA])(
      "com nota %s de outro código também segura (ela pode já estar na prefeitura)",
      async (situacao) => {
        const c = cenario((id) => naFila(id), [pronta(1)]);
        c.linhas.set("conexa-1-110401", notaAntiga(1, situacao));
        const r = await rodarEmissao(c.dep, config({ cautela: 0 }), c.pausar);
        expect(r.planoMudou).toEqual([1]);
        expect(c.spedy.criarNota).not.toHaveBeenCalled();
        expect(c.linhas.has("conexa-1-030302")).toBe(false);
      },
    );

    it.each([SituacaoDaNota.REJEITADA, SituacaoDaNota.FALHOU, SituacaoDaNota.CANCELADA])(
      "com nota antiga só %s NÃO segura: o plano novo sai (é assim que o código corrigido faz a nota sair)",
      async (situacao) => {
        const c = cenario((id) => autorizada(id), [pronta(1)]);
        c.linhas.set("conexa-1-110401", notaAntiga(1, situacao));
        const r = await rodarEmissao(c.dep, config({ cautela: 0 }), c.pausar);
        expect(r.planoMudou).toBeUndefined();
        expect(r.enviadas).toBe(1);
        expect(c.spedy.criarNota.mock.calls[0][0].integrationId).toBe("conexa-1-030302");
      },
    );

    it("cobrança com duas notas no plano e uma já autorizada: a outra sai (é irmã, está no plano)", async () => {
      const mista: LinhaPronta = {
        ...pronta(1),
        notas: [nota(1), { ...nota(1), chave: "conexa-1-100501", codigo: "10.05.01" }],
      };
      const c = cenario((id) => autorizada(id), [mista]);
      c.linhas.set("conexa-1-030302", notaAntiga(1, SituacaoDaNota.AUTORIZADA, "03.03.02"));
      const r = await rodarEmissao(c.dep, config({ cautela: 0 }), c.pausar);
      expect(r.planoMudou).toBeUndefined();
      expect(r.enviadas).toBe(1);
      expect(c.spedy.criarNota.mock.calls[0][0].integrationId).toBe("conexa-1-100501");
    });

    it("com o código ainda em espera a espera vale primeiro (sem aviso de plano mudado)", async () => {
      const c = cenario((id) => autorizada(id), [{ ...pronta(1), notas: [{ ...nota(1), chave: "conexa-1-100501", codigo: "10.05.01" }] }]);
      c.linhas.set("conexa-1-030302", notaAntiga(1, SituacaoDaNota.AUTORIZADA, "03.03.02"));
      const r = await rodarEmissao(c.dep, config({ cautela: 0, codigosEmEspera: ["10.05.01"] }), c.pausar);
      expect(r.retidas).toEqual([1]);
      expect(r.planoMudou).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Cadastro preso não pode esconder as cobranças novas (revisão de 09/10/2026)
  // -------------------------------------------------------------------------

  describe("⚠ o que não chega à Spedy não gasta as vagas das notas novas", () => {
    /** Cobrança cujo cliente (`clienteId` < 2000) tem o cadastro ruim: sem CPF/CNPJ. */
    const comCadastroRuim = (n: number): LinhaPronta => ({ ...pronta(n), clienteId: 1000 + n });
    const boa = (n: number): LinhaPronta => ({ ...pronta(n), clienteId: 2000 + n });
    const tomadorPorCliente = async (clienteId: number): Promise<Tomador> =>
      clienteId < 2000 ? { ...TOMADOR, documento: "" } : TOMADOR;
    const todas = (...grupos: LinhaPronta[][]) => grupos.flat().map((l) => l.cobrancaId);

    it("cinco presas na frente de dez notas boas: as dez saem (antes só saíam cinco)", async () => {
      const presas = [100, 101, 102, 103, 104].map(comCadastroRuim);
      const boas = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(boa);
      const c = cenario((id) => autorizada(id), [...presas, ...boas]);
      c.dep.tomador = tomadorPorCliente;
      const r = await rodarEmissao(c.dep, config({ cautela: 0, soCobrancas: todas(presas, boas) }), c.pausar);
      expect(r.enviadas).toBe(10);
      expect(r.falhas).toBe(5);
      expect(c.spedy.criarNota).toHaveBeenCalledTimes(10);
    });

    it("doze presas depois de uma nota boa: a boa sai e só dez presas são tentadas (as outras esperam a próxima rodada)", async () => {
      const presas = Array.from({ length: 12 }, (_, i) => comCadastroRuim(20 + i)); // 20..31
      const nova = boa(1);
      const c = cenario((id) => autorizada(id), [nova, ...presas]);
      c.dep.tomador = tomadorPorCliente;
      const r = await rodarEmissao(c.dep, config({ cautela: 0, soCobrancas: todas([nova], presas) }), c.pausar);
      expect(r.enviadas).toBe(1);
      expect(r.falhas).toBe(10);
      expect(c.linhas.get("conexa-1-030302")?.situacao).toBe("ENVIADA");
      expect(c.linhas.has("conexa-29-030302")).toBe(true);
      expect(c.linhas.has("conexa-30-030302")).toBe(false);
      expect(c.linhas.has("conexa-31-030302")).toBe(false);
    });

    it("cliente que o Conexa não devolve também não gasta vaga de nota nova", async () => {
      const sumidas = [100, 101].map(comCadastroRuim);
      const boas = [1, 2].map(boa);
      const c = cenario((id) => autorizada(id), [...sumidas, ...boas]);
      c.dep.tomador = async (clienteId) => (clienteId < 2000 ? null : TOMADOR);
      const r = await rodarEmissao(c.dep, config({ cautela: 0, soCobrancas: todas(sumidas, boas) }), c.pausar);
      expect(r.enviadas).toBe(2);
      expect(r.adiadas).toBe(2);
      expect(c.linhas.has("conexa-100-030302")).toBe(false);
    });

    it("sem a chave da empresa nada chega à Spedy, e a rodada diz de qual empresa falta", async () => {
      const c = cenario((id) => autorizada(id), [1, 2].map(boa));
      c.dep.spedy = () => null;
      const r = await rodarEmissao(c.dep, config({ cautela: 0 }), c.pausar);
      expect(r.enviadas).toBe(0);
      expect(r.semChave).toEqual(["SEAHUB"]);
    });

    it("⚠ doze clientes que o Conexa não devolve à frente de uma boa: o teto vale, e a rodada seguinte não os relê — a boa sai", async () => {
      const sumidas = Array.from({ length: 12 }, (_, i) => comCadastroRuim(100 + i));
      const nova = boa(1);
      const c = cenario((id) => autorizada(id), [...sumidas, nova]);
      const olhados: number[] = [];
      c.dep.tomador = async (clienteId) => {
        olhados.push(clienteId);
        return clienteId < 2000 ? null : TOMADOR;
      };
      const cfg = config({ cautela: 0, soCobrancas: todas(sumidas, [nova]) });
      const r1 = await rodarEmissao(c.dep, cfg, c.pausar);
      expect(r1.adiadas).toBe(10); // o teto de tentativas sem envio
      expect(r1.enviadas).toBe(0);
      olhados.length = 0;
      const r2 = await rodarEmissao(c.dep, cfg, c.pausar);
      // As dez já olhadas ficam de molho; só as duas que sobraram e a boa são olhadas.
      expect(olhados.sort()).toEqual([1110, 1111, 2001].sort());
      expect(r2.enviadas).toBe(1);
      expect(c.linhas.get("conexa-1-030302")?.situacao).toBe("ENVIADA");
    });

    it("⚠ sem a chave de uma empresa, as cobranças da OUTRA saem e a sem chave não gasta o teto", async () => {
      const seatech = (n: number): LinhaPronta => ({ ...boa(n), empresaId: 4 });
      const semChave = Array.from({ length: 12 }, (_, i) => seatech(100 + i));
      const nova = boa(1);
      const c = cenario((id) => autorizada(id), [...semChave, nova]);
      c.dep.spedy = (empresa) => (empresa === "SEATECH" ? null : c.spedy);
      const r = await rodarEmissao(c.dep, config({ cautela: 0, soCobrancas: todas(semChave, [nova]) }), c.pausar);
      expect(r.semChave).toEqual(["SEATECH"]);
      expect(r.enviadas).toBe(1);
      expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // A emissão que se desliga sozinha avisa (antes só ficava na tela)
  // -------------------------------------------------------------------------

  describe("⚠ a emissão que se desliga sozinha avisa a equipe por e-mail", () => {
    const suporte = ["suporte@seahubcoworking.com.br"];

    it("valor diferente do planejado: o e-mail leva a pausa e o motivo, mesmo sem nenhuma nota com problema", async () => {
      const c = cenario((id) => autorizada(id, 99.99), [1, 2].map(pronta));
      const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
      c.dep.avisar = avisar;
      const cfg = config({ cautela: 0, emailsDeAviso: suporte });

      await rodarEmissao(c.dep, cfg, c.pausar); // manda as duas
      expect(avisar).not.toHaveBeenCalled();
      const r2 = await rodarEmissao(c.dep, cfg, c.pausar); // a conferência acha a divergência
      expect(r2.pausada).toMatch(/^valor diferente do planejado/);
      expect(c.desligar).toHaveBeenCalledTimes(1);

      expect(avisar).toHaveBeenCalledTimes(1);
      const [notas, destinos, semNota] = avisar.mock.calls[0];
      expect(notas).toEqual([]);
      expect(destinos).toEqual(suporte);
      expect(semNota).toEqual([
        expect.objectContaining({
          chave: expect.stringMatching(/^pausa:2026-10-07T15:00/),
          tipo: "pausada",
          detalhe: expect.stringContaining("99,99"),
        }),
      ]);
    });

    it("na cautela, a rejeição que desliga manda UM e-mail com a nota rejeitada E o aviso da pausa", async () => {
      const c = cenario((id) => rejeitada(id), [1, 2, 3].map(pronta));
      const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
      c.dep.avisar = avisar;
      const r = await rodarEmissao(c.dep, config({ emailsDeAviso: suporte }), c.pausar);
      expect(r.pausada).toMatch(/nas primeiras notas/);
      expect(avisar).toHaveBeenCalledTimes(1);
      const [notas, , semNota] = avisar.mock.calls[0];
      expect(notas).toEqual([expect.objectContaining({ situacao: "REJEITADA", cobrancaId: 1 })]);
      expect(semNota).toEqual([expect.objectContaining({ tipo: "pausada" })]);
    });

    it("e-mail da pausa que NÃO saiu continua pendente (nada de pausa em silêncio)", async () => {
      const c = cenario((id) => autorizada(id, 99.99), [1, 2].map(pronta));
      const avisar = vi.fn<Dependencias["avisar"]>().mockResolvedValueOnce("falhou").mockResolvedValue("enviado");
      c.dep.avisar = avisar;
      const cfg = config({ cautela: 0, emailsDeAviso: suporte });
      await rodarEmissao(c.dep, cfg, c.pausar);
      await rodarEmissao(c.dep, cfg, c.pausar); // pausa, e o e-mail falha
      // Desligada, a emissão só acompanha e tenta avisar de novo.
      const desligada = config({ cautela: 0, ligada: false, emailsDeAviso: suporte });
      await rodarEmissao(c.dep, desligada, c.pausar);
      expect(avisar).toHaveBeenCalledTimes(2);
      expect(avisar.mock.calls[1][2]).toEqual([expect.objectContaining({ tipo: "pausada" })]);
    });
  });

  it("⚠ na cautela, a nota INCERTA que a rodada vai reenviar não trava o próprio reenvio", async () => {
    const c = cenario((id) => autorizada(id), [pronta(1)]);
    c.linhas.set("conexa-1-030302", {
      chave: "conexa-1-030302",
      cobrancaId: 1,
      empresa: "SEAHUB",
      codigo: "03.03.02",
      valorCentavos: 14900,
      competencia: "2026-10",
      situacao: SituacaoDaNota.INCERTA,
      spedyId: null,
      numero: null,
      motivo: "o envio não teve resposta (timeout)",
      tentativas: 1,
      enviadaEm: new Date("2026-10-07T14:00:00Z"), // uma hora antes do relógio do teste
    });
    const r = await rodarEmissao(c.dep, config({ cautela: 2, soCobrancas: [1] }), c.pausar);
    expect(r.aguardando).toBeUndefined();
    expect(r.enviadas).toBe(1);
    expect(c.spedy.criarNota).toHaveBeenCalledTimes(1);
  });
});

describe("a rodada não começa duas vezes ao mesmo tempo", () => {
  beforeEach(() => reiniciarRelogioDaEmissao());

  it("⚠ dois avisos quase juntos: o segundo vê a rodada em andamento ANTES de qualquer espera", async () => {
    const { db } = (await import("@/lib/db")) as unknown as { db: Record<string, unknown> };
    // A configuração vem do banco: é essa leitura que deixava a janela aberta.
    db.integration = { findUnique: vi.fn(async () => ({ enabled: true, config: { emissao: { ligada: true } } })) };
    const c = montar({ prontas: async () => [] });
    const iniciar = () =>
      emitirNotasFiscais(new Date("2026-10-09T15:00:00Z"), { forcar: true, dependencias: c.dep, pausar: async () => {} });
    const [a, b] = await Promise.all([iniciar(), iniciar()]);
    expect([a.acao, b.acao].sort()).toEqual(["em andamento", "emitido"]);
    // Terminada a primeira, a trava se solta.
    expect((await iniciar()).acao).toBe("emitido");
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

  it.each([
    SituacaoDaNota.RESERVADA,
    SituacaoDaNota.ENVIADA,
    SituacaoDaNota.INCERTA,
    SituacaoDaNota.AUTORIZADA,
    SituacaoDaNota.CANCELADA,
  ])("⚠ nota %s NÃO é liberada (liberar a autorizada ou a incerta reenviaria uma nota que pode já existir)", async (situacao) => {
    const c = montar();
    c.linhas.set(NOTA.chave, {
      chave: NOTA.chave,
      cobrancaId: 900,
      empresa: "SEATECH",
      codigo: NOTA.codigo,
      valorCentavos: NOTA.valorCentavos,
      competencia: NOTA.competencia,
      situacao,
      spedyId: "s-1",
      numero: situacao === SituacaoDaNota.AUTORIZADA ? 2700 : null,
      motivo: null,
      tentativas: 1,
      enviadaEm: null,
    });
    expect(await liberarNotaParaNovaTentativa(c.dep.repo, NOTA.chave)).toEqual({
      ok: false,
      erro: expect.stringContaining(`"${situacao.toLowerCase()}"`),
    });
    expect(c.linhas.get(NOTA.chave)).toMatchObject({ situacao, tentativas: 1 });
  });

  it("⚠ ao liberar, a nota deixa de parecer 'em curso' (sem tentativa anotada) e zera o aviso", async () => {
    const c = montar();
    c.linhas.set(NOTA.chave, {
      chave: NOTA.chave,
      cobrancaId: 900,
      empresa: "SEATECH",
      codigo: NOTA.codigo,
      valorCentavos: NOTA.valorCentavos,
      competencia: NOTA.competencia,
      situacao: SituacaoDaNota.REJEITADA,
      spedyId: "s-1",
      numero: null,
      motivo: "E0903",
      tentativas: 1,
      enviadaEm: new Date(c.dep.agora().getTime() - 5_000), // rejeitada há segundos
    });
    await liberarNotaParaNovaTentativa(c.dep.repo, NOTA.chave);
    expect(c.linhas.get(NOTA.chave)).toMatchObject({ situacao: "RESERVADA", tentativas: 0, motivo: null, enviadaEm: null });
    // Libera e manda na hora, sem esperar o prazo da tentativa anterior.
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
