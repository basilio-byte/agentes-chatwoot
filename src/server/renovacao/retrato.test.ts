import { describe, expect, it } from "vitest";

import { MESES_DE_RETRATO, centavos, decidirRetrato, levasDoRetrato } from "./retrato";

describe("levasDoRetrato", () => {
  it("pega o mês corrente e os seguintes", () => {
    expect(levasDoRetrato("2026-11-10")).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(levasDoRetrato("2026-11-10").length).toBe(MESES_DE_RETRATO);
  });

  it("atravessa a virada do ano", () => {
    expect(levasDoRetrato("2026-12-20")).toEqual(["2026-12", "2027-01", "2027-02"]);
  });

  it("o dia não muda a leva: o que conta é o mês", () => {
    expect(levasDoRetrato("2026-11-01")).toEqual(levasDoRetrato("2026-11-30"));
  });
});

describe("decidirRetrato", () => {
  const contrato = { valor: 1280, reajusteEm: "2025-11-19" };

  it("sem retrato da leva, cria", () => {
    expect(decidirRetrato(contrato, null)).toBe("criar");
  });

  it("nada mudou: mantém", () => {
    expect(
      decidirRetrato(contrato, { reajusteEm: "2025-11-19", valorCentavos: 128000 }),
    ).toBe("manter");
  });

  it("antes do lote, valor renegociado entra no retrato", () => {
    expect(
      decidirRetrato(contrato, { reajusteEm: "2025-11-19", valorCentavos: 120000 }),
    ).toBe("atualizar");
  });

  it("⚠ o lote passou: CONGELA, porque o guardado é o valor da véspera", () => {
    // Cliente 5060: o retrato viu o reajuste de 19/11/2025; o lote de 23/10/2026
    // trocou o valor para 1.338,62. A linha não pode ser reescrita.
    expect(
      decidirRetrato(
        { valor: 1338.62, reajusteEm: "2026-10-23" },
        { reajusteEm: "2025-11-19", valorCentavos: 128000 },
      ),
    ).toBe("congelar");
  });

  it("⚠ congela também no PRIMEIRO reajuste do contrato", () => {
    // Contrato que nunca tinha sido reajustado: o retrato guardou reajusteEm
    // nulo, e o lote pôs uma data. Isso é o lote, não uma renegociação.
    expect(
      decidirRetrato(
        { valor: 104.29, reajusteEm: "2026-10-23" },
        { reajusteEm: null, valorCentavos: 9990 },
      ),
    ).toBe("congelar");
  });

  it("centavos arredonda em vez de truncar", () => {
    expect(centavos(1338.62)).toBe(133862);
    expect(centavos(4.6433)).toBe(464);
    expect(centavos(0.005)).toBe(1);
  });
});
