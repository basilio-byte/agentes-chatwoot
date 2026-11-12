import { beforeEach, describe, expect, it, vi } from "vitest";
import { esquecerGeocodificacoes, geocodificarEndereco } from "./nominatim";

/**
 * O que se trava aqui é a conduta, não o Nominatim: nunca inventar coordenada,
 * respeitar a política de uso (1 consulta por segundo, User-Agent) e não repetir
 * a mesma consulta paga em tempo.
 */

type Consulta = { q: string; headers: Record<string, string> };
let consultas: Consulta[];
let esperas: number[];
let respostas: (() => Response)[];

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

const fetchSimulado = (async (url: string, init: RequestInit = {}) => {
  consultas.push({
    q: new URL(String(url)).searchParams.get("q") ?? "",
    headers: init.headers as Record<string, string>,
  });
  const proxima = respostas.shift();
  if (!proxima) throw new Error("consulta a mais do que o teste esperava");
  return proxima();
}) as unknown as typeof fetch;

const opcoes = () => ({
  fetchImpl: fetchSimulado,
  esperar: async (ms: number) => {
    esperas.push(ms);
  },
});

beforeEach(() => {
  esquecerGeocodificacoes();
  consultas = [];
  esperas = [];
  respostas = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const ACHADO = [{ lat: "-5.8300919", lon: "-35.2224058", display_name: "Rua Jaguarari, Candelária, Natal, 59064-500, Brasil" }];

describe("geocodificarEndereco", () => {
  it("devolve as coordenadas do primeiro resultado e se identifica com User-Agent", async () => {
    respostas = [() => json(ACHADO)];

    const r = await geocodificarEndereco("Rua Jaguarari, 4985, Candelária, Natal - RN, 59064-500", opcoes());

    expect(r).toEqual({ lat: -5.8300919, lng: -35.2224058 });
    expect(consultas).toHaveLength(1);
    expect(consultas[0].headers["User-Agent"]).toContain("SeahubAgentes");
    expect(esperas).toEqual([]);
  });

  it("não achou o endereço inteiro: tenta só o CEP, esperando 1 s entre as consultas", async () => {
    respostas = [() => json([]), () => json(ACHADO)];

    const r = await geocodificarEndereco("Rua Nova Que Nao Existe no Mapa, 12, Natal - RN, 59064-500", opcoes());

    expect(r).toEqual({ lat: -5.8300919, lng: -35.2224058 });
    expect(consultas.map((c) => c.q)).toEqual([
      "Rua Nova Que Nao Existe no Mapa, 12, Natal - RN, 59064-500",
      "59064-500",
    ]);
    expect(esperas).toEqual([1100]);
  });

  it("⚠ o mapa não tem o título da rua: tenta o endereço simplificado (venda 14286, 'Rua Dr. Costa Ribeiro')", async () => {
    respostas = [
      () => json([]),
      () =>
        json([
          {
            lat: "-5.8472750",
            lon: "-35.2403767",
            display_name: "Rua Costa Ribeiro, Pitimbu, Zona Sul, Natal, Rio Grande do Norte, Brasil",
          },
        ]),
    ];

    const r = await geocodificarEndereco("Rua Dr. Costa Ribeiro, 34, Pitimbu, Natal/RN, CEP 59069-330", opcoes());

    expect(r).toEqual({ lat: -5.847275, lng: -35.2403767 });
    expect(consultas.map((c) => c.q)).toEqual([
      "Rua Dr. Costa Ribeiro, 34, Pitimbu, Natal/RN, CEP 59069-330",
      "Rua Costa Ribeiro, 34, Pitimbu, Natal, RN, 59069-330",
    ]);
    expect(esperas).toEqual([1100]);
  });

  it("⚠ a busca simplificada que cita OUTRA cidade é descartada: nunca pino em cidade errada", async () => {
    respostas = [
      () => json([]),
      () => json([{ lat: "-5.19", lon: "-37.34", display_name: "Rua Costa Ribeiro, Centro, Mossoró, Rio Grande do Norte, Brasil" }]),
      () => json([]),
    ];

    expect(
      await geocodificarEndereco("Rua Dr. Costa Ribeiro, 34, Pitimbu, Natal/RN, CEP 59069-330", opcoes()),
    ).toBeNull();
    expect(consultas).toHaveLength(3);
  });

  it("endereço que a simplificação não muda não ganha consulta extra", async () => {
    respostas = [() => json([])];

    expect(await geocodificarEndereco("Rua Qualquer, 100, Natal", opcoes())).toBeNull();
    expect(consultas).toHaveLength(1);
  });

  it("⚠ resultado da busca por CEP que cita OUTRO CEP é descartado: pino em outro bairro é dado falso", async () => {
    respostas = [
      () => json([]),
      () => json([{ lat: "-5.9", lon: "-35.3", display_name: "Outra Rua, Parnamirim, 59150-000, Brasil" }]),
    ];

    expect(await geocodificarEndereco("Rua X, 1, Natal, 59064-500", opcoes())).toBeNull();
  });

  it("sem CEP no texto e sem resultado: null, sem segunda consulta", async () => {
    respostas = [() => json([])];

    expect(await geocodificarEndereco("Rua Qualquer, 100, Natal", opcoes())).toBeNull();
    expect(consultas).toHaveLength(1);
  });

  it("⚠ coordenada fora do Brasil não vale", async () => {
    respostas = [() => json([{ lat: "48.85", lon: "2.35", display_name: "Paris" }]), () => json([])];

    expect(await geocodificarEndereco("Rua X, 1, 59064-500", opcoes())).toBeNull();
  });

  it("⚠ serviço fora do ar ou recusando vira null — nunca coordenada inventada", async () => {
    respostas = [() => json({ erro: "limite" }, 429)];
    expect(await geocodificarEndereco("Rua Qualquer, 100, Natal", opcoes())).toBeNull();

    respostas = [
      () => {
        throw new Error("rede caiu");
      },
    ];
    expect(await geocodificarEndereco("Outra Rua, 200, Natal", opcoes())).toBeNull();
  });

  it("repetir o mesmo endereço não consulta de novo", async () => {
    respostas = [() => json(ACHADO)];

    await geocodificarEndereco("Rua Jaguarari, 4985, Natal", opcoes());
    const de_novo = await geocodificarEndereco("  rua jaguarari, 4985,   natal ", opcoes());

    expect(de_novo).toEqual({ lat: -5.8300919, lng: -35.2224058 });
    expect(consultas).toHaveLength(1);
  });

  it("falha não é guardada: a próxima tentativa consulta de novo", async () => {
    respostas = [() => json([]), () => json(ACHADO)];

    expect(await geocodificarEndereco("Rua Jaguarari, 4985, Natal", opcoes())).toBeNull();
    expect(await geocodificarEndereco("Rua Jaguarari, 4985, Natal", opcoes())).not.toBeNull();
  });

  it("endereço em branco não consulta nada", async () => {
    expect(await geocodificarEndereco("   ", opcoes())).toBeNull();
    expect(consultas).toHaveLength(0);
  });
});
