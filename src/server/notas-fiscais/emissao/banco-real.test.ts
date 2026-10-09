import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A emissão contra um Postgres de VERDADE — opt-in, e pulado quando a variável não existe.
 *
 * Os outros testes desta pasta usam um repositório em memória ou um `db` de mentira, e foi
 * por isso que dois defeitos de produção passaram por eles em 09/10/2026 (a contagem de
 * notas autorizadas devolvia 0 por causa de `NOT startsWith` com NULL, e a leitura das 200
 * mais antigas escondia as novas). O que o SQL faz com NULL, ordem, `updateMany` e enum só se
 * vê no banco.
 *
 * Como rodar (o banco TEM de ter "teste" no nome: as tabelas são esvaziadas a cada caso):
 *
 *   docker exec seahub-agentes-postgres psql -U seahub -d postgres -c "create database nf_teste"
 *   DATABASE_URL=<url do nf_teste> npx prisma migrate deploy
 *   NF_BANCO_DE_TESTE=<url do nf_teste> npx vitest run src/server/notas-fiscais/emissao/banco-real.test.ts
 */
const base = vi.hoisted(() => {
  const url = process.env.NF_BANCO_DE_TESTE ?? "";
  return { url, pode: /\/[^/?]*teste[^/?]*(\?|$)/.test(url) };
});

vi.mock("@/lib/db", async () => {
  if (!base.pode) return { db: {} };
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("@/generated/prisma/client");
  return { db: new PrismaClient({ adapter: new PrismaPg({ connectionString: base.url }) }) };
});

import { SituacaoDaNota } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { lerConfigNotasFiscais } from "../config";
import { reclassificar } from "../conferir";
import { lerCobranca } from "../regras";
import {
  cobrancasRetidas,
  dependenciasReais,
  MARCA_DO_N8N,
  PROVIDER_SEM_NOTA,
  prontasDoBanco,
  repositorioReal,
  rodarEmissao,
  type Dependencias,
} from "./emitir";
import type { NotaDaSpedy } from "@/server/integrations/spedy/client";
import type { Tomador } from "./regras";

const AGORA = new Date("2026-10-09T15:00:00Z");
const cfg = (emissao: Record<string, unknown> = {}) =>
  lerConfigNotasFiscais({ emissao: { ligada: true, aPartirDe: "2026-10-08", ...emissao } });

describe.skipIf(!base.pode)("a emissão contra o Postgres de verdade", () => {
  beforeEach(async () => {
    await db.notaFiscalEmitida.deleteMany();
    await db.cobrancaFiscal.deleteMany();
    await db.webhookEvent.deleteMany({ where: { provider: PROVIDER_SEM_NOTA } });
  });

  const cobranca = (id: number, extra: Record<string, unknown> = {}) =>
    db.cobrancaFiscal.create({
      data: {
        cobrancaId: id,
        empresaId: 3,
        clienteId: 1000 + id,
        evento: "quitada",
        modo: "sombra",
        quitadaEm: "2026-10-09",
        valorCentavos: 14900,
        situacao: "PRONTA",
        cobranca: {},
        itens: [],
        notas: [{ chave: `conexa-${id}-030302`, codigo: "03.03.02", valorCentavos: 14900, descricao: "x", competencia: "2026-10", vendas: [1] }],
        // O momento em que a cobrança entrou: dá a ordem de chegada.
        criadaEm: new Date(AGORA.getTime() - (1000 - id) * 60_000),
        ...extra,
      },
    });

  const nota = (id: number, situacao: SituacaoDaNota, extra: Record<string, unknown> = {}) =>
    db.notaFiscalEmitida.create({
      data: {
        chave: `conexa-${id}-030302`,
        cobrancaId: id,
        empresa: "SEAHUB",
        codigo: "03.03.02",
        valorCentavos: 14900,
        competencia: "2026-10",
        situacao,
        ...extra,
      },
    });

  describe("reivindicar a nota", () => {
    it("⚠ oito rodadas ao mesmo tempo, UMA só ganha (a trava entre o worker e o web)", async () => {
      await nota(1, SituacaoDaNota.RESERVADA, { tentativas: 0 });
      const repo = repositorioReal();
      const resultados = await Promise.all(
        Array.from({ length: 8 }, () =>
          repo.reivindicar("conexa-1-030302", { situacao: SituacaoDaNota.RESERVADA, tentativas: 0 }, { tentativas: 1, enviadaEm: AGORA, avisadaEm: null }),
        ),
      );
      expect(resultados.filter(Boolean)).toHaveLength(1);
      const linha = await db.notaFiscalEmitida.findUnique({ where: { chave: "conexa-1-030302" } });
      expect(linha).toMatchObject({ tentativas: 1, situacao: "RESERVADA" });
      expect(linha?.verificadaEm).toBeInstanceOf(Date);
    });

    it("estado diferente do lido: não muda nada e devolve false", async () => {
      await nota(1, SituacaoDaNota.AUTORIZADA, { tentativas: 1, numero: 2700 });
      const ok = await repositorioReal().reivindicar(
        "conexa-1-030302",
        { situacao: SituacaoDaNota.RESERVADA, tentativas: 1 },
        { situacao: SituacaoDaNota.FALHOU, motivo: "tarde demais" },
      );
      expect(ok).toBe(false);
      expect(await db.notaFiscalEmitida.findUnique({ where: { chave: "conexa-1-030302" } })).toMatchObject({
        situacao: "AUTORIZADA",
        motivo: null,
        numero: 2700,
      });
    });

    it("chave que não existe: false, sem erro", async () => {
      expect(await repositorioReal().reivindicar("conexa-9-030302", { situacao: SituacaoDaNota.RESERVADA, tentativas: 0 }, { tentativas: 1 })).toBe(false);
    });
  });

  describe("contar", () => {
    it("⚠ autorizadas NOSSAS: o motivo é NULO e o NOT startsWith do SQL as perderia (o defeito que prendia a cautela)", async () => {
      await nota(1, SituacaoDaNota.AUTORIZADA, { numero: 1 });
      await nota(2, SituacaoDaNota.AUTORIZADA, { numero: 2 });
      await nota(3, SituacaoDaNota.AUTORIZADA, { numero: 3 });
      await nota(4, SituacaoDaNota.AUTORIZADA, { motivo: `${MARCA_DO_N8N} antes do corte` });
      await nota(5, SituacaoDaNota.REJEITADA);
      expect(await repositorioReal().contarAutorizadas()).toBe(3);
    });

    it("em voo: enviada e incerta, sem a nota que a rodada vai mandar", async () => {
      await nota(1, SituacaoDaNota.ENVIADA);
      await nota(2, SituacaoDaNota.INCERTA);
      await nota(3, SituacaoDaNota.AUTORIZADA);
      await nota(4, SituacaoDaNota.RESERVADA);
      const repo = repositorioReal();
      expect(await repo.contarEmVoo()).toBe(2);
      expect(await repo.contarEmVoo("conexa-2-030302")).toBe(1);
    });
  });

  describe("as notas vivas da cobrança", () => {
    it("reservada, enviada, incerta e autorizada; rejeitada, parada e cancelada não", async () => {
      const situacoes = [
        SituacaoDaNota.RESERVADA,
        SituacaoDaNota.ENVIADA,
        SituacaoDaNota.INCERTA,
        SituacaoDaNota.AUTORIZADA,
        SituacaoDaNota.REJEITADA,
        SituacaoDaNota.FALHOU,
        SituacaoDaNota.CANCELADA,
      ];
      for (const [i, situacao] of situacoes.entries()) {
        await db.notaFiscalEmitida.create({
          data: { chave: `conexa-7-${i}`, cobrancaId: 7, empresa: "SEAHUB", codigo: "03.03.02", valorCentavos: 100, situacao },
        });
      }
      await nota(8, SituacaoDaNota.AUTORIZADA); // de outra cobrança
      const vivas = await repositorioReal().vivasDaCobranca(7);
      expect(vivas.map((v) => v.situacao).sort()).toEqual(["AUTORIZADA", "ENVIADA", "INCERTA", "RESERVADA"]);
    });
  });

  describe("ler as cobranças prontas", () => {
    it("⚠ as NOVAS na frente; as presas por cadastro depois, a olhada há mais tempo primeiro; as já emitidas fora", async () => {
      // Por data de criação: 1 e 2 (presas), 3 e 4 (já emitidas), 5, 6 e 7 (novas).
      for (const id of [1, 2, 3, 4, 5, 6, 7]) await cobranca(id);
      const cadastro = "Cadastro do cliente: o CEP 590 não tem 8 dígitos";
      await nota(1, SituacaoDaNota.FALHOU, { motivo: cadastro, verificadaEm: new Date("2026-10-09T14:55:00Z") });
      await nota(2, SituacaoDaNota.FALHOU, { motivo: cadastro, verificadaEm: new Date("2026-10-09T13:00:00Z") });
      await nota(3, SituacaoDaNota.AUTORIZADA);
      await nota(4, SituacaoDaNota.REJEITADA, { motivo: "E0903" });
      const lidas = await prontasDoBanco(cfg(), AGORA);
      expect(lidas.map((l) => l.cobrancaId)).toEqual([5, 6, 7, 2, 1]);
    });

    it("respeita o corte, a janela de 60 dias e só lê PRONTA", async () => {
      await cobranca(1, { quitadaEm: "2026-10-07" }); // anterior ao corte
      await cobranca(2, { quitadaEm: "2026-10-09" });
      await cobranca(3, { quitadaEm: "2026-10-09", situacao: "CONFERIR" });
      await cobranca(4, { quitadaEm: null, evento: "gerada", criadaEm: new Date("2026-10-08T12:00:00Z") }); // gerada (cliente "antes")
      const lidas = await prontasDoBanco(cfg(), AGORA);
      expect(lidas.map((l) => l.cobrancaId).sort()).toEqual([2, 4]);
    });

    it("⚠ a retida NOVA aparece mesmo com 260 prontas antigas já emitidas (as 200 mais antigas escondiam)", async () => {
      for (let id = 1; id <= 260; id++) {
        await cobranca(id, { quitadaEm: "2026-10-09" });
        await nota(id, SituacaoDaNota.AUTORIZADA, { numero: id });
      }
      await cobranca(300, {
        quitadaEm: "2026-10-09",
        notas: [{ chave: "conexa-300-100501", codigo: "10.05.01", valorCentavos: 10000, descricao: "x", competencia: "2026-10", vendas: [1] }],
      });
      const retidas = await cobrancasRetidas(cfg({ codigosEmEspera: ["10.05.01"] }), AGORA);
      expect(retidas).toEqual([300]);
    }, 60_000);
  });

  describe("cobrança paga sem decisão", () => {
    it("⚠ passadas as 50 primeiras, a 51ª em diante aparece (antes só as 50 mais antigas, sempre as mesmas)", async () => {
      for (let id = 1; id <= 60; id++) await cobranca(id, { situacao: "CONFERIR", motivo: "as vendas não somam" });
      for (let id = 1; id <= 50; id++) {
        await db.webhookEvent.create({
          data: { provider: PROVIDER_SEM_NOTA, externalId: `decisao:${id}:CONFERIR`, eventType: "conferir", payload: {}, resultado: "avisada" },
        });
      }
      const lidas = await dependenciasReais().semDecisao!("2026-10-08");
      expect(lidas.map((l) => l.cobrancaId).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => i + 51));
    }, 60_000);
  });

  describe("a rodada inteira, de ponta a ponta, sobre o banco de verdade", () => {
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
    /** Uma Spedy de mentira que conta o que recebe — com uma espera, para as rodadas se sobreporem. */
    const novaSpedy = (esperaMs = 0) => ({
      criarNota: vi.fn(async (c: { integrationId: string }) => {
        if (esperaMs) await new Promise((ok) => setTimeout(ok, esperaMs));
        return { id: `s-${c.integrationId}`, integrationId: c.integrationId, status: "enqueued", number: null, amount: 149, processingDetail: null };
      }),
      obterNota: vi.fn(
        async (id: string): Promise<NotaDaSpedy> => ({ id, integrationId: null, status: "enqueued", number: null, amount: 149, processingDetail: null }),
      ),
      buscarPorIntegrationId: vi.fn(async () => null),
    });
    const dependencias = (spedy: ReturnType<typeof novaSpedy>, extra: Partial<Dependencias> = {}): Dependencias => ({
      repo: repositorioReal(),
      spedy: () => spedy,
      // Cliente com id abaixo de 2000 tem o cadastro ruim (sem CPF/CNPJ): a nota nem chega à Spedy.
      tomador: async (clienteId: number) => (clienteId < 2000 ? { ...TOMADOR, documento: "" } : TOMADOR),
      cep: async () => ({ estado: "ok", ibge: 2408102, cidade: "Natal", uf: "RN" }),
      agora: () => AGORA,
      avisar: async () => "enviado",
      ...extra,
    });
    const pausar = async () => {};
    const config = (extra: Record<string, unknown> = {}) => cfg({ cautela: 0, ...extra });

    it("⚠ a PRIMEIRA rodada depois de um deploy não manda de novo nenhuma cobrança que já tem nota", async () => {
      for (let id = 1; id <= 20; id++) {
        await cobranca(id, { clienteId: 2000 + id });
        await nota(id, SituacaoDaNota.AUTORIZADA, { numero: id });
      }
      const spedy = novaSpedy();
      const r = await rodarEmissao(dependencias(spedy), config(), pausar);
      expect(spedy.criarNota).not.toHaveBeenCalled();
      expect(r.enviadas).toBe(0);
      expect(await db.notaFiscalEmitida.count()).toBe(20);
    });

    it("⚠ duas rodadas ao mesmo tempo (o vigia e o aviso do Conexa) sobre uma cobrança NOVA: UMA nota só", async () => {
      await cobranca(1, { clienteId: 2001 });
      const spedy = novaSpedy(60);
      const [a, b] = await Promise.all([
        rodarEmissao(dependencias(spedy), config(), pausar),
        rodarEmissao(dependencias(spedy), config(), pausar),
      ]);
      expect(spedy.criarNota).toHaveBeenCalledTimes(1);
      expect((a.enviadas ?? 0) + (b.enviadas ?? 0)).toBe(1);
      expect(await db.notaFiscalEmitida.findUnique({ where: { chave: "conexa-1-030302" } })).toMatchObject({
        situacao: "ENVIADA",
        tentativas: 1,
      });
    });

    it("⚠ o mesmo com a nota LIBERADA para tentar de novo (reservada, zero tentativas): um POST só", async () => {
      await cobranca(1, { clienteId: 2001 });
      await nota(1, SituacaoDaNota.RESERVADA, { tentativas: 0, enviadaEm: null });
      const spedy = novaSpedy(60);
      await Promise.all([
        rodarEmissao(dependencias(spedy), config(), pausar),
        rodarEmissao(dependencias(spedy), config(), pausar),
        rodarEmissao(dependencias(spedy), config(), pausar),
      ]);
      expect(spedy.criarNota).toHaveBeenCalledTimes(1);
      expect(await db.notaFiscalEmitida.findUnique({ where: { chave: "conexa-1-030302" } })).toMatchObject({ tentativas: 1 });
    });

    it("⚠ o plano mudou depois de a nota sair: nada é emitido, e a equipe é avisada", async () => {
      await cobranca(1, { clienteId: 2001 }); // o plano de hoje é conexa-1-030302...
      await db.notaFiscalEmitida.create({
        data: { chave: "conexa-1-110401", cobrancaId: 1, empresa: "SEAHUB", codigo: "11.04.01", valorCentavos: 14900, situacao: SituacaoDaNota.AUTORIZADA, numero: 2700 },
      }); // ...mas a nota que saiu foi com outro código
      const spedy = novaSpedy();
      const avisar = vi.fn<Dependencias["avisar"]>(async () => "enviado");
      const r = await rodarEmissao(dependencias(spedy, { avisar }), config({ emailsDeAviso: ["suporte@seahubcoworking.com.br"] }), pausar);
      expect(r.planoMudou).toEqual([1]);
      expect(spedy.criarNota).not.toHaveBeenCalled();
      expect(avisar).toHaveBeenCalledTimes(1);
      expect(avisar.mock.calls[0][2]).toEqual([expect.objectContaining({ tipo: "plano mudou", chave: "plano:1:conexa-1-110401" })]);
      const guardada = await db.webhookEvent.findUnique({
        where: { provider_externalId: { provider: PROVIDER_SEM_NOTA, externalId: "plano:1:conexa-1-110401" } },
      });
      expect(guardada).toMatchObject({ resultado: "avisada", eventType: "plano mudou" });
    });

    it("⚠ doze cobranças presas por cadastro NÃO escondem a nova: ela sai na mesma rodada", async () => {
      for (let id = 20; id < 32; id++) await cobranca(id, { clienteId: 1000 + id }); // as mais antigas, cadastro ruim
      const spedy = novaSpedy();
      // Nas primeiras rodadas elas ainda são "novas" para o sistema e se revezam sob o teto de dez por rodada...
      expect((await rodarEmissao(dependencias(spedy), config(), pausar)).falhas).toBe(10);
      await rodarEmissao(dependencias(spedy), config(), pausar);
      expect(await db.notaFiscalEmitida.count({ where: { situacao: SituacaoDaNota.FALHOU } })).toBe(12);
      expect(spedy.criarNota).not.toHaveBeenCalled();

      // ...e agora, com as doze presas e à frente da fila por data, chega uma cobrança boa.
      await cobranca(500, { clienteId: 2500 });
      const r = await rodarEmissao(dependencias(spedy), config(), pausar);
      expect(r.enviadas).toBe(1);
      expect(spedy.criarNota).toHaveBeenCalledTimes(1);
      expect(spedy.criarNota.mock.calls[0][0].integrationId).toBe("conexa-500-030302");
      expect(r.falhas).toBe(10); // o teto das que nem chegam à Spedy
    });

    it("a emissão que se desliga sozinha deixa o aviso guardado e a pausa registrada no banco", async () => {
      await cobranca(1, { clienteId: 2001 });
      await db.integration.deleteMany({ where: { provider: "NOTAS_FISCAIS" } });
      await db.integration.create({
        data: { provider: "NOTAS_FISCAIS", label: "Notas fiscais (Spedy)", enabled: true, config: { emissao: { ligada: true, aPartirDe: "2026-10-08" } } },
      });
      const spedy = novaSpedy();
      spedy.obterNota.mockImplementation(async (id: string) => ({ id, integrationId: null, status: "authorized", number: 11, amount: 99.99, processingDetail: null }));
      const dep = dependencias(spedy, { desligar: dependenciasReais().desligar });
      const cfgPausa = config({ emailsDeAviso: ["suporte@seahubcoworking.com.br"] });
      await rodarEmissao(dep, cfgPausa, pausar); // manda
      const r2 = await rodarEmissao(dep, cfgPausa, pausar); // a conferência acha o valor diferente
      expect(r2.pausada).toMatch(/valor diferente do planejado/);
      const linha = await db.integration.findUnique({ where: { provider: "NOTAS_FISCAIS" } });
      expect((linha?.config as { emissao: { ligada: boolean; pausadaMotivo: string } }).emissao).toMatchObject({
        ligada: false,
        pausadaMotivo: expect.stringContaining("valor diferente"),
      });
      expect(await db.webhookEvent.count({ where: { provider: PROVIDER_SEM_NOTA, eventType: "pausada" } })).toBe(1);
      await db.integration.deleteMany({ where: { provider: "NOTAS_FISCAIS" } });
    });
  });

  describe("reclassificar", () => {
    it("⚠ a consulta das notas vivas roda de verdade (enum, IN) e poupa quem já tem nota", async () => {
      // Uma cobrança como a rodada de 30 min a grava: leitura do Conexa, sem vendas.
      const lida = lerCobranca({
        chargeId: 1,
        companyId: 3,
        customerId: 1001,
        type: "contractual",
        status: "paid",
        amount: 149,
        paidAmount: 149,
        paymentDate: "2026-10-09",
        competenceDate: "2026-10-01",
        createdAt: "2026-09-24T09:00:00-03:00",
        hasISSRetention: false,
        taxInvoiceNumber: null,
        salesIds: [],
      })!;
      await cobranca(1, { cobranca: JSON.parse(JSON.stringify(lida)) });
      await cobranca(2, { cobranca: JSON.parse(JSON.stringify({ ...lida, id: 2 })) });
      await nota(1, SituacaoDaNota.AUTORIZADA, { numero: 1 });
      await nota(2, SituacaoDaNota.REJEITADA, { motivo: "E0903" });
      const r = await reclassificar(lerConfigNotasFiscais({ codigos: { "10": "10.05.01" } }), AGORA);
      // A 1 tem nota viva e fica como está; a 2 só tem rejeitada e é reavaliada.
      expect(r.preservadas).toBe(1);
      const plano = async (id: number) =>
        ((await db.cobrancaFiscal.findUnique({ where: { cobrancaId: id } }))?.notas as Array<{ chave: string }>)[0]?.chave;
      expect(await plano(1)).toBe("conexa-1-030302");
    });
  });
});
