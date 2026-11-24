import { describe, expect, it } from "vitest";
import type { ClickUpCampoPersonalizado } from "@/server/integrations/clickup/tipos";
import {
  celularDoCrm,
  classificacaoDoProduto,
  comentarioDaPerda,
  decidirPerda,
  mensagemDaEtapa,
  notaDaMensagem,
  proximaEtapa,
  rotuloDoProduto,
  statusCrmDaTarefa,
  type AcaoDeFollowUp,
} from "./follow-up";

/**
 * O follow-up do Diego (task 17twvjx1037): 30 min → "deseja seguir?"; +30 →
 * "ainda tem interesse?"; +30 → lead perdido no CRM ("Não respondeu") e conversa
 * encerrada.
 */

const acao = (etapa: 1 | 2 | 3): AcaoDeFollowUp => ({
  tipo: "follow_up",
  etapa,
  mensagens: ["Deseja seguir com a contratação?", "Ainda tem interesse?"],
  produto: "Sala Privativa",
});

describe("as etapas", () => {
  it("cada etapa leva à seguinte, e a terceira é a última", () => {
    expect(proximaEtapa(acao(1))).toEqual(acao(2));
    expect(proximaEtapa(acao(2))).toEqual(acao(3));
    expect(proximaEtapa(acao(3))).toBeNull();
  });

  it("a 1ª e a 2ª etapa mandam a mensagem certa; a 3ª não manda nada ao cliente", () => {
    expect(mensagemDaEtapa(acao(1))).toBe("Deseja seguir com a contratação?");
    expect(mensagemDaEtapa(acao(2))).toBe("Ainda tem interesse?");
    expect(mensagemDaEtapa(acao(3))).toBeNull();
  });

  it("a nota diz o que vem depois de cada mensagem", () => {
    expect(notaDaMensagem({ etapa: 1, minutos: 30, motivo: "m" })).toContain("a 2ª mensagem sai em 30 min");
    expect(notaDaMensagem({ etapa: 2, minutos: 30, motivo: "m" })).toContain(
      'lead fica como perdido no CRM (motivo "Não respondeu")',
    );
  });
});

describe("o produto do lead", () => {
  it("casa o rótulo do CRM sem acento, caixa nem espaço extra", () => {
    expect(rotuloDoProduto("sala  privativa")).toBe("Sala Privativa");
    expect(rotuloDoProduto("endereco fiscal litoral")).toBe("Endereço Fiscal Litoral");
    expect(rotuloDoProduto("Auditorio")).toBe("Auditório");
  });

  it("o que não é rótulo vira nulo, e a task nasce com 'Não definido', como o CRM faz", () => {
    expect(rotuloDoProduto("endereço fiscal")).toBeNull();
    expect(rotuloDoProduto(undefined)).toBeNull();
    expect(classificacaoDoProduto(null)).toEqual({
      produto: "Não definido",
      categoria: "Não Definido",
      atendimento: "Atendimento Comercial",
    });
  });

  it("cada produto leva a categoria e o tipo de atendimento do prompt do CRM", () => {
    expect(classificacaoDoProduto("Sala Privativa")).toMatchObject({ categoria: "Salas privativas" });
    expect(classificacaoDoProduto("Cabine")).toMatchObject({
      categoria: "Serviços de espaço",
      atendimento: "Reserva de Salas",
    });
    expect(classificacaoDoProduto("Endereço Fiscal Abissal")).toMatchObject({
      categoria: "Serviços de endereço",
    });
  });
});

describe("o celular no formato do CRM", () => {
  it("+55, espaço, DDD, espaço, o resto", () => {
    expect(celularDoCrm("+5584998765432")).toBe("+55 84 998765432");
    expect(celularDoCrm("84 99876-5432")).toBe("+55 84 998765432");
    expect(celularDoCrm("+558498765432")).toBe("+55 84 98765432");
  });

  it("o que não é número brasileiro com DDD fica de fora", () => {
    expect(celularDoCrm(null)).toBeNull();
    expect(celularDoCrm("12345")).toBeNull();
  });
});

const opcoesDoStatus = [
  { id: "p", name: "Perdido", orderindex: 0 },
  { id: "g", name: "Ganho", orderindex: 1 },
  { id: "a", name: "Em andamento", orderindex: 2 },
];
const CAMPOS: ClickUpCampoPersonalizado[] = [
  { id: "s", name: "Status CRM", type: "drop_down", type_config: { options: opcoesDoStatus as never } },
  { id: "m", name: "Motivo de perda", type: "drop_down" },
  { id: "d", name: "Data perdido", type: "date" },
];

describe("o que a perda escreve na task", () => {
  it("task em andamento: Status CRM Perdido, motivo Não respondeu e a data de hoje", () => {
    expect(
      decidirPerda({ campos: CAMPOS, valores: { "Status CRM": 2 }, ganha: false, hoje: "2026-11-24" }),
    ).toEqual({
      acao: "marcar",
      campos: [
        { campo: "Status CRM", valor: "Perdido" },
        { campo: "Motivo de perda", valor: "Não respondeu" },
        { campo: "Data perdido", valor: "2026-11-24" },
      ],
    });
  });

  it("⚠ ganha não vira perdida — nem pela etiqueta, nem pelo Status CRM", () => {
    expect(decidirPerda({ campos: CAMPOS, valores: {}, ganha: true, hoje: "2026-11-24" })).toMatchObject({
      acao: "deixar",
    });
    expect(
      decidirPerda({ campos: CAMPOS, valores: { "Status CRM": "g" }, ganha: false, hoje: "2026-11-24" }),
    ).toEqual({ acao: "deixar", motivo: "a task já está como ganha" });
  });

  it("já perdida (pela equipe) fica como está, com o motivo que a equipe deu", () => {
    expect(
      decidirPerda({ campos: CAMPOS, valores: { "Status CRM": 0 }, ganha: false, hoje: "2026-11-24" }),
    ).toEqual({ acao: "deixar", motivo: "a task já estava como perdida" });
  });

  it("motivo e data que alguém já escreveu não são trocados", () => {
    const r = decidirPerda({
      campos: CAMPOS,
      valores: { "Motivo de perda": "x", "Data perdido": "1795503600000" },
      ganha: false,
      hoje: "2026-11-24",
    });
    expect(r).toEqual({ acao: "marcar", campos: [{ campo: "Status CRM", valor: "Perdido" }] });
  });

  it("lista sem o Status CRM: não há o que marcar", () => {
    expect(decidirPerda({ campos: CAMPOS.slice(1), valores: {}, ganha: false, hoje: "x" })).toMatchObject({
      acao: "deixar",
    });
  });
});

describe("o Status CRM lido da task", () => {
  it("traduz pelo id da opção ou pelo índice", () => {
    const campo = (value: unknown) => [
      { id: "s", name: "Status CRM", value, type_config: { options: opcoesDoStatus } },
    ];
    expect(statusCrmDaTarefa(campo("p"))).toBe("Perdido");
    expect(statusCrmDaTarefa(campo(1))).toBe("Ganho");
    expect(statusCrmDaTarefa(campo(undefined))).toBeNull();
    expect(statusCrmDaTarefa([])).toBeNull();
  });
});

describe("o comentário da task", () => {
  it("diz de onde veio, o tempo e o motivo; a task criada agora diz por quê", () => {
    const texto = comentarioDaPerda({
      agente: "Agente de Salas Privativas",
      minutos: 30,
      linkDaConversa: "https://chat/x/15070",
      criadaAgora: true,
    });
    expect(texto).toContain("follow-up automático do agente Agente de Salas Privativas");
    expect(texto).toContain("90 min sem responder");
    expect(texto).toContain('"Não respondeu"');
    expect(texto).toContain("criada agora para o registro");
    expect(texto).toContain("https://chat/x/15070");
  });
});
