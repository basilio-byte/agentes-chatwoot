import { beforeEach, describe, expect, it } from "vitest";
import { conversaParaAviso, entregarAviso, escolherContato, type ClienteDeAviso } from "./conversa";

/**
 * O que não pode errar: mandar o alerta para OUTRA pessoa (a busca do Chatwoot
 * casa trecho), duplicar contato (o telefone é único na conta e dá 422) e
 * reabrir uma conversa que alguém encerrou.
 */

type Contato = Awaited<ReturnType<ClienteDeAviso["buscarContatos"]>>[number];

const CAIXA = 31;
const PESSOA = { nome: "Pessoa Um", telefone: "+5584999991234" };

let contatos: Contato[];
let conversas: Record<number, { id: number; caixaId: number | null; status: string | null }[]>;
let chamadas: string[];
let falharEnvioPara: number | null;
let proximoId: number;

const cliente: ClienteDeAviso = {
  async buscarContatos(termo) {
    chamadas.push(`buscar ${termo}`);
    return contatos;
  },
  async criarContato(dados) {
    chamadas.push(`criarContato ${dados.telefone} caixa ${dados.caixaId}`);
    return { id: 900, sourceId: "src-novo" };
  },
  async vincularContatoACaixa(contatoId, caixaId) {
    chamadas.push(`vincular ${contatoId} caixa ${caixaId}`);
    return "src-vinculado";
  },
  async conversasDoContato(contatoId) {
    chamadas.push(`conversas ${contatoId}`);
    return (conversas[contatoId] ?? []).map((c) => ({ ...c, ultimaAtividadeEm: null }));
  },
  async criarConversa(dados) {
    chamadas.push(`criarConversa ${dados.contatoId} ${dados.sourceId}`);
    return proximoId++;
  },
  async enviarMensagem(conversaId, texto) {
    if (conversaId === falharEnvioPara) throw new Error("Chatwoot respondeu 500: ops");
    chamadas.push(`enviar ${conversaId}: ${texto}`);
    return { id: 1 };
  },
};

const contato = (over: Partial<Contato> = {}): Contato => ({
  id: 10,
  nome: "Pessoa Um",
  telefone: "+5584999991234",
  identificador: null,
  caixas: [],
  ...over,
});

beforeEach(() => {
  contatos = [];
  conversas = {};
  chamadas = [];
  falharEnvioPara = null;
  proximoId = 5000;
});

describe("escolherContato", () => {
  it("⚠ confere o número: a busca casa trecho e traz outras pessoas", () => {
    const outra = contato({ id: 1, telefone: "+5511999991234" }); // mesmos 8 finais, outro DDD
    const dela = contato({ id: 2 });
    expect(escolherContato([outra, dela], PESSOA.telefone, CAIXA)?.id).toBe(2);
    expect(escolherContato([outra], PESSOA.telefone, CAIXA)).toBeNull();
  });

  it("acha com e sem o nono dígito, e pelo identificador que a WAHA grava", () => {
    expect(escolherContato([contato({ telefone: "+558499991234" })], PESSOA.telefone, CAIXA)).not.toBeNull();
    expect(
      escolherContato(
        [contato({ telefone: null, identificador: "558499991234@s.whatsapp.net" })],
        PESSOA.telefone,
        CAIXA,
      ),
    ).not.toBeNull();
  });

  it("identificador @lid ou de grupo não é telefone", () => {
    expect(
      escolherContato(
        [contato({ telefone: null, identificador: "5584999991234@lid" })],
        PESSOA.telefone,
        CAIXA,
      ),
    ).toBeNull();
  });

  it("entre dois contatos da mesma pessoa, prefere o que já está na caixa", () => {
    const fora = contato({ id: 1 });
    const naCaixa = contato({ id: 2, caixas: [{ caixaId: CAIXA, sourceId: "s" }] });
    expect(escolherContato([fora, naCaixa], PESSOA.telefone, CAIXA)?.id).toBe(2);
  });
});

describe("conversaParaAviso", () => {
  it("busca pelos últimos 8 dígitos, para achar com e sem o nono dígito", async () => {
    await conversaParaAviso(cliente, CAIXA, PESSOA);
    expect(chamadas[0]).toBe("buscar 99991234");
  });

  it("pessoa nova: cria o contato na caixa e abre a conversa com o source_id dele", async () => {
    expect(await conversaParaAviso(cliente, CAIXA, PESSOA)).toEqual({ conversaId: 5000, nova: true });
    expect(chamadas).toEqual([
      "buscar 99991234",
      "criarContato +5584999991234 caixa 31",
      "criarConversa 900 src-novo",
    ]);
  });

  it("reaproveita a conversa aberta mais recente da pessoa NESTA caixa", async () => {
    contatos = [contato({ caixas: [{ caixaId: CAIXA, sourceId: "s" }] })];
    conversas[10] = [
      { id: 100, caixaId: CAIXA, status: "open" },
      { id: 300, caixaId: 29, status: "open" }, // outra caixa
      { id: 200, caixaId: CAIXA, status: "pending" },
    ];
    expect(await conversaParaAviso(cliente, CAIXA, PESSOA)).toEqual({ conversaId: 200, nova: false });
    expect(chamadas.some((c) => c.startsWith("criar"))).toBe(false);
  });

  it("⚠ conversa resolvida não é reaberta: abre outra", async () => {
    contatos = [contato({ caixas: [{ caixaId: CAIXA, sourceId: "src-da-caixa" }] })];
    conversas[10] = [{ id: 100, caixaId: CAIXA, status: "resolved" }];
    expect(await conversaParaAviso(cliente, CAIXA, PESSOA)).toEqual({ conversaId: 5000, nova: true });
    expect(chamadas).toContain("criarConversa 10 src-da-caixa");
  });

  it("⚠ contato que existe fora da caixa: vincula, sem criar outro (daria 422)", async () => {
    contatos = [contato({ caixas: [{ caixaId: 29, sourceId: "de-outra" }] })];
    await conversaParaAviso(cliente, CAIXA, PESSOA);
    expect(chamadas).toContain("vincular 10 caixa 31");
    expect(chamadas).toContain("criarConversa 10 src-vinculado");
    expect(chamadas.some((c) => c.startsWith("criarContato"))).toBe(false);
  });
});

describe("entregarAviso", () => {
  it("a falha de uma pessoa não impede as outras", async () => {
    contatos = [];
    falharEnvioPara = 5000; // a primeira conversa criada
    const entregas = await entregarAviso(
      cliente,
      CAIXA,
      [PESSOA, { nome: "Pessoa Dois", telefone: "+5584988884321" }],
      "saldo baixo",
    );
    expect(entregas).toEqual([
      { nome: "Pessoa Um", ok: false, detalhe: "Chatwoot respondeu 500: ops", conversaId: 5000 },
      {
        nome: "Pessoa Dois",
        ok: true,
        detalhe: "entregue ao Chatwoot, numa conversa nova",
        conversaId: 5001,
      },
    ]);
    expect(chamadas).toContain("enviar 5001: saldo baixo");
  });
});
