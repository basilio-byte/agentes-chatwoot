import { describe, expect, it, vi } from "vitest";

import {
  PAGINAS_MAXIMAS,
  cruzarComAsTarefas,
  idDoClienteNaTarefa,
  lerTarefasDoFluxo,
  tarefasOrfas,
  type TarefaDoFluxo,
} from "./clickup";
import { STATUS_DO_FLUXO, type ContratoDaLeva } from "./regras";

describe("idDoClienteNaTarefa", () => {
  it("lê o id entre parênteses no começo do nome", () => {
    expect(idDoClienteNaTarefa("(5077) A GONCALVES DA SILVA LTDA")).toBe(5077);
    expect(idDoClienteNaTarefa("(42) ELAWAN EOLICA BRASIL S.A.")).toBe(42);
  });

  it("⚠ só o parêntese do COMEÇO vale", () => {
    // Nome real: o (1058) do fim é a sala, não o cliente.
    expect(idDoClienteNaTarefa("(2919) EVOLUA NORDESTE SPE S.A. (1058)")).toBe(2919);
  });

  it("aguenta espaço e quebra de linha na frente", () => {
    expect(idDoClienteNaTarefa("\n(3846) MTB ENGENHARIA LTDA")).toBe(3846);
  });

  it("lê o formato da planilha, com travessão", () => {
    expect(idDoClienteNaTarefa("2746 - TAMA SERVICOS MEDICOS LTDA")).toBe(2746);
  });

  it("⚠ número solto no começo NÃO é id: exige parêntese ou travessão", () => {
    expect(idDoClienteNaTarefa("2026 Planejamento comercial")).toBeNull();
    expect(idDoClienteNaTarefa("CLIENTE SEM ID")).toBeNull();
  });

  it("o CONEXA LINK vence o nome", () => {
    const link =
      "https://seahubcoworking.conexa.app/index.php?r=vendaRecorrente/gerenciarContratos&idCliente=5060";
    expect(idDoClienteNaTarefa("(9999) NOME TROCADO À MÃO", link)).toBe(5060);
  });

  it("link sem idCliente cai para o nome", () => {
    expect(idDoClienteNaTarefa("(5077) X", "https://seahubcoworking.conexa.app/")).toBe(5077);
  });
});

describe("lerTarefasDoFluxo", () => {
  const tarefa = (id: string, nome: string, status: string) => ({
    id,
    name: nome,
    status: { status },
    date_updated: "1793813026883",
  });

  it("pede só os três status do fluxo e percorre as páginas", async () => {
    const chamadas: unknown[] = [];
    const cliente = {
      listarTarefasDaLista: vi.fn(async (_lista: string, opcoes: Record<string, unknown>) => {
        chamadas.push(opcoes);
        const pagina = Number(opcoes.page ?? 0);
        if (pagina === 0) {
          return {
            tasks: Array.from({ length: 100 }, (_, i) =>
              tarefa(`t${i}`, `(${i + 1}) CLIENTE`, "notificação renovação"),
            ),
          };
        }
        return { tasks: [tarefa("t100", "(9001) OUTRO", "renovação")] };
      }),
    };

    const { tarefas, completa } = await lerTarefasDoFluxo(cliente);

    expect(tarefas).toHaveLength(101);
    expect(completa).toBe(true);
    expect(chamadas[0]).toMatchObject({ statuses: [...STATUS_DO_FLUXO], page: 0 });
  });

  it("⚠ estourar o teto de páginas avisa que a lista veio cortada", async () => {
    const cliente = {
      listarTarefasDaLista: vi.fn(async () => ({
        tasks: Array.from({ length: 100 }, (_, i) => tarefa(`t${i}`, `(${i}) X`, "renovação")),
      })),
    };

    const { completa } = await lerTarefasDoFluxo(cliente);

    expect(completa).toBe(false);
    expect(cliente.listarTarefasDaLista).toHaveBeenCalledTimes(PAGINAS_MAXIMAS);
  });
});

describe("cruzarComAsTarefas", () => {
  const contrato = (id: number, clienteId: number): ContratoDaLeva => ({
    id,
    clienteId,
    fidelidade: "2026-12-04",
    valor: 99.9,
    periodicidade: "monthly",
    inicio: "2025-12-05",
    fim: null,
    ativo: true,
    reajusteEm: null,
    reajustePct: null,
    reajusteIndice: null,
  });

  const t = (id: string, clienteId: number | null, status = "renovação"): TarefaDoFluxo => ({
    id,
    nome: `(${clienteId}) CLIENTE`,
    status,
    clienteId,
    atualizadaEm: null,
  });

  it("casa contrato e tarefa pelo cliente", () => {
    const linhas = cruzarComAsTarefas([contrato(1, 5077)], [t("a", 5077)]);
    expect(linhas[0].tarefa?.id).toBe("a");
    expect(linhas[0].outrasTarefas).toEqual([]);
  });

  it("contrato sem tarefa no fluxo aparece assim mesmo — é o que se quer ver", () => {
    const linhas = cruzarComAsTarefas([contrato(1, 5077)], [t("a", 1234)]);
    expect(linhas[0].tarefa).toBeNull();
  });

  it("⚠ cliente com mais de uma tarefa mostra as outras, em vez de escolher uma", () => {
    const linhas = cruzarComAsTarefas(
      [contrato(1, 5051)],
      [t("a", 5051), t("b", 5051), t("c", 5051)],
    );
    expect(linhas[0].tarefa?.id).toBe("a");
    expect(linhas[0].outrasTarefas.map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("tarefa sem id de cliente não casa com ninguém", () => {
    const linhas = cruzarComAsTarefas([contrato(1, 5077)], [t("a", null)]);
    expect(linhas[0].tarefa).toBeNull();
  });
});

describe("tarefasOrfas", () => {
  it("são as do fluxo que não têm contrato na leva — o outro lado do buraco", () => {
    const contratos: ContratoDaLeva[] = [
      {
        id: 1,
        clienteId: 5077,
        fidelidade: "2026-12-04",
        valor: 99.9,
        periodicidade: "monthly",
        inicio: null,
        fim: null,
        ativo: true,
        reajusteEm: null,
        reajustePct: null,
        reajusteIndice: null,
      },
    ];
    const tarefas: TarefaDoFluxo[] = [
      { id: "a", nome: "(5077) X", status: "renovação", clienteId: 5077, atualizadaEm: null },
      { id: "b", nome: "(999) Y", status: "renovação", clienteId: 999, atualizadaEm: null },
    ];

    const linhas = cruzarComAsTarefas(contratos, tarefas);
    expect(tarefasOrfas(linhas, tarefas).map((t) => t.id)).toEqual(["b"]);
  });
});
