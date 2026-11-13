import { describe, expect, it, vi } from "vitest";

import {
  PAGINAS_MAXIMAS,
  cruzarComAsTarefas,
  idDoClienteNaTarefa,
  lerTarefasDoFluxo,
  tarefaDoFluxo,
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

describe("tarefaDoFluxo", () => {
  it("lê VALOR CONTRATO e DATA DE REAJUSTE da própria listagem", () => {
    const t = tarefaDoFluxo({
      id: "86adjmaqg",
      name: "(5051) PAULO HENRIQUE",
      status: { status: "notificação renovação" },
      custom_fields: [
        { id: "0dad1007-feb0-437a-9051-87bbac539d4c", value: "99.9" },
        // 27/11/2026, a meia-noite em São Paulo (07:00 UTC no ClickUp).
        { id: "0231d769-5063-439d-8b03-ad660c6bada5", value: "1795762800000" },
      ],
    });

    expect(t.valor).toBe(99.9);
    expect(t.dataDeReajuste).toBe("2026-11-27");
  });

  it("campo ausente ou vazio é nulo, não zero", () => {
    const t = tarefaDoFluxo({
      id: "x",
      name: "(1) X",
      custom_fields: [{ id: "0dad1007-feb0-437a-9051-87bbac539d4c", value: "" }],
    });

    expect(t.valor).toBeNull();
    expect(t.dataDeReajuste).toBeNull();
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

  it("⚠ cliente com várias tarefas SEM como distinguir: não escolhe a primeira, mostra as outras e diz por quê", () => {
    const linhas = cruzarComAsTarefas(
      [contrato(1, 5051)],
      [t("a", 5051), t("b", 5051), t("c", 5051)],
    );
    expect(linhas[0].tarefa).toBeNull();
    expect(linhas[0].outrasTarefas.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(linhas[0].motivo).toContain("nenhuma tarefa do cliente");
  });

  it("⚠ (5051) quatro contratos e quatro tarefas iguais: cada contrato fica com a sua, sem sobra", () => {
    const iguais = (id: string) => ({ ...t(id, 5051, "notificação renovação"), valor: 99.9, dataDeReajuste: "2026-12-04" });
    const linhas = cruzarComAsTarefas(
      [1, 2, 3, 4].map((id) => ({ ...contrato(id, 5051), valor: 104.48, antes: 99.9 })),
      ["a", "b", "c", "d"].map(iguais),
    );

    expect(linhas.map((l) => l.tarefa?.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(linhas.every((l) => l.outrasTarefas.length === 0 && l.motivo === null)).toBe(true);
  });

  it("⚠ (1858) produtos diferentes do mesmo cliente: o valor liga cada contrato à tarefa certa", () => {
    const ev = { ...contrato(10441, 1858), valor: 93.08, antes: 89, fidelidade: "2026-11-06" };
    const sp = { ...contrato(10378, 1858), valor: 6065.64, antes: 5800, fidelidade: "2026-11-04" };
    const linhas = cruzarComAsTarefas(
      [sp, ev],
      [
        { ...t("tarefa-ev", 1858), valor: 89, dataDeReajuste: "2026-11-06" },
        { ...t("tarefa-sp", 1858), valor: 5800, dataDeReajuste: "2026-11-04" },
      ],
    );

    expect(linhas.map((l) => [l.contrato.id, l.tarefa?.id])).toEqual([
      [10378, "tarefa-sp"],
      [10441, "tarefa-ev"],
    ]);
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
