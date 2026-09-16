import { describe, expect, it } from "vitest";
import { configDoFormulario, lerConfigNps, TEXTOS_PADRAO } from "./config";

const formulario = (sobre: Record<string, string> = {}) => {
  const campos: Record<string, string> = {
    checkbox: "nps_perdido",
    caixas: "29",
    listasDaNota: "CRM Atendimentos\nCRM Comercial",
    campoDaNota: "NPS",
    campoDoTelefone: "CELULAR",
    horasAteLembrete: "3",
    horasAteEncerrar: "1",
    minutosAposNota: "10",
    horasEntrePesquisas: "24",
    textoAgradecimento: TEXTOS_PADRAO.agradecimento,
    textoConvite: TEXTOS_PADRAO.convite,
    textoPergunta: TEXTOS_PADRAO.pergunta,
    textoLembrete: TEXTOS_PADRAO.lembrete,
    textoNotaBaixa: TEXTOS_PADRAO.notaBaixa,
    textoNotaAlta: TEXTOS_PADRAO.notaAlta,
    ...sobre,
  };
  return (campo: string) => campos[campo] ?? null;
};

const erroDe = (lido: ReturnType<typeof configDoFormulario>) =>
  "erro" in lido ? lido.erro : null;

describe("lerConfigNps", () => {
  it("sem nada gravado, reproduz o NPS do n8n", () => {
    const config = lerConfigNps({});
    expect(config).toMatchObject({
      checkbox: "nps_perdido",
      caixas: [29],
      listasDaNota: ["901306195904", "901302419821"],
      campoDaNota: "NPS",
      horasAteLembrete: 3,
      horasAteEncerrar: 1,
      horasEntrePesquisas: 24,
    });
    expect(config.textos).toEqual(TEXTOS_PADRAO);
  });

  it("depois da nota espera 10 minutos, não 1 (pedido do usuário)", () => {
    expect(lerConfigNps(null).minutosAposNota).toBe(10);
  });

  it("config mexida à mão e inválida cai nos padrões", () => {
    expect(lerConfigNps({ caixas: [] }).caixas).toEqual([29]);
  });

  it("os textos padrão são os do n8n", () => {
    expect(TEXTOS_PADRAO.pergunta.startsWith("De 1 à 5, o quanto você indicaria o Seahub?")).toBe(true);
    expect(TEXTOS_PADRAO.notaBaixa).toContain("Pode nos contar o que aconteceu");
    expect(TEXTOS_PADRAO.lembrete).toContain("encerrado automaticamente após 1 hora");
  });
});

describe("configDoFormulario", () => {
  it("lê o formulário inteiro, com vírgula decimal e quebra de linha do Windows", () => {
    const lido = configDoFormulario(
      formulario({ caixas: "29, 31, 29", horasAteLembrete: "2,5", textoLembrete: "Oi\r\nde novo" }),
    );
    expect(erroDe(lido)).toBeNull();
    if (!("config" in lido)) return;

    expect(lido.config.caixas).toEqual([29, 31]);
    expect(lido.config.horasAteLembrete).toBe(2.5);
    expect(lido.config.listasDaNota).toEqual(["CRM Atendimentos", "CRM Comercial"]);
    expect(lido.config.textos.lembrete).toBe("Oi\nde novo");
  });

  it("recusa checkbox fora do formato do Chatwoot", () => {
    expect(erroDe(configDoFormulario(formulario({ checkbox: "Passar CRM" })))).toContain("Checkbox");
  });

  it("recusa caixa que não é número", () => {
    expect(erroDe(configDoFormulario(formulario({ caixas: "vinte e nove" })))).toContain("Caixas");
    expect(erroDe(configDoFormulario(formulario({ caixas: "" })))).toContain("Caixas");
  });

  it("número em branco é recusa, não zero", () => {
    expect(erroDe(configDoFormulario(formulario({ horasEntrePesquisas: "" })))).toContain(
      "Intervalo por telefone",
    );
  });

  it("minutos depois da nota são inteiros, de 1 a 120", () => {
    expect(erroDe(configDoFormulario(formulario({ minutosAposNota: "2,5" })))).toContain("Minutos");
    expect(erroDe(configDoFormulario(formulario({ minutosAposNota: "0" })))).toContain("Minutos");
  });

  it("texto em branco é recusado", () => {
    expect(erroDe(configDoFormulario(formulario({ textoNotaAlta: "   " })))).toContain(
      "Resposta à nota 4 ou 5",
    );
  });

  it("não existe configuração de status: a pesquisa não mexe na task", () => {
    const lido = configDoFormulario(formulario());
    expect("config" in lido && Object.keys(lido.config)).not.toContain("statusDeAnalise");
  });
});
