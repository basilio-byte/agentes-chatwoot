import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaKind, MediaStatus } from "@/generated/prisma/enums";
import type { MensagemChatwoot } from "@/server/integrations/chatwoot/client";
import { montarContexto } from "@/server/integrations/chatwoot/historico";
import type { Anexo } from "./classificar";
import { lerConfigOpenAI } from "./config";

/** Chaves que passaram por `analisarAnexo` — o que custou dinheiro. */
let analisadas: string[];
/** Resposta do dublê, por tipo de mídia. */
let respostas: Record<string, { texto: string | null; erro?: string | null }>;
let vindoDoCache: Set<string>;

vi.mock("./analise", () => ({
  MAX_TENTATIVAS: 3,
  analisarAnexo: async (anexo: Anexo) => {
    analisadas.push(anexo.chave);
    const r = respostas[anexo.kind] ?? { texto: `lido:${anexo.nome}` };
    return {
      chave: anexo.chave,
      kind: anexo.kind,
      status: r.texto ? MediaStatus.OK : MediaStatus.ERROR,
      texto: r.texto,
      erro: r.erro ?? null,
      doCache: vindoDoCache.has(anexo.chave),
    };
  },
}));

const { enriquecerComMidia, marcarAnexosSemLeitura, JANELA_DE_ANEXOS } =
  await import("./enriquecer");

function ctx(extra: Partial<ReturnType<typeof lerConfigOpenAI>> = {}) {
  return {
    cliente: {} as never,
    config: { ...lerConfigOpenAI({}), ...extra },
  };
}

function msg(
  id: number,
  tipo: 0 | 1,
  content: string | null,
  attachments?: unknown[],
): MensagemChatwoot {
  return { id, message_type: tipo, content, attachments };
}

const AUDIO = { id: 1, file_type: "audio", data_url: "https://cw/a.ogg" };
const IMAGEM = { id: 2, file_type: "image", data_url: "https://cw/p.png" };

beforeEach(() => {
  analisadas = [];
  respostas = {};
  vindoDoCache = new Set();
});

describe("enriquecimento das mensagens com mídia", () => {
  it("a mensagem que só tinha áudio passa a ter conteúdo", async () => {
    respostas[MediaKind.AUDIO] = { texto: "quero uma sala amanhã" };

    const { mensagens } = await enriquecerComMidia(
      [msg(1, 0, null, [AUDIO])],
      ctx(),
    );

    expect(mensagens[0].content).toContain("áudio transcrito");
    expect(mensagens[0].content).toContain("quero uma sala amanhã");
  });

  it("o áudio transcrito chega ao contexto do agente", async () => {
    // O teste que importa de verdade: antes, `montarContexto` devolvia null
    // porque a mensagem estava vazia — e o cliente ficava sem resposta.
    respostas[MediaKind.AUDIO] = { texto: "quero uma sala amanhã" };

    const cru = [msg(1, 1, "Olá! Como posso ajudar?"), msg(2, 0, null, [AUDIO])];
    expect(montarContexto(cru)).toBeNull();

    const { mensagens } = await enriquecerComMidia(cru, ctx());
    const contexto = montarContexto(mensagens);

    expect(contexto).not.toBeNull();
    expect(contexto!.mensagem).toContain("quero uma sala amanhã");
    expect(contexto!.historico).toHaveLength(1);
  });

  it("mensagem sem anexo não é tocada e não custa nada", async () => {
    const cru = [msg(1, 0, "oi")];
    const { mensagens } = await enriquecerComMidia(cru, ctx());

    expect(mensagens).toBe(cru); // mesma referência: nada foi refeito
    expect(analisadas).toEqual([]);
  });

  it("o mesmo arquivo em duas mensagens é lido uma vez só", async () => {
    // Reencaminhar o mesmo anexo não pode dobrar a conta — e duas leituras
    // simultâneas da mesma chave brigariam no upsert.
    const { mensagens } = await enriquecerComMidia(
      [msg(1, 0, null, [AUDIO]), msg(2, 0, "e esse?", [AUDIO])],
      ctx(),
    );

    expect(analisadas).toEqual(["chatwoot:1"]);
    expect(mensagens[0].content).toContain("áudio transcrito");
    expect(mensagens[1].content).toContain("áudio transcrito");
  });

  it("respeita o teto por turno e avisa o que ficou para depois", async () => {
    const anexos = Array.from({ length: 5 }, (_, i) => ({
      id: 100 + i,
      file_type: "image",
      data_url: `https://cw/${i}.png`,
    }));

    const { mensagens, resumo } = await enriquecerComMidia(
      [msg(1, 0, "olha", anexos)],
      ctx({ maxAnexosPorTurno: 2 }),
    );

    expect(analisadas).toHaveLength(2);
    expect(resumo.adiados).toBe(3);
    expect(mensagens[0].content).toContain("ainda não lido");
  });

  it("não lê anexo fora da janela que chegaria ao modelo", async () => {
    // Ler anexo de mensagem que o corte de histórico vai descartar é dinheiro
    // jogado fora.
    const antigas = Array.from({ length: JANELA_DE_ANEXOS + 5 }, (_, i) =>
      msg(i + 1, 0, `linha ${i}`),
    );
    antigas[0] = msg(1, 0, null, [AUDIO]);

    await enriquecerComMidia(antigas, ctx());

    expect(analisadas).toEqual([]);
  });

  it("falha de leitura vira texto, não silêncio", async () => {
    respostas[MediaKind.IMAGE] = { texto: null, erro: "OpenAI fora do ar" };

    const { mensagens, resumo } = await enriquecerComMidia(
      [msg(1, 0, null, [IMAGEM])],
      ctx(),
    );

    expect(mensagens[0].content).toContain("[imagem");
    expect(mensagens[0].content).toContain("OpenAI fora do ar");
    expect(resumo.falhas).toBe(1);
    // E o contexto continua existindo: o cliente recebe resposta.
    expect(montarContexto(mensagens)).not.toBeNull();
  });

  it("o que vem do cache não conta como processado", async () => {
    vindoDoCache.add("chatwoot:1");

    const { resumo } = await enriquecerComMidia([msg(1, 0, null, [AUDIO])], ctx());

    expect(resumo.processados).toBe(0);
    expect(resumo.lidos).toBe(1);
  });

  it("não lê anexo que a própria equipe enviou", async () => {
    // Descrever o PDF que nós mesmos mandamos é pagar para ler o que já
    // sabemos. Sai do contexto como sempre esteve.
    const { mensagens } = await enriquecerComMidia(
      [msg(1, 1, null, [IMAGEM]), msg(2, 0, "chegou?")],
      ctx(),
    );

    expect(analisadas).toEqual([]);
    expect(mensagens[0].content).toBeNull();
  });

  it("vídeo e localização viram contexto sem chamar modelo", async () => {
    const { mensagens } = await enriquecerComMidia(
      [
        msg(1, 0, null, [
          { id: 7, file_type: "video", data_url: "https://cw/v.mp4" },
        ]),
      ],
      ctx(),
    );

    expect(mensagens[0].content).toContain("anexo não lido");
  });
});

describe("quando a leitura de mídia está desligada", () => {
  it("a mensagem diz que chegou anexo em vez de ficar vazia", async () => {
    // Sem isto, o agente responde "não entendi" sem nunca dizer que havia um
    // áudio, e o cliente reenvia o mesmo áudio para sempre.
    const mensagens = marcarAnexosSemLeitura([msg(1, 0, null, [AUDIO])]);

    expect(mensagens[0].content).toContain("leitura de mídia está desligada");
    expect(montarContexto(mensagens)).not.toBeNull();
  });

  it("preserva o texto que o cliente digitou", () => {
    const mensagens = marcarAnexosSemLeitura([msg(1, 0, "olha isso", [IMAGEM])]);

    expect(mensagens[0].content?.startsWith("olha isso")).toBe(true);
  });

  it("não mexe em mensagem sem anexo", () => {
    const cru = [msg(1, 0, "oi")];
    expect(marcarAnexosSemLeitura(cru)[0]).toBe(cru[0]);
  });
});
