import { describe, expect, it } from "vitest";
import { FUSO_SEAHUB } from "@/lib/tempo";
import {
  atrasoEmMinutos,
  decidirPeloAtraso,
  expressaoDoAtalho,
  INTERVALO_MINIMO_MINUTOS,
  lerCron,
  validarFrequencia,
} from "./cron";

/** Hora local em São Paulo, que é o que o operador combinou. */
function horaEmSaoPaulo(d: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO_SEAHUB,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

const REFERENCIA = new Date("2026-08-21T12:00:00.000Z"); // 09:00 em São Paulo

describe("o fuso é o que não pode errar", () => {
  /**
   * O container roda em UTC. Sem `tz`, "todo dia às 9h" viraria 9h UTC — 6h da
   * manhã em São Paulo. Três horas errado, todo dia, sem erro nenhum.
   */
  it("'todo dia às 9h' dispara às 09:00 em São Paulo, não em UTC", () => {
    const r = lerCron("0 9 * * *", 3, REFERENCIA);

    expect(r.valida).toBe(true);
    if (!r.valida) return;
    for (const quando of r.proximas) {
      expect(horaEmSaoPaulo(quando)).toBe("09:00");
    }
  });

  it("e o horário absoluto é mesmo o de São Paulo (UTC-3)", () => {
    const r = lerCron("0 9 * * *", 1, REFERENCIA);
    if (!r.valida) throw new Error("deveria ser válida");

    // 09:00 em São Paulo = 12:00 UTC.
    expect(r.proximas[0].toISOString()).toBe("2026-08-22T12:00:00.000Z");
  });
});

describe("validação da expressão", () => {
  it("exige cinco campos — seis abriria porta para agendar por segundo", () => {
    const r = lerCron("*/10 * * * * *", 1, REFERENCIA);

    expect(r.valida).toBe(false);
    if (r.valida) return;
    expect(r.erro).toContain("5 campos");
  });

  it("recusa expressão sem sentido em vez de estourar", () => {
    expect(lerCron("banana", 1, REFERENCIA).valida).toBe(false);
    expect(lerCron("99 99 * * *", 1, REFERENCIA).valida).toBe(false);
    expect(lerCron("", 1, REFERENCIA).valida).toBe(false);
    expect(lerCron("   ", 1, REFERENCIA).valida).toBe(false);
  });

  it("devolve as ocorrências em ordem", () => {
    const r = lerCron("0 9 * * *", 3, REFERENCIA);
    if (!r.valida) throw new Error("deveria ser válida");

    expect(r.proximas).toHaveLength(3);
    expect(r.proximas[0].getTime()).toBeLessThan(r.proximas[1].getTime());
    expect(r.proximas[1].getTime()).toBeLessThan(r.proximas[2].getTime());
  });
});

describe("piso de frequência", () => {
  it("barra a cada minuto — 1440 turnos pagos por dia", () => {
    const r = validarFrequencia("* * * * *", REFERENCIA);

    expect(r.pode).toBe(false);
    if (r.pode) return;
    expect(r.erro).toContain(String(INTERVALO_MINIMO_MINUTOS));
  });

  it("mede o MENOR intervalo, não a média", () => {
    // Dispara de minuto em minuto durante uma hora e dorme o resto do dia: a
    // média é mansa e é justamente o caso que o piso existe para pegar.
    const r = validarFrequencia("* 3 * * *", REFERENCIA);
    expect(r.pode).toBe(false);
  });

  it("aceita o que está no piso ou acima", () => {
    expect(validarFrequencia("*/5 * * * *", REFERENCIA).pode).toBe(true);
    expect(validarFrequencia("0 * * * *", REFERENCIA).pode).toBe(true);
    expect(validarFrequencia("0 9 * * *", REFERENCIA).pode).toBe(true);
    expect(validarFrequencia("0 9 * * 1", REFERENCIA).pode).toBe(true);
  });

  it("expressão inválida volta como erro, não como frequência alta", () => {
    // Cinco campos, para passar da contagem e ser recusada pelo parser.
    const r = validarFrequencia("99 99 * * *", REFERENCIA);
    expect(r.pode).toBe(false);
    if (r.pode) return;
    expect(r.erro).toContain("inválida");
  });

  it("e a contagem de campos vem antes, com a mensagem certa", () => {
    const r = validarFrequencia("banana", REFERENCIA);
    expect(r.pode).toBe(false);
    if (r.pode) return;
    expect(r.erro).toContain("5 campos");
  });
});

describe("atalhos da tela", () => {
  it("montam expressões que o parser aceita e no horário pedido", () => {
    const casos = [
      expressaoDoAtalho({ atalho: "diario", hora: 8, minuto: 30 }),
      expressaoDoAtalho({ atalho: "dias_uteis", hora: 7, minuto: 0 }),
      expressaoDoAtalho({ atalho: "semanal", hora: 18, minuto: 15, diaDaSemana: 1 }),
      expressaoDoAtalho({ atalho: "mensal", hora: 9, minuto: 0, diaDoMes: 5 }),
      expressaoDoAtalho({ atalho: "horas", hora: 0, minuto: 0, aCadaHoras: 6 }),
    ];

    for (const expressao of casos) {
      expect(validarFrequencia(expressao, REFERENCIA).pode, expressao).toBe(true);
    }
  });

  it("diário respeita hora e minuto no fuso de São Paulo", () => {
    const r = lerCron(
      expressaoDoAtalho({ atalho: "diario", hora: 8, minuto: 30 }),
      1,
      REFERENCIA,
    );
    if (!r.valida) throw new Error("deveria ser válida");

    expect(horaEmSaoPaulo(r.proximas[0])).toBe("08:30");
  });

  it("mensal nunca passa do dia 28 — fevereiro pularia o mês inteiro", () => {
    expect(
      expressaoDoAtalho({ atalho: "mensal", hora: 9, minuto: 0, diaDoMes: 31 }),
    ).toBe("0 9 28 * *");
  });

  it("valores fora de faixa são contidos em vez de gerarem lixo", () => {
    expect(expressaoDoAtalho({ atalho: "diario", hora: 99, minuto: -5 })).toBe(
      "0 23 * * *",
    );
    expect(
      expressaoDoAtalho({ atalho: "horas", hora: 0, minuto: 0, aCadaHoras: 0 }),
    ).toBe("0 */1 * * *");
  });
});

describe("ocorrência atrasada", () => {
  const NOVE_DA_MANHA = "0 9 * * *";

  it("pontual no segundo exato é atraso ZERO, não 24 horas", () => {
    // O caso que quebraria tudo em silêncio: `prev()` devolve a ocorrência
    // estritamente anterior, então chegar pontual demais pareceria um atraso de
    // um dia inteiro e o agendamento diário seria pulado sempre.
    // 12:00 UTC = 09:00 em São Paulo.
    expect(atrasoEmMinutos(NOVE_DA_MANHA, new Date("2026-08-21T12:00:00Z"))).toBe(0);
  });

  it("alguns segundos depois também é zero", () => {
    expect(atrasoEmMinutos(NOVE_DA_MANHA, new Date("2026-08-21T12:00:20Z"))).toBe(0);
  });

  it("mede a partir da hora CERTA, não do relógio do job", () => {
    // Worker voltou às 15h de São Paulo; a ocorrência era das 9h.
    const atraso = atrasoEmMinutos(NOVE_DA_MANHA, new Date("2026-08-21T18:00:00Z"));
    expect(atraso).toBe(6 * 60);
  });

  it("expressão ilegível devolve null em vez de estourar", () => {
    expect(atrasoEmMinutos("banana")).toBeNull();
  });
});

describe("decisão pelo atraso", () => {
  it("deploy de dois minutos não custa a execução do dia", () => {
    expect(decidirPeloAtraso(2, 60).executa).toBe(true);
  });

  it("o resumo das 8h não roda às 15h", () => {
    const v = decidirPeloAtraso(6 * 60, 60);

    expect(v.executa).toBe(false);
    if (v.executa) return;
    expect(v.atrasoMinutos).toBe(360);
    expect(v.toleranciaMinutos).toBe(60);
  });

  it("o limite é inclusivo — exatamente na tolerância ainda roda", () => {
    expect(decidirPeloAtraso(60, 60).executa).toBe(true);
    expect(decidirPeloAtraso(61, 60).executa).toBe(false);
  });

  it("atraso desconhecido executa — a dúvida aqui pende para fazer", () => {
    // Não há cliente para atropelar; perder a execução por dúvida é pior.
    expect(decidirPeloAtraso(null, 60).executa).toBe(true);
  });
});
