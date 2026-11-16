import { describe, expect, it } from "vitest";

import {
  chaveDaNotificacao,
  comentarioDaNotificacao,
  decidirNotificacao,
  diasEntre,
  ehSalaPrivativa,
  type TarefaParaNotificar,
} from "./notificacao";

/** Segunda-feira, 16/11/2026. As tarefas reais em `renovação` entraram em 11 e 14/11. */
const HOJE = "2026-11-16";
/** 13/11/2026, meio-dia em São Paulo: três dias antes de HOJE. */
const HA_TRES_DIAS = Date.UTC(2026, 10, 13, 15);
const ONTEM = Date.UTC(2026, 10, 15, 15);

const tarefa = (extra: Partial<TarefaParaNotificar> = {}): TarefaParaNotificar => ({
  id: "86adx9aak",
  status: "renovação",
  entrouEmMs: HA_TRES_DIAS,
  dataDeReajuste: "2026-12-10",
  categoria: "Serviços de endereço",
  produto: "Endereço Fiscal Litoral",
  ...extra,
});

describe("decidirNotificacao", () => {
  it("passados os dois dias, com data de reajuste no futuro: move", () => {
    const d = decidirNotificacao(tarefa(), HOJE);
    expect(d).toEqual({ mover: true, entrouEm: "2026-11-13", dias: 3 });
  });

  it("no segundo dia inteiro já move (a conta é de dias, como a da equipe)", () => {
    const entrouEm = Date.UTC(2026, 10, 14, 15);
    expect(decidirNotificacao(tarefa({ entrouEmMs: entrouEm }), HOJE).mover).toBe(true);
  });

  it("antes dos dois dias, ESPERA — e isso não é pendência", () => {
    const d = decidirNotificacao(tarefa({ entrouEmMs: ONTEM }), HOJE);
    expect(d).toMatchObject({ mover: false, espera: true });
  });

  it("⚠ sala privativa fica com a equipe, pela categoria OU pelo produto", () => {
    expect(
      decidirNotificacao(tarefa({ categoria: "Salas privativas", produto: null }), HOJE),
    ).toMatchObject({ mover: false, espera: false });
    expect(
      decidirNotificacao(tarefa({ categoria: null, produto: "Sala Privativa " }), HOJE),
    ).toMatchObject({ mover: false });
  });

  it("ONE, SeaBox e categoria não definida movem (a automação 3 só exclui sala privativa)", () => {
    for (const categoria of ["ONE", "SeaBox", "Não Definido", null]) {
      expect(decidirNotificacao(tarefa({ categoria }), HOJE).mover).toBe(true);
    }
  });

  it("⚠ sem saber desde quando está em renovação, não move", () => {
    const d = decidirNotificacao(tarefa({ entrouEmMs: null }), HOJE);
    expect(d).toMatchObject({ mover: false, espera: false });
    expect((d as { motivo: string }).motivo).toContain("desde quando");
  });

  it("⚠ sem DATA DE REAJUSTE ou com ela já vencida, é caso de pessoa — não manda e-mail", () => {
    expect(decidirNotificacao(tarefa({ dataDeReajuste: null }), HOJE)).toMatchObject({
      mover: false,
      espera: false,
    });
    const vencida = decidirNotificacao(tarefa({ dataDeReajuste: "2026-11-10" }), HOJE);
    expect(vencida).toMatchObject({ mover: false });
    expect((vencida as { motivo: string }).motivo).toContain("já passou");
  });

  it("data de reajuste de hoje ainda vale", () => {
    expect(decidirNotificacao(tarefa({ dataDeReajuste: HOJE }), HOJE).mover).toBe(true);
  });

  it("outro status que não `renovação` nunca move", () => {
    expect(decidirNotificacao(tarefa({ status: "notificação renovação" }), HOJE).mover).toBe(
      false,
    );
    expect(decidirNotificacao(tarefa({ status: "ongoing" }), HOJE).mover).toBe(false);
  });
});

describe("apoios", () => {
  it("ehSalaPrivativa ignora acento e caixa", () => {
    expect(ehSalaPrivativa({ categoria: "SALAS PRIVATIVAS", produto: null })).toBe(true);
    expect(ehSalaPrivativa({ categoria: "Serviços de espaço", produto: "Sala de reunião" })).toBe(
      false,
    );
  });

  it("diasEntre conta dias de calendário, também na virada de mês", () => {
    expect(diasEntre("2026-11-30", "2026-12-02")).toBe(2);
    expect(diasEntre("2026-11-16", "2026-11-16")).toBe(0);
  });

  it("a chave da reserva leva o instante de entrada: outra entrada, outra notificação", () => {
    expect(chaveDaNotificacao("abc", 1)).not.toBe(chaveDaNotificacao("abc", 2));
    expect(chaveDaNotificacao("abc", 1)).toBe("notificar:abc:1");
  });

  it("o comentário diz o que o sistema fez e por quê, em pt-BR", () => {
    const c = comentarioDaNotificacao("2026-11-13", 3);
    expect(c).toContain("13/11/2026");
    expect(c).toContain("notificação renovação");
    expect(c).toContain("e-mail de aviso do reajuste");
  });
});
