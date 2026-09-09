import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Redis falso em memória, mesmo padrão de `gatilho/anti-loop.test.ts`: só o que
 * este módulo usa. `ttl` devolve um número fixo — o que importa aqui é o freio
 * PEDIR o ttl para dizer quanto esperar, não o relógio andar.
 */
let dados: Map<string, number>;
let ttlFalso: number;
let redisQuebrado: boolean;

vi.mock("@/server/queue/conexao", () => ({
  getRedis: () => {
    if (redisQuebrado) throw new Error("Redis fora do ar");
    return {
      incr: async (chave: string) => {
        const atual = (dados.get(chave) ?? 0) + 1;
        dados.set(chave, atual);
        return atual;
      },
      expire: async () => 1,
      ttl: async () => ttlFalso,
    };
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {} },
}));

const { consumirFreio, motivoEmPortugues, TETOS, JANELA_S } = await import("./freio");

beforeEach(() => {
  dados = new Map();
  ttlFalso = 1800;
  redisQuebrado = false;
});

/** Gasta `n` unidades e devolve o veredito da ÚLTIMA. */
async function gastar(n: number, acao: "execucao" | "leitura", quem = "u1") {
  let ultimo = await consumirFreio(acao, quem);
  for (let i = 1; i < n; i++) ultimo = await consumirFreio(acao, quem);
  return ultimo;
}

describe("o freio deixa trabalhar dentro do teto", () => {
  it("libera até o teto da pessoa, inclusive a última", async () => {
    const ultimo = await gastar(TETOS.execucao.porPessoa, "execucao");
    expect(ultimo.pode).toBe(true);
  });

  it("barra a primeira que passa do teto da pessoa", async () => {
    await gastar(TETOS.execucao.porPessoa, "execucao");
    const passou = await consumirFreio("execucao", "u1");

    expect(passou.pode).toBe(false);
    if (passou.pode) return;
    expect(passou.motivo).toBe("teto_da_pessoa");
    expect(passou.esperaSegundos).toBe(1800);
  });

  it("uma pessoa estourando não barra outra", async () => {
    await gastar(TETOS.execucao.porPessoa + 1, "execucao", "u1");

    expect((await consumirFreio("execucao", "u2")).pode).toBe(true);
  });

  it("leitura e execução têm contas separadas", async () => {
    // Ler não pode consumir o direito de executar: são custos diferentes, e
    // quem refotografa um documento tremido não está gastando turno nenhum.
    await gastar(TETOS.execucao.porPessoa + 1, "leitura", "u1");

    expect((await consumirFreio("execucao", "u1")).pode).toBe(true);
  });
});

describe("o teto global", () => {
  it("barra mesmo com cada pessoa dentro do seu limite", async () => {
    // Doze pessoas fazendo cinco execuções cada: ninguém passa de 20, e ainda
    // assim são 60 execuções pagas na mesma hora.
    for (let pessoa = 0; pessoa < 12; pessoa++) {
      await gastar(5, "execucao", `u${pessoa}`);
    }

    const veredito = await consumirFreio("execucao", "novata");

    expect(veredito.pode).toBe(false);
    if (veredito.pode) return;
    expect(veredito.motivo).toBe("teto_global");
  });

  it("o teto da pessoa é conferido ANTES do global", async () => {
    // Quando os dois estouram junto, quem exagerou precisa ler que o limite é
    // DELA. "O sistema está ocupado" mandaria a pessoa errada esperar.
    for (let pessoa = 0; pessoa < 12; pessoa++) {
      await gastar(5, "execucao", `u${pessoa}`);
    }
    const veredito = await gastar(TETOS.execucao.porPessoa + 1, "execucao", "u0");

    expect(veredito.pode).toBe(false);
    if (veredito.pode) return;
    expect(veredito.motivo).toBe("teto_da_pessoa");
  });
});

describe("⚠ falha FECHADO", () => {
  it("Redis fora do ar recusa em vez de liberar", async () => {
    redisQuebrado = true;

    const veredito = await consumirFreio("execucao", "u1");

    expect(veredito.pode).toBe(false);
    if (veredito.pode) return;
    expect(veredito.motivo).toBe("sem_redis");
  });

  it("e a frase diz que a recusa é por prudência, não por defeito", async () => {
    redisQuebrado = true;
    const veredito = await consumirFreio("execucao", "u1");
    if (veredito.pode) throw new Error("deveria ter recusado");

    const frase = motivoEmPortugues(veredito, "execucao");

    expect(frase).toContain("gasta crédito");
    expect(frase).not.toMatch(/erro|falha|exceç/i);
  });
});

describe("o que a pessoa lê", () => {
  it("o teto da pessoa cita o número e o tempo de espera", async () => {
    await gastar(TETOS.execucao.porPessoa, "execucao");
    const veredito = await consumirFreio("execucao", "u1");
    if (veredito.pode) throw new Error("deveria ter recusado");

    const frase = motivoEmPortugues(veredito, "execucao");

    expect(frase).toContain(String(TETOS.execucao.porPessoa));
    expect(frase).toContain("30 minutos");
  });

  it("espera curta não vira '1 minutos'", async () => {
    ttlFalso = 40;
    await gastar(TETOS.leitura.porPessoa, "leitura");
    const veredito = await consumirFreio("leitura", "u1");
    if (veredito.pode) throw new Error("deveria ter recusado");

    expect(motivoEmPortugues(veredito, "leitura")).toContain("em instantes");
  });

  it("TTL ausente devolve a janela inteira em vez de zero", async () => {
    // -2 é chave que sumiu entre o INCR e o TTL. Dizer "espere 0 segundos"
    // convidaria a pessoa a martelar o botão.
    ttlFalso = -2;
    await gastar(TETOS.execucao.porPessoa, "execucao");
    const veredito = await consumirFreio("execucao", "u1");
    if (veredito.pode) throw new Error("deveria ter recusado");

    expect(veredito.esperaSegundos).toBe(JANELA_S);
  });
});

describe("os números", () => {
  it("ler é mais folgado que executar, nos dois tetos", () => {
    // Se ler fosse tão apertado quanto executar, o passo 1 viraria o gargalo do
    // passo 2 — e o desenho de dois passos existe justamente para a pessoa
    // poder olhar antes de gastar.
    expect(TETOS.leitura.porPessoa).toBeGreaterThan(TETOS.execucao.porPessoa);
    expect(TETOS.leitura.global).toBeGreaterThan(TETOS.execucao.global);
  });

  it("o teto global cabe mais de uma pessoa, senão seria o teto da pessoa", () => {
    expect(TETOS.execucao.global).toBeGreaterThan(TETOS.execucao.porPessoa);
    expect(TETOS.leitura.global).toBeGreaterThan(TETOS.leitura.porPessoa);
  });
});
