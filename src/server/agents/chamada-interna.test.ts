import { describe, expect, it } from "vitest";
import { chatwootIntegration } from "@/server/integrations/chatwoot";
import {
  conversaDaChamada,
  falhaDaChamada,
  FERRAMENTAS_DE_CANAL,
  mensagemDaChamada,
  NOME_DA_FERRAMENTA,
  resolverAgenteInterno,
  resultadoDaChamada,
  semFerramentasDeCanal,
} from "./chamada-interna";

const EQUIPE = [
  { id: "a1", key: "agente-de-suporte-ao-cliente", name: "Suporte", active: true },
  { id: "a2", key: "agente-crm-atendimentos", name: "CRM de Atendimentos", active: true },
  { id: "a3", key: "agente-crm-comercial", name: "CRM Comercial", active: false },
  { id: "a4", key: "agente-financeiro", name: "Financeiro", active: true },
];

describe("quem roda em segundo plano não mexe na conversa", () => {
  it("perde as ferramentas que falam com o cliente ou passam a conversa", () => {
    // Qualquer uma delas faria o "segundo plano" aparecer para o cliente — ou
    // entregaria a conversa a outra pessoa com quem acionou ainda no meio do
    // turno.
    const resolvidas = new Map<string, number>([
      ["clickup_criar_tarefa", 1],
      ["registrar_nota_interna", 2],
      ["ver_dados_do_contato", 3],
      ["transferir_para_agente", 4],
      ["transferir_para_humano", 5],
      ["atribuir_para_atendente", 6],
      ["atribuir_por_rodizio", 7],
      [NOME_DA_FERRAMENTA, 8],
    ]);

    expect([...semFerramentasDeCanal(resolvidas).keys()]).toEqual([
      "clickup_criar_tarefa",
      "registrar_nota_interna",
      "ver_dados_do_contato",
    ]);
    // O mapa do agente não é alterado: é o mesmo que vale para ele quando atende.
    expect(resolvidas.size).toBe(8);
  });

  it("agente interno não aciona outro", () => {
    // Uma cadeia de chamadas internas não passa pelas travas do laço, que só
    // contam transferências. Profundidade fixa em um é o que a limita.
    expect(FERRAMENTAS_DE_CANAL.has(NOME_DA_FERRAMENTA)).toBe(true);
  });

  it("⚠ os nomes filtrados existem de verdade no catálogo do Chatwoot", () => {
    // Renomear uma tool de canal sem atualizar o filtro deixaria o agente
    // interno com ela — e o filtro continuaria "passando" em silêncio.
    const nomes = new Set(chatwootIntegration.tools.map((t) => t.name));
    for (const nome of FERRAMENTAS_DE_CANAL) {
      expect(nomes.has(nome), `${nome} não está no catálogo do Chatwoot`).toBe(true);
    }
  });
});

describe("quem pode ser acionado", () => {
  it("acha pela chave, sem diferenciar maiúsculas nem espaços nas pontas", () => {
    const alvo = resolverAgenteInterno(EQUIPE, "  Agente-CRM-Atendimentos ", "a1");
    expect(alvo).toEqual({ tipo: "achado", agente: EQUIPE[1] });
  });

  it("acha pelo id", () => {
    expect(resolverAgenteInterno(EQUIPE, "a2", "a1")).toEqual({
      tipo: "achado",
      agente: EQUIPE[1],
    });
  });

  it("não aciona pelo nome — o nome muda, a chave não", () => {
    expect(resolverAgenteInterno(EQUIPE, "CRM de Atendimentos", "a1").tipo).toBe(
      "recusado",
    );
  });

  it("recusa a si mesmo", () => {
    const alvo = resolverAgenteInterno(EQUIPE, "agente-crm-atendimentos", "a2");
    expect(alvo.tipo).toBe("recusado");
  });

  it("desligado não roda, e a recusa diz que nada foi executado", () => {
    // Desligar o agente interno é como o operador suspende o serviço sem mexer
    // no prompt de ninguém.
    const alvo = resolverAgenteInterno(EQUIPE, "agente-crm-comercial", "a1");
    expect(alvo.tipo).toBe("recusado");
    if (alvo.tipo === "recusado") expect(alvo.erro).toContain("não foi executado");
  });

  it("chave desconhecida devolve as que existem, sem a própria e sem desligado", () => {
    const alvo = resolverAgenteInterno(EQUIPE, "agente-crm", "a1");
    expect(alvo).toEqual({
      tipo: "recusado",
      erro: 'Não existe agente com a chave "agente-crm".',
      chavesValidas: ["agente-crm-atendimentos", "agente-financeiro"],
    });
  });
});

describe("o pedido não se confunde com a fala do cliente", () => {
  it("diz de quem é o pedido e que não veio do cliente", () => {
    // O agente acionado recebe a conversa, e o pedido chega logo depois da
    // última fala do cliente, também como mensagem de `user`.
    const mensagem = mensagemDaChamada({
      deNome: "Agente Financeiro",
      pedido: "  Registrar: 2ª via de boleto\nNome do cliente: Taís  ",
    });

    expect(mensagem).toBe(
      "[Pedido interno de Agente Financeiro — não é mensagem do cliente]\nRegistrar: 2ª via de boleto\nNome do cliente: Taís",
    );
  });
});

describe("o agente acionado vê a conversa inteira", () => {
  it("⚠ inclui a mensagem que abriu o turno, que não está no histórico", () => {
    // No Chatwoot, as mensagens novas do cliente saem do histórico e viram a
    // mensagem do turno. Sem juntá-las, o CRM consultaria a conversa sem ver o
    // comprovante que acabou de chegar — no turno em que foi acionado por ele.
    const historico = [
      { role: "user" as const, content: "Oi" },
      { role: "assistant" as const, content: "Olá! Em que posso ajudar?" },
    ];

    expect(conversaDaChamada(historico, "  Segue o comprovante  ")).toEqual([
      { role: "user", content: "Oi" },
      { role: "assistant", content: "Olá! Em que posso ajudar?" },
      { role: "user", content: "Segue o comprovante" },
    ]);
    // O histórico de quem chamou não é alterado: ele continua o turno com o dele.
    expect(historico).toHaveLength(2);
  });

  it("sem histórico e sem mensagem, a conversa fica vazia", () => {
    expect(conversaDaChamada(undefined, undefined)).toEqual([]);
    expect(conversaDaChamada(undefined, "   ")).toEqual([]);
  });
});

describe("o que volta para quem acionou", () => {
  it("com texto final, executado — e o texto é o que ele fez de fato", () => {
    const r = resultadoDaChamada({
      agente: "CRM de Atendimentos",
      resposta: " Task criada: https://app.clickup.com/t/86ak ",
      runId: "run1",
      atingiuLimite: false,
    });

    expect(r).toMatchObject({
      executado: true,
      agente: "CRM de Atendimentos",
      resultado: "Task criada: https://app.clickup.com/t/86ak",
      execucao: "run1",
    });
    expect(r.observacao).toContain("Nada disso aparece para o cliente");
  });

  it("sem texto final, não executado", () => {
    const r = resultadoDaChamada({
      agente: "CRM de Atendimentos",
      resposta: "   ",
      runId: "run2",
      atingiuLimite: false,
    });

    expect(r.executado).toBe(false);
    expect(r.resultado).toBeUndefined();
    expect(r.observacao).toContain("NÃO foi concluído");
  });

  it("⚠ parou no limite de etapas: não executado, mesmo com texto", () => {
    // Pode ter feito metade do serviço. Lendo "executado", quem acionou diria
    // ao cliente que está tudo certo. O texto parcial vai junto para quem
    // assumir saber até onde chegou.
    const r = resultadoDaChamada({
      agente: "CRM de Atendimentos",
      resposta: "Criei a task, faltou o responsável",
      runId: "run3",
      atingiuLimite: true,
    });

    expect(r.executado).toBe(false);
    expect(r.resultado).toBe("Criei a task, faltou o responsável");
    expect(r.erro).toContain("limite de etapas");
  });

  it("falha nunca parece sucesso", () => {
    const r = falhaDaChamada({ agente: "CRM de Atendimentos", erro: "caiu" });

    expect(r.executado).toBe(false);
    expect(r.execucao).toBeNull();
    expect(r.observacao).toContain("Não diga ao cliente que foi feito");
  });
});
