import { describe, expect, it } from "vitest";
import { TEXTOS_PADRAO } from "./config";
import {
  juntarRastro,
  lerNota,
  mensagemDoCliente,
  motivoParaNaoAgir,
  notaSemCrm,
  quemEscreveuDepois,
  respostaDaNota,
} from "./regras";

describe("lerNota", () => {
  it.each([
    ["5", 5],
    ["1", 1],
    [" 3 ", 3],
    ["4.", 4],
    ["5!!!", 5],
    ["Nota 5", 5],
    ["nota: 4", 4],
    ["minha nota é 2", 2],
    ["5 estrelas", 5],
    ["5⭐", 5],
    ["5- ⭐⭐⭐⭐⭐", 5],
    ["3- ⭐⭐⭐", 3],
    ["⭐⭐⭐⭐", 4],
    ["5/5", 5],
    ["cinco", 5],
    ["Três", 3],
    ["5️⃣", 5],
    ["5 😊", 5],
  ])("%j é nota %i", (texto, nota) => {
    expect(lerNota(texto)).toBe(nota);
  });

  // O Switch do n8n casava "contém 1..5": qualquer uma destas virava nota.
  it.each([
    [""],
    ["0"],
    ["6"],
    ["10"],
    ["chego dia 15"],
    ["5, obrigado pelo atendimento"],
    ["quero 2 salas"],
    ["5- ⭐⭐⭐"],
    ["⭐⭐⭐⭐⭐⭐"],
    ["obrigado!"],
    ["😊"],
    ["2 3"],
    ["12:30"],
    ["3,5"],
  ])("%j não é nota", (texto) => {
    expect(lerNota(texto)).toBeNull();
  });

  it("sem texto não é nota", () => {
    expect(lerNota(null)).toBeNull();
    expect(lerNota(undefined)).toBeNull();
  });
});

describe("mensagemDoCliente", () => {
  const entrega = (extra: Record<string, unknown> = {}) => ({
    event: "message_created",
    id: 901,
    content: " 5 ",
    message_type: "incoming",
    private: false,
    sender: { id: 7, type: "contact", name: "Cliente" },
    conversation: { id: 12345, status: "open", inbox_id: 29 },
    ...extra,
  });

  it("lê a conversa, o id e o texto da mensagem do cliente", () => {
    expect(mensagemDoCliente(entrega())).toEqual({
      conversationId: 12345,
      mensagemId: 901,
      texto: "5",
    });
  });

  it("não é do cliente: saída, nota privada, outro remetente, outro evento", () => {
    expect(mensagemDoCliente(entrega({ message_type: "outgoing" }))).toBeNull();
    expect(mensagemDoCliente(entrega({ private: true }))).toBeNull();
    expect(mensagemDoCliente(entrega({ sender: { type: "user" } }))).toBeNull();
    expect(mensagemDoCliente(entrega({ event: "conversation_updated" }))).toBeNull();
    expect(mensagemDoCliente(entrega({ conversation: undefined }))).toBeNull();
  });

  it("vale com a conversa atribuída a uma pessoa: quem perguntou foi o sistema", () => {
    const atribuida = entrega({
      conversation: {
        id: 12345,
        status: "open",
        meta: { assignee: { id: 21 }, assignee_type: "User" },
      },
    });
    expect(mensagemDoCliente(atribuida)?.texto).toBe("5");
  });
});

describe("quemEscreveuDepois", () => {
  const msg = (id: number, message_type: number, tipo?: string) => ({
    id,
    message_type,
    sender: tipo ? { type: tipo } : null,
  });

  it("separa cliente, equipe e robô, só depois do marco", () => {
    const mensagens = [
      msg(10, 0, "contact"),
      msg(11, 1, "user"),
      msg(20, 1, "agent_bot"),
      msg(21, 2),
    ];
    expect(quemEscreveuDepois(mensagens, 11)).toEqual({ cliente: false, equipe: false });
    expect(quemEscreveuDepois(mensagens, 9)).toEqual({ cliente: true, equipe: true });
  });

  it("nota interna da equipe conta", () => {
    expect(quemEscreveuDepois([{ ...msg(12, 1, "user") }], 11).equipe).toBe(true);
  });

  it("saída sem remetente conhecido conta como equipe", () => {
    expect(quemEscreveuDepois([msg(12, 1)], 11).equipe).toBe(true);
  });
});

describe("motivoParaNaoAgir", () => {
  const livre = { status: "open", assigneeId: null, assigneeTipo: null };
  const base = { mensagens: [], depoisDe: 100, clienteImpede: true };

  it("conversa livre e ninguém escreveu: pode", () => {
    expect(motivoParaNaoAgir({ ...base, conversa: livre })).toBeNull();
  });

  it("resolvida, pessoa dona e dono de tipo desconhecido impedem", () => {
    expect(
      motivoParaNaoAgir({ ...base, conversa: { ...livre, status: "resolved" } }),
    ).toBe("a conversa foi resolvida por alguém");
    expect(
      motivoParaNaoAgir({ ...base, conversa: { ...livre, assigneeId: 21, assigneeTipo: "User" } }),
    ).toBe("uma pessoa assumiu a conversa");
    expect(
      motivoParaNaoAgir({ ...base, conversa: { ...livre, assigneeId: 21, assigneeTipo: null } }),
    ).toBe("uma pessoa assumiu a conversa");
  });

  it("o próprio robô como dono não impede", () => {
    expect(
      motivoParaNaoAgir({ ...base, conversa: { ...livre, assigneeId: 4, assigneeTipo: "AgentBot" } }),
    ).toBeNull();
  });

  it("equipe que escreveu depois impede sempre; o cliente, só antes da nota", () => {
    const equipe = [{ id: 101, message_type: 1, sender: { type: "user" } }];
    const cliente = [{ id: 101, message_type: 0, sender: { type: "contact" } }];

    expect(motivoParaNaoAgir({ ...base, conversa: livre, mensagens: equipe, clienteImpede: false })).toBe(
      "alguém da equipe escreveu na conversa",
    );
    expect(motivoParaNaoAgir({ ...base, conversa: livre, mensagens: cliente })).toBe(
      "o cliente escreveu outra coisa",
    );
    expect(
      motivoParaNaoAgir({ ...base, conversa: livre, mensagens: cliente, clienteImpede: false }),
    ).toBeNull();
  });
});

describe("textos da nota", () => {
  it("de 1 a 3 pergunta o que aconteceu; 4 e 5 agradecem", () => {
    for (const nota of [1, 2, 3]) {
      expect(respostaDaNota(nota, TEXTOS_PADRAO)).toBe(TEXTOS_PADRAO.notaBaixa);
    }
    for (const nota of [4, 5]) {
      expect(respostaDaNota(nota, TEXTOS_PADRAO)).toBe(TEXTOS_PADRAO.notaAlta);
    }
  });

  it("a nota interna leva a nota e o motivo", () => {
    const nota = notaSemCrm(3, ["CRM Atendimentos: nenhuma task", "CRM Comercial: nenhuma task"]);
    expect(nota).toContain("o cliente deu nota 3");
    expect(nota).toContain("CRM Atendimentos: nenhuma task; CRM Comercial: nenhuma task");
  });
});

describe("juntarRastro", () => {
  it("junta em ordem e ignora o que veio vazio", () => {
    expect(juntarRastro(["pesquisa enviada", null, " ", "lembrete enviado"])).toBe(
      "pesquisa enviada · lembrete enviado",
    );
    expect(juntarRastro([null, undefined])).toBeNull();
  });

  it("corta pelo começo, para o mais novo continuar na tela", () => {
    const rastro = juntarRastro(["a".repeat(2500), "fim"])!;
    expect(rastro).toHaveLength(2000);
    expect(rastro.startsWith("…")).toBe(true);
    expect(rastro.endsWith(" · fim")).toBe(true);
  });
});
