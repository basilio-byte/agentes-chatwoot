import { describe, expect, it } from "vitest";
import { RunSource } from "@/generated/prisma/enums";
import { ONDE_RODA } from "./onde-roda";

/**
 * O mapa decide se "parar execução" pode confiar no batimento do worker.
 *
 * ⚠ Errar aqui não dá erro nenhum: uma origem que roda no painel e esteja
 * marcada como `worker` (ou simplesmente ausente) faz o painel encerrar como
 * `CANCELED`, com o worker fora do ar, um turno vivo e respondendo.
 */
describe("ONDE_RODA", () => {
  it("cobre TODA origem do enum", () => {
    // Sem esta varredura o teste passaria olhando só o que já está escrito, e
    // a origem nova — que é justamente o caso que motivou o mapa — entraria
    // sem ninguém perceber.
    const origens = Object.values(RunSource);
    expect(origens.length).toBeGreaterThan(0);

    for (const origem of origens) {
      expect(
        ONDE_RODA[origem],
        `a origem ${origem} não diz onde roda — o pedido de parada não sabe quem julgar`,
      ).toMatch(/^(painel|worker)$/);
    }
  });

  it("mesa e playground rodam no processo do painel", () => {
    // As duas são disparadas pela página logada, não pela fila: julgá-las pelo
    // batimento do worker é julgar um processo que nunca executou o turno.
    expect(ONDE_RODA[RunSource.MESA]).toBe("painel");
    expect(ONDE_RODA[RunSource.PLAYGROUND]).toBe("painel");
  });

  it("a chamada interna é julgada só pela idade", () => {
    // Ela roda dentro do turno de quem acionou — no worker ou no painel. Julgada
    // pelo batimento do worker, "parar" encerraria como CANCELED uma chamada
    // viva vinda do playground enquanto o worker reinicia.
    expect(ONDE_RODA[RunSource.INTERNO]).toBe("painel");
  });

  it("as origens que passam pela fila continuam sendo do worker", () => {
    // O outro lado do erro: marcar uma destas como "painel" faria o painel
    // nunca fechar a execução zumbi de um worker que morreu.
    expect(ONDE_RODA[RunSource.CHATWOOT]).toBe("worker");
    expect(ONDE_RODA[RunSource.TRIGGER]).toBe("worker");
    expect(ONDE_RODA[RunSource.SCHEDULE]).toBe("worker");
  });
});
