import { beforeEach, describe, expect, it, vi } from "vitest";
import { esquecerLeituraRemota, idadeDaLeitura, lerComReserva } from "./leitura-remota";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const MIN = 60_000;

let relogio = 1_000_000;
const agora = () => relogio;

/** Um carregador que devolve o próximo valor da fila, ou falha, e conta as chamadas. */
function carregador<T>(...respostas: Array<T | Error>) {
  let chamadas = 0;
  const f = vi.fn(async () => {
    const r = respostas[Math.min(chamadas, respostas.length - 1)];
    chamadas++;
    if (r instanceof Error) throw r;
    return r as T;
  });
  return Object.assign(f, { chamadas: () => chamadas });
}

const opcoes = <T>(carregar: () => Promise<T>, extra: Record<string, unknown> = {}) => ({
  validadeMs: 10 * MIN,
  idadeMaximaMs: 60 * MIN,
  carregar,
  agora,
  ...extra,
});

/** Deixa as promessas de fundo terminarem. */
const esperarOFundo = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  esquecerLeituraRemota();
  relogio = 1_000_000;
});

describe("leitura com reserva", () => {
  it("primeira leitura espera o carregamento; a seguinte, dentro da validade, não toca no serviço", async () => {
    const c = carregador("A");
    expect(await lerComReserva("k", opcoes(c))).toBe("A");

    relogio += 9 * MIN;
    expect(await lerComReserva("k", opcoes(c))).toBe("A");
    expect(c.chamadas()).toBe(1);
  });

  it("⚠ passou da validade: devolve o valor VELHO na hora e renova por trás — quem abre a tela não espera", async () => {
    const c = carregador("velho", "novo");
    await lerComReserva("k", opcoes(c));

    relogio += 11 * MIN;
    expect(await lerComReserva("k", opcoes(c))).toBe("velho");
    await esperarOFundo();
    expect(c.chamadas()).toBe(2);

    // A renovação gravou: a leitura seguinte já traz o novo, sem outra ida ao serviço.
    expect(await lerComReserva("k", opcoes(c))).toBe("novo");
    expect(c.chamadas()).toBe(2);
  });

  it("voo único: leituras ao mesmo tempo fazem UMA ida ao serviço", async () => {
    const c = carregador("A");
    const [a, b, d] = await Promise.all([
      lerComReserva("k", opcoes(c)),
      lerComReserva("k", opcoes(c)),
      lerComReserva("k", opcoes(c)),
    ]);
    expect([a, b, d]).toEqual(["A", "A", "A"]);
    expect(c.chamadas()).toBe(1);
  });

  it("⚠ renovação por trás que falha não apaga o que já se sabe, e a próxima leitura tenta de novo", async () => {
    const c = carregador("bom", new Error("a OpenAI caiu"), "recuperou");
    await lerComReserva("k", opcoes(c));

    relogio += 11 * MIN;
    expect(await lerComReserva("k", opcoes(c))).toBe("bom");
    await esperarOFundo();
    expect(idadeDaLeitura("k", relogio)).toBe(11 * MIN); // continua o valor de antes

    expect(await lerComReserva("k", opcoes(c))).toBe("bom"); // ainda velho, e tenta de novo por trás
    await esperarOFundo();
    expect(await lerComReserva("k", opcoes(c))).toBe("recuperou");
  });

  it("⚠ velho demais não é servido: espera o valor novo", async () => {
    const c = carregador("de dois dias atrás", "de agora");
    await lerComReserva("k", opcoes(c));

    relogio += 61 * MIN;
    expect(await lerComReserva("k", opcoes(c))).toBe("de agora");
  });

  it("velho demais E o serviço falha: o erro chega a quem chamou (cada tela já sabe lidar com ele)", async () => {
    const c = carregador("bom", new Error("fora do ar"));
    await lerComReserva("k", opcoes(c));

    relogio += 61 * MIN;
    await expect(lerComReserva("k", opcoes(c))).rejects.toThrow("fora do ar");
  });

  it("falha na primeira leitura: nada é guardado, e a próxima chamada tenta de novo", async () => {
    const c = carregador(new Error("sem rede"), "ok");
    await expect(lerComReserva("k", opcoes(c))).rejects.toThrow("sem rede");
    expect(idadeDaLeitura("k", relogio)).toBeNull();
    expect(await lerComReserva("k", opcoes(c))).toBe("ok");
  });

  it("chaves diferentes não se misturam", async () => {
    expect(await lerComReserva("a", opcoes(carregador("A")))).toBe("A");
    expect(await lerComReserva("b", opcoes(carregador("B")))).toBe("B");
  });
});

describe("o que vale guardar", () => {
  const vale = (v: { ids: string[] }) => v.ids.length > 0;

  it("⚠ resultado que não vale não substitui a lista boa que já existe", async () => {
    const c = carregador({ ids: ["gpt-a"] }, { ids: [] });
    await lerComReserva("k", opcoes(c, { deveGuardar: vale }));

    relogio += 11 * MIN;
    expect(await lerComReserva("k", opcoes(c, { deveGuardar: vale }))).toEqual({ ids: ["gpt-a"] });
    await esperarOFundo();
    expect(await lerComReserva("k", opcoes(c, { deveGuardar: vale }))).toEqual({ ids: ["gpt-a"] });
  });

  it("na primeira leitura, resultado que não vale chega a quem chamou mas não fica guardado", async () => {
    const c = carregador({ ids: [] }, { ids: ["gpt-a"] });
    expect(await lerComReserva("k", opcoes(c, { deveGuardar: vale }))).toEqual({ ids: [] });
    expect(idadeDaLeitura("k", relogio)).toBeNull();
    expect(await lerComReserva("k", opcoes(c, { deveGuardar: vale }))).toEqual({ ids: ["gpt-a"] });
  });
});

describe("esquecer", () => {
  it("a próxima leitura espera o valor novo — é o que a tela faz depois de trocar a chave ou clicar em recarregar", async () => {
    const c = carregador("antes", "depois");
    await lerComReserva("k", opcoes(c));
    esquecerLeituraRemota("k");
    expect(await lerComReserva("k", opcoes(c))).toBe("depois");
  });

  it("⚠ leitura que começou ANTES do esquecer não grava o valor velho por cima", async () => {
    let liberar!: (v: string) => void;
    const lenta = vi.fn(() => new Promise<string>((r) => (liberar = r)));
    const doVelho = lerComReserva("k", opcoes(lenta));

    esquecerLeituraRemota("k"); // a chave mudou enquanto a leitura andava
    liberar("da conta anterior");
    expect(await doVelho).toBe("da conta anterior"); // quem pediu recebe o que pediu...
    expect(idadeDaLeitura("k", relogio)).toBeNull(); // ...mas nada fica guardado
  });

  it("sem chave, esquece tudo", async () => {
    await lerComReserva("a", opcoes(carregador("A")));
    await lerComReserva("b", opcoes(carregador("B")));
    esquecerLeituraRemota();
    expect(idadeDaLeitura("a", relogio)).toBeNull();
    expect(idadeDaLeitura("b", relogio)).toBeNull();
  });
});
