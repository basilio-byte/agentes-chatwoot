import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgendamentoNaTela } from "@/server/actions/agendamentos";

/**
 * Smoke test de renderização.
 *
 * O `next build` compila o componente mas nunca o executa: um erro no caminho
 * de render — acesso a campo nulo, `map` em undefined — só apareceria quando
 * alguém abrisse a tela em produção. Estes testes rodam o render de verdade.
 *
 * As server actions são dubladas porque importá-las de verdade traria banco e
 * Redis para dentro do teste; aqui a pergunta é se a tela pinta, não o que ela
 * salva.
 */
vi.mock("@/server/actions/agendamentos", () => ({
  alternarAgendamento: async () => ({}),
  excluirAgendamento: async () => ({}),
  montarExpressao: async () => "0 9 * * *",
  preverAgendamento: async () => ({}),
  salvarAgendamento: async () => ({}),
}));

const { AgendamentosDoAgente } = await import("./agendamentos-do-agente");

const html = (no: React.ReactElement) => renderToStaticMarkup(no);

function agendamento(extra: Partial<AgendamentoNaTela> = {}): AgendamentoNaTela {
  return {
    id: "s1",
    nome: "Resumo diário",
    cron: "0 9 * * *",
    instrucao: "Confira os contratos que vencem hoje.",
    enabled: true,
    toleranciaMinutos: 60,
    ultimaExecucaoEm: null,
    ultimoResultado: null,
    ultimoDetalhe: null,
    falhasConsecutivas: 0,
    pausadoAutomaticamenteEm: null,
    pausadoAutomaticamenteMotivo: null,
    proximas: [new Date("2026-08-25T12:00:00Z")],
    erroDoCron: null,
    ...extra,
  };
}

describe("lista de agendamentos", () => {
  it("pinta sem agendamento nenhum", () => {
    const saida = html(
      <AgendamentosDoAgente
        agentId="a1"
        agendamentos={[]}
        agenteAtivo
        editavel
      />,
    );

    expect(saida).toContain("Nenhum agendamento");
  });

  it("mostra nome, expressão e a próxima execução", () => {
    const saida = html(
      <AgendamentosDoAgente
        agentId="a1"
        agendamentos={[agendamento()]}
        agenteAtivo
        editavel
      />,
    );

    expect(saida).toContain("Resumo diário");
    expect(saida).toContain("0 9 * * *");
    expect(saida).toContain("Próxima");
  });

  it("diz em letras claras que não fala no WhatsApp", () => {
    // É a expectativa que mais naturalmente se cria, e a que o desenho não
    // atende. Some daqui e alguém configura uma cobrança que nunca sai.
    const saida = html(
      <AgendamentosDoAgente agentId="a1" agendamentos={[]} agenteAtivo editavel />,
    );

    expect(saida).toContain("WhatsApp");
  });

  it("avisa quando o agente está desligado e há agendamento ligado", () => {
    const saida = html(
      <AgendamentosDoAgente
        agentId="a1"
        agendamentos={[agendamento({ enabled: true })]}
        agenteAtivo={false}
        editavel
      />,
    );

    expect(saida).toContain("agente está desligado");
  });

  it("mostra o motivo de um agendamento desligado sozinho", () => {
    const saida = html(
      <AgendamentosDoAgente
        agentId="a1"
        agendamentos={[
          agendamento({
            enabled: false,
            pausadoAutomaticamenteMotivo: "desligado automaticamente após 3 falhas seguidas",
            pausadoAutomaticamenteEm: new Date("2026-08-24T12:00:00Z"),
          }),
        ]}
        agenteAtivo
        editavel
      />,
    );

    expect(saida).toContain("3 falhas seguidas");
  });

  it("expressão que deixou de ser legível aparece como alerta, não some", () => {
    const saida = html(
      <AgendamentosDoAgente
        agentId="a1"
        agendamentos={[
          agendamento({ proximas: [], erroDoCron: "Expressão inválida: nope" }),
        ]}
        agenteAtivo
        editavel
      />,
    );

    expect(saida).toContain("não é mais legível");
  });

  it("sem permissão de edição, não oferece os botões de ação", () => {
    const saida = html(
      <AgendamentosDoAgente
        agentId="a1"
        agendamentos={[agendamento()]}
        agenteAtivo
        editavel={false}
      />,
    );

    expect(saida).not.toContain("Desligar");
    expect(saida).not.toContain(">Novo<");
  });

  it("execução anterior aparece com resultado e detalhe", () => {
    const saida = html(
      <AgendamentosDoAgente
        agentId="a1"
        agendamentos={[
          agendamento({
            ultimaExecucaoEm: new Date("2026-08-24T12:00:00Z"),
            ultimoResultado: "executado",
            ultimoDetalhe: "run abc · 2 tool(s)",
          }),
        ]}
        agenteAtivo
        editavel
      />,
    );

    expect(saida).toContain("executado");
    expect(saida).toContain("run abc");
  });
});
