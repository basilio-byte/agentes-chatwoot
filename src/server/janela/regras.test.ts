import { describe, expect, it } from "vitest";
import {
  decidir,
  estadoDaJanela,
  ETIQUETA_ABERTA,
  ETIQUETA_FECHADA,
  etiquetasDepoisDeFechar,
  MARCA_DA_NOTA,
  precisaLer,
  textoDaNota,
  ultimaDoCliente,
  type LeituraDaJanela,
} from "./regras";

const H = 3600;
const AGORA = 1_790_000_000;

const msg = (id: number, tipo: number, haHoras: number, privada = false) => ({
  id,
  message_type: tipo,
  private: privada,
  created_at: AGORA - haHoras * H,
});

const lida = (parcial: Partial<LeituraDaJanela>): LeituraDaJanela => ({
  ultima: null,
  leuAteOComeco: false,
  maisAntigaEm: null,
  ...parcial,
});

describe("ultimaDoCliente", () => {
  it("é a mais recente de entrada, em qualquer ordem, ignorando saída, atividade e nota", () => {
    const mensagens = [msg(5, 1, 1), msg(3, 0, 10), msg(4, 0, 5), msg(6, 2, 0.5), msg(7, 1, 0.2, true)];
    expect(ultimaDoCliente(mensagens)).toEqual({ id: 4, em: AGORA - 5 * H });
  });

  it("sem mensagem do cliente, nada", () => {
    expect(ultimaDoCliente([msg(1, 1, 3), msg(2, 3, 2)])).toBeNull();
  });
});

describe("estadoDaJanela", () => {
  const estado = (leitura: LeituraDaJanela, minutosDeAviso = 60) =>
    estadoDaJanela({ leitura, agoraEmSegundos: AGORA, minutosDeAviso });

  it("aberta longe de fechar, fechando na última hora, fechada depois de 24 h", () => {
    expect(estado(lida({ ultima: { id: 1, em: AGORA - 10 * H } })).estado).toBe("aberta");
    expect(estado(lida({ ultima: { id: 1, em: AGORA - 23.5 * H } }))).toEqual({
      estado: "fechando",
      fechaEm: AGORA + 0.5 * H,
    });
    expect(estado(lida({ ultima: { id: 1, em: AGORA - 24 * H } }))).toEqual({
      estado: "fechada",
      fechaEm: AGORA,
    });
  });

  it("o trecho de aviso respeita os minutos configurados", () => {
    const ultima = { id: 1, em: AGORA - 22.5 * H };
    expect(estado(lida({ ultima }), 60).estado).toBe("aberta");
    expect(estado(lida({ ultima }), 120).estado).toBe("fechando");
  });

  it("sem mensagem do cliente, só é fechada quando é certo", () => {
    // Chegou ao começo da conversa: o cliente nunca escreveu.
    expect(estado(lida({ leuAteOComeco: true, maisAntigaEm: AGORA - H })).estado).toBe("fechada");
    // Leu mais de 24 h para trás sem achar nada.
    expect(estado(lida({ maisAntigaEm: AGORA - 25 * H })).estado).toBe("fechada");
    // ⚠ Parou de ler antes: o cliente pode ter escrito há 3 h, mais para trás.
    expect(estado(lida({ maisAntigaEm: AGORA - 2 * H })).estado).toBe("indeterminada");
  });
});

describe("precisaLer", () => {
  const base = { agoraEmSegundos: AGORA, minutosDeAviso: 60 };

  it("conversa já marcada como fechada não é lida", () => {
    expect(
      precisaLer({ ...base, etiquetas: [ETIQUETA_FECHADA], ultimaMensagem: null }),
    ).toBe(false);
  });

  it("com as duas etiquetas, é lida: a de aberta é a que está errada ou certa, e só lendo se sabe", () => {
    expect(
      precisaLer({
        ...base,
        etiquetas: [ETIQUETA_ABERTA, ETIQUETA_FECHADA],
        ultimaMensagem: null,
      }),
    ).toBe(true);
  });

  it("última mensagem do cliente e recente: descarta sem ler", () => {
    expect(
      precisaLer({
        ...base,
        etiquetas: [ETIQUETA_ABERTA],
        ultimaMensagem: { tipo: 0, privada: false, criadaEm: AGORA - 5 * H },
      }),
    ).toBe(false);
  });

  it("última do cliente, mas já no trecho do aviso: lê", () => {
    expect(
      precisaLer({
        ...base,
        etiquetas: [ETIQUETA_ABERTA],
        ultimaMensagem: { tipo: 0, privada: false, criadaEm: AGORA - 23.2 * H },
      }),
    ).toBe(true);
  });

  it("⚠ última é da equipe ou uma nota, mesmo que recente: lê — o cliente pode estar calado há dias", () => {
    expect(
      precisaLer({
        ...base,
        etiquetas: [ETIQUETA_ABERTA],
        ultimaMensagem: { tipo: 1, privada: false, criadaEm: AGORA - 60 },
      }),
    ).toBe(true);
    expect(
      precisaLer({
        ...base,
        etiquetas: [ETIQUETA_ABERTA],
        ultimaMensagem: { tipo: 1, privada: true, criadaEm: AGORA - 60 },
      }),
    ).toBe(true);
  });
});

describe("decidir", () => {
  it("fechando avisa; fechada troca a etiqueta, se ainda não estiver trocada", () => {
    expect(decidir({ estado: "fechando", fechaEm: AGORA + 60 }, [ETIQUETA_ABERTA])).toEqual({
      avisar: true,
      fechar: false,
    });
    expect(decidir({ estado: "fechada", fechaEm: AGORA }, [ETIQUETA_ABERTA])).toEqual({
      avisar: false,
      fechar: true,
    });
    expect(decidir({ estado: "fechada", fechaEm: AGORA }, [ETIQUETA_FECHADA])).toEqual({
      avisar: false,
      fechar: false,
    });
  });

  it("⚠ fechada sem etiqueta nenhuma também recebe a de fechada", () => {
    expect(decidir({ estado: "fechada", fechaEm: null }, ["crm_ok"]).fechar).toBe(true);
  });

  it("aberta e indeterminada: nada", () => {
    expect(decidir({ estado: "aberta", fechaEm: AGORA + 5 * H }, [])).toEqual({
      avisar: false,
      fechar: false,
    });
    expect(decidir({ estado: "indeterminada" }, [ETIQUETA_ABERTA])).toEqual({
      avisar: false,
      fechar: false,
    });
  });
});

describe("etiquetasDepoisDeFechar", () => {
  it("troca a de aberta pela de fechada e mantém todas as outras, na ordem", () => {
    expect(
      etiquetasDepoisDeFechar(["crm_clickup", ETIQUETA_ABERTA, "s_novo_lead"]),
    ).toEqual(["crm_clickup", "s_novo_lead", ETIQUETA_FECHADA]);
  });

  it("não duplica a de fechada", () => {
    expect(etiquetasDepoisDeFechar([ETIQUETA_FECHADA, ETIQUETA_ABERTA])).toEqual([ETIQUETA_FECHADA]);
  });
});

describe("textoDaNota", () => {
  it("diz a hora de São Paulo, não a do container", () => {
    // 22/09/2026 17:30 UTC = 14:30 em São Paulo.
    const fechaEm = Date.UTC(2026, 8, 22, 17, 30) / 1000;
    const texto = textoDaNota(fechaEm, "  Ligar para o cliente.  ");
    expect(texto.startsWith(MARCA_DA_NOTA)).toBe(true);
    expect(texto).toContain("fecha às 14:30 de 22/09");
    expect(texto.endsWith("\nLigar para o cliente.")).toBe(true);
  });
});
