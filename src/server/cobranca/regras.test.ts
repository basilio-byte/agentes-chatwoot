import { describe, expect, it } from "vitest";
import {
  comentarioDeEnvio,
  comentarioDeFalha,
  configDoFormulario,
  dentroDoHorario,
  etiquetasDaTarefa,
  lerConfigCobranca,
  MENSAGENS_PADRAO,
  naOrdemDeChegada,
  telefoneDaTarefa,
} from "./regras";

const CAMPO = "3399c6f6-c890-40a6-865e-5a4e810fe8c6";

describe("dentroDoHorario (São Paulo, o container roda em UTC)", () => {
  it("segunda às 10h de São Paulo (13h UTC) é horário comercial", () => {
    expect(dentroDoHorario(new Date("2026-09-21T13:00:00Z"))).toBe(true);
  });

  it("⚠ 21h UTC de segunda ainda é 18h em São Paulo: fora", () => {
    expect(dentroDoHorario(new Date("2026-09-21T21:00:00Z"))).toBe(false);
  });

  it("7h59 não, 8h sim", () => {
    expect(dentroDoHorario(new Date("2026-09-21T10:59:00Z"))).toBe(false);
    expect(dentroDoHorario(new Date("2026-09-21T11:00:00Z"))).toBe(true);
  });

  it("sábado e domingo, nunca", () => {
    expect(dentroDoHorario(new Date("2026-09-26T13:00:00Z"))).toBe(false);
    expect(dentroDoHorario(new Date("2026-09-27T13:00:00Z"))).toBe(false);
  });
});

describe("etiquetasDaTarefa", () => {
  it("acha as duas, sem caixa, e ignora as outras", () => {
    expect(
      etiquetasDaTarefa({ tags: [{ name: "Cobranca-2" }, { name: "vip" }, { name: "cobranca-1" }] }),
    ).toEqual(["cobranca-1", "cobranca-2"]);
    expect(etiquetasDaTarefa({ tags: [] })).toEqual([]);
  });
});

describe("telefoneDaTarefa", () => {
  const tarefa = (value: unknown) => ({ custom_fields: [{ id: CAMPO, value }] });

  it("o CELULAR do ClickUp vira E.164", () => {
    expect(telefoneDaTarefa(tarefa("+55 84 99876 5432"), CAMPO)).toBe("+5584998765432");
    expect(telefoneDaTarefa(tarefa("84998765432"), CAMPO)).toBe("+5584998765432");
  });

  it("sem campo, vazio ou número que não serve: nada é enviado", () => {
    expect(telefoneDaTarefa({ custom_fields: [] }, CAMPO)).toBeNull();
    expect(telefoneDaTarefa(tarefa(null), CAMPO)).toBeNull();
    expect(telefoneDaTarefa(tarefa("123"), CAMPO)).toBeNull();
  });
});

describe("naOrdemDeChegada", () => {
  it("quem espera há mais tempo vai primeiro", () => {
    const ordem = naOrdemDeChegada([
      { id: "b", date_updated: "300" },
      { id: "a", date_updated: "100" },
    ]);
    expect(ordem.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("configuração", () => {
  it("sem nada gravado: caixa 31, Laercio e os textos do pedido", () => {
    const c = lerConfigCobranca({});
    expect(c).toMatchObject({ caixaId: 31, atribuirA: "Laercio", listaId: "900701122530" });
    expect(c.mensagens).toEqual(MENSAGENS_PADRAO);
  });

  it("o formulário muda só o que mostra, e o resto fica como estava", () => {
    const atual = lerConfigCobranca({ intervaloSegundos: 45 });
    const r = configDoFormulario(
      (campo) =>
        ({ caixaId: "31", atribuirA: "Laércio", mensagem1: "Texto um, longo o bastante.", mensagem2: "Texto dois, longo o bastante." })[
          campo
        ] ?? null,
      atual,
    );
    expect(r).toMatchObject({
      config: { intervaloSegundos: 45, atribuirA: "Laércio", mensagens: { "cobranca-1": "Texto um, longo o bastante." } },
    });
  });

  it("depois do envio: atribui por padrão; atribuir exige a quem", () => {
    expect(lerConfigCobranca(undefined).aposEnviar).toBe("atribuir");
    const atual = lerConfigCobranca(undefined);
    const campos: Record<string, string> = {
      caixaId: "31",
      aposEnviar: "atribuir",
      atribuirA: "",
      mensagem1: "Texto um, longo o bastante.",
      mensagem2: "Texto dois, longo o bastante.",
    };
    expect(configDoFormulario((c) => campos[c] ?? null, atual)).toEqual({
      erro: "Atribuir a: diga quem recebe a conversa depois do envio.",
    });
    campos.aposEnviar = "resolver";
    const r = configDoFormulario((c) => campos[c] ?? null, atual);
    expect("config" in r && r.config.aposEnviar).toBe("resolver");
  });

  it("mensagem em branco é recusa, não texto vazio", () => {
    const r = configDoFormulario(
      (campo) => ({ caixaId: "31", mensagem1: "", mensagem2: "Texto dois, longo o bastante." })[campo] ?? null,
      lerConfigCobranca({}),
    );
    expect(r).toHaveProperty("erro");
  });
});

describe("textos", () => {
  it("o comentário de envio diz qual aviso, quando, e o que não deu certo", () => {
    const t = comentarioDeEnvio({
      etiqueta: "cobranca-2",
      quando: "22/09/2026 às 14:10",
      linkDaConversa: "https://chatwoot.test/app/accounts/1/conversations/9",
      destino: "Conversa atribuída a Laercio Melo.",
      problemas: ["não consegui deixar a nota interna na conversa."],
    });
    expect(t).toContain("2º aviso de cobrança enviado pelo WhatsApp em 22/09/2026 às 14:10");
    expect(t).toContain("Laercio Melo");
    expect(t).toContain("⚠ não consegui deixar a nota interna");
  });

  it("a falha diz que a etiqueta continua", () => {
    expect(comentarioDeFalha("cobranca-1", "a task não tem CELULAR válido.")).toContain(
      'A etiqueta "cobranca-1" continua na task',
    );
  });
});
