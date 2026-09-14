import { describe, expect, it } from "vitest";
import {
  decidirPrazo,
  referenciaDasMensagens,
  remetente,
  toleranciaEmMinutos,
  type ConversaAoVivo,
  type MensagemDaConversa,
  type PrazoParaDecidir,
} from "./decisao";

const AGORA = 1_800_000_000_000;
const min = (n: number) => n * 60_000;

const pessoa = (id: number, privado = false): MensagemDaConversa => ({
  id,
  message_type: 1,
  private: privado,
  sender: { type: "user" },
});
const robo = (id: number, privado = false): MensagemDaConversa => ({
  id,
  message_type: 1,
  private: privado,
  sender: { type: "agent_bot" },
});
const cliente = (id: number): MensagemDaConversa => ({
  id,
  message_type: 0,
  sender: { type: "contact" },
});
const atividade = (id: number): MensagemDaConversa => ({ id, message_type: 2 });

const EQUIPE: PrazoParaDecidir = {
  tipo: "EQUIPE",
  minutos: 10,
  venceEm: new Date(AGORA - min(1)),
  referenciaMensagemId: 100,
  donoId: 7,
  agentId: "agente-reunioes",
};

const CLIENTE: PrazoParaDecidir = {
  tipo: "CLIENTE",
  minutos: 10,
  venceEm: new Date(AGORA - min(1)),
  referenciaMensagemId: 100,
  donoId: null,
  agentId: "agente-privativas",
};

const COM_KELLY: ConversaAoVivo = { status: "open", assigneeId: 7, assigneeTipo: "User" };
const COM_O_BOT: ConversaAoVivo = { status: "open", assigneeId: null, assigneeTipo: null };

function decidir(
  prazo: PrazoParaDecidir,
  conversa: ConversaAoVivo,
  mensagens: MensagemDaConversa[],
  agentIdDaConversa: string | null = prazo.agentId,
  agora = AGORA,
) {
  return decidirPrazo({ prazo, agora, conversa, agentIdDaConversa, mensagens });
}

describe("quem escreveu", () => {
  it("lê o tipo do remetente que o Chatwoot manda", () => {
    expect(remetente(pessoa(1))).toBe("pessoa");
    expect(remetente(robo(1))).toBe("robo");
    expect(remetente(cliente(1))).toBe("cliente");
    expect(remetente(atividade(1))).toBe("sistema");
  });

  it("⚠ saída sem remetente conhecido conta como pessoa", () => {
    // Contar como pessoa só faz o prazo cair. O contrário faria o sistema agir
    // por cima de alguém que escreveu por um caminho que não se identifica.
    expect(remetente({ id: 1, message_type: 1 })).toBe("pessoa");
    expect(remetente({ id: 1, message_type: 1, sender: { type: "outra-coisa" } })).toBe(
      "pessoa",
    );
  });

  it("a referência é a maior id", () => {
    expect(referenciaDasMensagens([cliente(3), robo(9), pessoa(5)])).toBe(9);
    expect(referenciaDasMensagens([])).toBe(0);
  });
});

describe("tempo", () => {
  it("antes de vencer, aguarda", () => {
    const prazo = { ...EQUIPE, venceEm: new Date(AGORA + min(2)) };
    expect(decidir(prazo, COM_KELLY, [])).toEqual({ acao: "aguardar" });
  });

  it("dentro da tolerância, ainda age", () => {
    const prazo = { ...EQUIPE, venceEm: new Date(AGORA - min(10)) };
    expect(decidir(prazo, COM_KELLY, [])).toEqual({ acao: "executar" });
  });

  it("⚠ muito atrasado (worker fora do ar), descarta em vez de agir fora de hora", () => {
    const prazo = { ...EQUIPE, venceEm: new Date(AGORA - min(11)) };
    expect(decidir(prazo, COM_KELLY, []).acao).toBe("descartar");
  });

  it("a tolerância é o próprio prazo, com piso de 10 minutos", () => {
    expect(toleranciaEmMinutos(3)).toBe(10);
    expect(toleranciaEmMinutos(60)).toBe(60);
  });
});

describe("prazo da EQUIPE: ninguém respondeu, outra pessoa assume", () => {
  it("mesma pessoa, ninguém da equipe escreveu: executa", () => {
    // Mensagens do robô, do cliente e de atividade depois da referência não
    // contam: o cliente falar sozinho é justamente o caso do prazo.
    const mensagens = [pessoa(50), robo(101), cliente(102), atividade(103)];
    expect(decidir(EQUIPE, COM_KELLY, mensagens)).toEqual({ acao: "executar" });
  });

  it("a pessoa respondeu ao cliente: cancela", () => {
    expect(decidir(EQUIPE, COM_KELLY, [pessoa(101)])).toMatchObject({
      acao: "cancelar",
      motivo: "alguém da equipe escreveu na conversa",
    });
  });

  it("⚠ nota interna de alguém da equipe também cancela", () => {
    // Quem escreveu uma nota está com a conversa na mão.
    expect(decidir(EQUIPE, COM_KELLY, [pessoa(101, true)]).acao).toBe("cancelar");
  });

  it("nota interna do próprio robô não cancela", () => {
    expect(decidir(EQUIPE, COM_KELLY, [robo(101, true)])).toEqual({ acao: "executar" });
  });

  it("outra pessoa assumiu: cancela", () => {
    const conversa = { ...COM_KELLY, assigneeId: 9 };
    expect(decidir(EQUIPE, conversa, [])).toMatchObject({
      acao: "cancelar",
      motivo: "outra pessoa assumiu a conversa",
    });
  });

  it("ficou sem dono: cancela", () => {
    expect(decidir(EQUIPE, COM_O_BOT, []).acao).toBe("cancelar");
  });

  it("o dono virou o robô: cancela", () => {
    const conversa = { status: "open", assigneeId: 7, assigneeTipo: "AgentBot" };
    expect(decidir(EQUIPE, conversa, []).acao).toBe("cancelar");
  });

  it("conversa resolvida: cancela", () => {
    const conversa = { ...COM_KELLY, status: "resolved" };
    expect(decidir(EQUIPE, conversa, []).acao).toBe("cancelar");
  });
});

describe("prazo do CLIENTE: o bot só fala se a conversa ainda é dele", () => {
  it("cliente em silêncio, conversa com o bot: executa", () => {
    // A resposta do próprio bot no mesmo turno chega DEPOIS da referência — e
    // não pode derrubar o prazo.
    expect(decidir(CLIENTE, COM_O_BOT, [cliente(99), robo(101)])).toEqual({
      acao: "executar",
    });
  });

  it("o próprio robô como dono também vale", () => {
    const conversa = { status: "pending", assigneeId: 4, assigneeTipo: "AgentBot" };
    expect(decidir(CLIENTE, conversa, [])).toEqual({ acao: "executar" });
  });

  it("o cliente respondeu: cancela", () => {
    expect(decidir(CLIENTE, COM_O_BOT, [cliente(101)])).toMatchObject({
      acao: "cancelar",
      motivo: "o cliente respondeu",
    });
  });

  it("⚠ uma pessoa escreveu SEM se atribuir: cancela", () => {
    // Mais rigoroso que o turno normal do bot, que ainda responderia a próxima
    // mensagem do cliente nesse caso.
    expect(decidir(CLIENTE, COM_O_BOT, [pessoa(101)]).acao).toBe("cancelar");
    expect(decidir(CLIENTE, COM_O_BOT, [pessoa(101, true)]).acao).toBe("cancelar");
  });

  it("⚠ uma pessoa assumiu: cancela", () => {
    expect(decidir(CLIENTE, COM_KELLY, [])).toMatchObject({
      acao: "cancelar",
      motivo: "conversa atribuída a um humano",
    });
  });

  it("⚠ dono de tipo desconhecido conta como pessoa: cancela", () => {
    const conversa = { status: "open", assigneeId: 7, assigneeTipo: null };
    expect(decidir(CLIENTE, conversa, []).acao).toBe("cancelar");
  });

  it("conversa resolvida ou adiada: cancela", () => {
    expect(decidir(CLIENTE, { ...COM_O_BOT, status: "resolved" }, []).acao).toBe(
      "cancelar",
    );
    expect(decidir(CLIENTE, { ...COM_O_BOT, status: "snoozed" }, []).acao).toBe(
      "cancelar",
    );
  });

  it("outro agente assumiu a conversa: cancela", () => {
    expect(decidir(CLIENTE, COM_O_BOT, [], "agente-financeiro")).toMatchObject({
      acao: "cancelar",
      motivo: "outro agente assumiu a conversa",
    });
  });

  it("sem registro do dono no banco, não trava", () => {
    expect(decidir(CLIENTE, COM_O_BOT, [], null)).toEqual({ acao: "executar" });
  });
});
