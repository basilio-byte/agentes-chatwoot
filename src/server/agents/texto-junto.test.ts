import { describe, expect, it } from "vitest";
import { AVISO_TEXTO_JUNTO, avisarTextoJunto } from "./texto-junto";

const tool = (id: string, content: unknown = `{"ok":"${id}"}`) => ({
  role: "tool" as const,
  tool_call_id: id,
  content,
});

describe("avisarTextoJunto", () => {
  it("acrescenta o aviso só ao ÚLTIMO retorno do lote", () => {
    const r = avisarTextoJunto([tool("a"), tool("b")], "Qual a data?", "CHATWOOT");
    expect(r[0].content).toBe('{"ok":"a"}');
    expect(r[1].content).toBe(`{"ok":"b"}\n\n${AVISO_TEXTO_JUNTO}`);
  });

  it("não mexe em nada sem texto junto — vazio e só espaço contam como nada", () => {
    const lote = [tool("a")];
    expect(avisarTextoJunto(lote, null, "CHATWOOT")).toBe(lote);
    expect(avisarTextoJunto(lote, "   ", "CHATWOOT")).toBe(lote);
  });

  it("vale para a conversa e para o playground, que a prevê", () => {
    expect(avisarTextoJunto([tool("a")], "oi", "PLAYGROUND")[0].content).toContain(AVISO_TEXTO_JUNTO);
  });

  it("⚠ fora de conversa o texto não iria a cliente nenhum, e o aviso mentiria", () => {
    for (const source of ["TRIGGER", "SCHEDULE", "MESA", "INTERNO", "CONVERSA_ENCERRADA", "CONVERSA_MARCADA", "CONVERSA_PARADA"] as const) {
      expect(avisarTextoJunto([tool("a")], "oi", source)[0].content).toBe('{"ok":"a"}');
    }
  });

  it("retorno que não é texto fica como está", () => {
    const lote = [tool("a", [{ type: "text", text: "x" }])];
    expect(avisarTextoJunto(lote, "oi", "CHATWOOT")).toEqual(lote);
  });

  it("o aviso não cita ferramenta nenhuma, e diz o que fazer", () => {
    expect(AVISO_TEXTO_JUNTO).not.toMatch(/_[a-z]+_/);
    expect(AVISO_TEXTO_JUNTO).toContain("só a sua última mensagem do turno");
  });
});
