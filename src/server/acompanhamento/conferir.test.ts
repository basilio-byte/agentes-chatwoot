import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rodada do acompanhamento com banco, ClickUp, Conexa, ZapSign e Chatwoot
 * simulados.
 *
 * O que estes casos protegem é a EXCEÇÃO: o sistema fala dentro de uma conversa
 * que está com um vendedor. Falhar aqui não é um registro errado — é uma
 * mensagem indevida no WhatsApp de um cliente.
 */

// Terça-feira, 12h em São Paulo.
const AGORA = new Date("2026-11-10T15:00:00Z");
const TASK = "86adm4t1k";
const CAMPO_CELULAR = "3399c6f6-c890-40a6-865e-5a4e810fe8c6";
const CAMPO_RESPONSAVEL = "feaf1d19-755e-4b84-850a-b1ad42ee5957";

type Linha = { id: string; provider: string; externalId: string; resultado: string | null; detalhe?: string | null };

let ligada = true;
let eventos: Linha[] = [];
let chamadas: Array<Record<string, unknown>> = [];
let tarefas: Array<Record<string, unknown>> = [];
let cobrancas: Array<Record<string, unknown>> = [];
let vendas: Record<number, Record<string, unknown>> = {};
let documento: Record<string, unknown> | null = null;
let conversas: Array<Record<string, unknown>> = [];
let mensagens: Array<Record<string, unknown>> = [];
let enviadas: Array<{ conversa: number; texto: string; privado: boolean }> = [];
let noClickUp: string[] = [];
let statusDaConversa = "open";
/** O campo "Contrato Assinado" da task, que a trava do ClickBot lê. */
let campoContrato: unknown = null;
let uploadFalha = false;
let zapsignDoc: Record<string, unknown> | null = null;

vi.mock("@/lib/db", () => ({
  db: {
    integration: {
      findUnique: async ({ where }: { where: { provider: string } }) =>
        where.provider === "ACOMPANHAMENTO"
          ? { enabled: ligada }
          : { enabled: true, credential: "cifrado", config: {} },
    },
    toolCall: { findMany: async () => chamadas },
    webhookEvent: {
      findMany: async ({ where }: { where: { externalId?: { endsWith?: string; startsWith?: string } } }) =>
        eventos.filter((e) =>
          where.externalId?.endsWith
            ? e.externalId.endsWith(where.externalId.endsWith)
            : e.externalId.startsWith(where.externalId?.startsWith ?? ""),
        ),
      create: async ({ data }: { data: Omit<Linha, "id"> }) => {
        if (eventos.some((e) => e.provider === data.provider && e.externalId === data.externalId)) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const linha = { id: `e${eventos.length + 1}`, ...data };
        eventos.push(linha);
        return linha;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Linha> }) =>
        Object.assign(eventos.find((e) => e.id === where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => {
        eventos = eventos.filter((e) => e.id !== where.id);
      },
      upsert: async ({ create }: { create: Omit<Linha, "id"> }) => {
        const existe = eventos.find(
          (e) => e.provider === create.provider && e.externalId === create.externalId,
        );
        if (existe) return Object.assign(existe, create);
        const linha = { id: `e${eventos.length + 1}`, ...create };
        eventos.push(linha);
        return linha;
      },
    },
  },
}));

vi.mock("@/lib/crypto", () => ({ decifrar: () => "token" }));

// Só `abrirZapSignCru` é dublada: `anexarContratoAssinado` e `campoTemArquivo`
// rodam de verdade, que é o que estes casos existem para proteger.
vi.mock("./anexo", async (importOriginal) => {
  const real = await importOriginal<typeof import("./anexo")>();
  return {
    ...real,
    abrirZapSignCru: async () =>
      zapsignDoc ? { cliente: { detalhar: async () => zapsignDoc } } : null,
  };
});

vi.mock("@/server/integrations/clickup/sistema", () => ({
  abrirClickUp: async () => ({
    cliente: {
      listarTarefasDaLista: async () => ({ tasks: tarefas }),
      comentarTarefa: async (id: string, texto: string) => {
        noClickUp.push(`comentario:${id}:${texto.slice(0, 30)}`);
      },
      removerTag: async (id: string, tag: string) => {
        noClickUp.push(`removeu:${tag}`);
      },
      atualizarTarefa: async (id: string, dados: { status?: string }) => {
        noClickUp.push(`status:${dados.status}`);
      },
      // ⚠ A forma é a REAL do ClickUp: `custom_fields` é lista de {id, value}.
      obterTarefa: async () => ({
        custom_fields: [
          { id: "04047e09-391d-4b43-9357-ddd15a2b9531", value: campoContrato },
        ],
      }),
      enviarArquivoParaCampo: async () => {
        if (uploadFalha) throw new Error("ClickUp respondeu 400");
        noClickUp.push("upload:contrato");
        return { id: "anexo-1", url: null };
      },
      associarAnexoAoCampo: async () => {
        noClickUp.push("associou:contrato");
        campoContrato = [{ id: "anexo-1" }];
      },
    },
    config: {},
    executar: async () => undefined,
  }),
}));

vi.mock("@/server/integrations/conexa/sistema", () => ({
  abrirConexa: async () => ({
    cliente: {
      listarCobrancas: async () => ({ itens: cobrancas }),
      obterVenda: async (id: number) => vendas[id],
    },
    config: {},
    executar: async () => undefined,
  }),
}));

vi.mock("@/server/integrations/zapsign", () => ({
  zapsignIntegration: {
    tools: [{ name: "zapsign_ver_documento", execute: async () => documento }],
  },
}));

const chatwoot = {
  buscarContatos: async () => [
    { id: 7, telefone: "+558482000879", identificador: null, caixas: [{ caixaId: 29, sourceId: "s" }] },
  ],
  conversasDoContato: async () => conversas,
  listarMensagens: async () => mensagens,
  enviarMensagem: async (conversa: number, texto: string, o?: { privado?: boolean }) => {
    enviadas.push({ conversa, texto, privado: o?.privado ?? false });
    return { id: 1 };
  },
  alternarStatus: async (_c: number, s: string) => {
    statusDaConversa = s;
  },
  // ⚠ O campo é `name`, como a API do Chatwoot devolve — não `nome`.
  listarAtendentes: async () => [{ id: 100093068, name: "Alan Novaes", email: "alan@x.com" }],
  atribuir: async (_c: number, d: { assigneeId?: number }) => {
    noClickUp.push(`atribuiu:${d.assigneeId}`);
  },
};

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDeLeitura: async () => ({ cliente: chatwoot, config: {} }),
  clienteDoAgente: async () => chatwoot,
}));

vi.mock("@/server/integrations/chatwoot/porta", () => ({ portaDaCaixa: async () => "porta" }));
vi.mock("@/server/integrations/chatwoot/ausencias-config", () => ({
  opcoesDeAusencia: async () => ({ ausencias: [], hoje: "2026-11-10" }),
}));

const { acompanharContratos } = await import("./conferir");

function tarefa(etiquetas: string[] = ["pagamento pendente", "falta assinatura"]) {
  return {
    id: TASK,
    name: "(5060) CARLA ADRIANA",
    url: "https://app.clickup.com/t/86adm4t1k",
    status: { status: "🏃‍♂️onboarding" },
    tags: etiquetas.map((name) => ({ name })),
    custom_fields: [
      { id: CAMPO_CELULAR, value: "+558482000879" },
      { id: CAMPO_RESPONSAVEL, value: "Carla Adriana de Lima" },
    ],
  };
}

beforeEach(() => {
  ligada = true;
  eventos = [];
  tarefas = [tarefa()];
  chamadas = [
    { runId: "r1", toolName: "clickup_obter_tarefa", input: { taskId: TASK }, output: {}, createdAt: AGORA },
    {
      runId: "r1",
      toolName: "zapsign_gerar_contrato",
      input: {},
      output: {
        documentoId: "doc-abc",
        signatarios: [{ linkParaAssinar: "https://zap/s1", situacao: "nao_abriu" }],
      },
      createdAt: AGORA,
    },
    {
      runId: "r1",
      toolName: "conexa_criar_contrato",
      input: { clienteId: 5060 },
      output: { criado: true, contratoId: 10601 },
      createdAt: AGORA,
    },
  ];
  cobrancas = [
    { chargeId: 19733, status: "unpaid", chargeUrl: "https://conexa/fatura/abc", salesIds: [66423] },
  ];
  vendas = { 66423: { contractId: 10601 } };
  documento = { status: "pending", signatarios: [{ situacao: "nao_abriu" }] };
  conversas = [{ id: 14149, inbox_id: 29, status: "open", last_activity_at: 1000 }].map((c) => ({
    id: c.id,
    caixaId: c.inbox_id,
    status: c.status,
    ultimaAtividadeEm: c.last_activity_at,
  }));
  // Última fala: o cliente, há duas horas — ninguém no meio de uma troca.
  mensagens = [
    {
      id: 5,
      message_type: 0,
      sender: { type: "contact", name: "Carla" },
      created_at: Math.floor(AGORA.getTime() / 1000) - 7200,
    },
  ];
  enviadas = [];
  noClickUp = [];
  statusDaConversa = "open";
  campoContrato = null;
  uploadFalha = false;
  zapsignDoc = { signed_file: "https://zapsign.test/assinado.pdf", deleted: false };

  // O download do assinado é a única coisa que sairia para a rede.
  vi.stubGlobal("fetch", async (url: string | URL) => {
    if (String(url).includes("assinado.pdf")) {
      return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
    }
    throw new Error(`fetch inesperado no teste: ${String(url)}`);
  });
});

describe("o caminho que funciona", () => {
  it("manda a inicial com os dois links e deixa nota para o vendedor", async () => {
    const r = await acompanharContratos({ forcar: true }, AGORA);

    expect(r.acao).toBe("conferido");
    expect(r.enviadas).toBe(1);

    const [aoCliente, aoVendedor] = enviadas;
    expect(aoCliente.privado).toBe(false);
    expect(aoCliente.texto).toContain("Olá, Carla!");
    expect(aoCliente.texto).toContain("https://conexa/fatura/abc");
    expect(aoCliente.texto).toContain("https://zap/s1");

    expect(aoVendedor.privado).toBe(true);
    expect(aoVendedor.texto).toContain("a conversa continua com você");
  });

  it("comenta na task e NÃO tira etiqueta na inicial — nada foi confirmado", async () => {
    await acompanharContratos({ forcar: true }, AGORA);
    expect(noClickUp.some((x) => x.startsWith("comentario:"))).toBe(true);
    expect(noClickUp.some((x) => x.startsWith("removeu:"))).toBe(false);
    expect(noClickUp.some((x) => x.startsWith("status:"))).toBe(false);
  });

  it("⚠ rodar de novo não manda de novo", async () => {
    await acompanharContratos({ forcar: true }, AGORA);
    enviadas = [];
    const r = await acompanharContratos({ forcar: true }, AGORA);
    expect(enviadas).toEqual([]);
    expect(r.enviadas).toBe(0);
  });

  it("pago e assinado: manda a final, tira as DUAS etiquetas e move para ongoing", async () => {
    eventos.push({ id: "e0", provider: "ACOMPANHAMENTO", externalId: `inicial:${TASK}`, resultado: "enviado" });
    cobrancas[0].status = "paid";
    documento = { status: "signed", signatarios: [{ situacao: "assinou" }] };

    await acompanharContratos({ forcar: true }, AGORA);

    expect(enviadas[0].texto).toContain("confirmamos tudo!");
    expect(enviadas[0].texto).not.toContain("http");
    expect(noClickUp).toContain("removeu:pagamento pendente");
    expect(noClickUp).toContain("removeu:falta assinatura");
    // O contrato assinado vai para o campo ANTES de o status andar.
    expect(noClickUp).toContain("upload:contrato");
    expect(noClickUp).toContain("status:ongoing");
    expect(noClickUp.indexOf("upload:contrato")).toBeLessThan(
      noClickUp.indexOf("status:ongoing"),
    );
  });

  /**
   * ⚠⚠ A trava do ClickBot devolve a task de `ongoing` para `onboarding`
   * quando o campo "Contrato Assinado" está vazio. Foi o que aconteceu na
   * primeira contratação real, em 11/11/2026, com tudo o mais pronto. Mover o
   * status sem o anexo faz a task quicar E esta entrega dizer "concluído"
   * sobre algo que não concluiu.
   */
  it("⚠ anexo que não entra: NÃO move o status, e a entrega diz por quê", async () => {
    eventos.push({ id: "e0", provider: "ACOMPANHAMENTO", externalId: `inicial:${TASK}`, resultado: "enviado" });
    cobrancas[0].status = "paid";
    documento = { status: "signed", signatarios: [{ situacao: "assinou" }] };
    uploadFalha = true;

    await acompanharContratos({ forcar: true }, AGORA);

    expect(noClickUp).not.toContain("status:ongoing");
    const linha = eventos.find((e) => e.externalId === `final:${TASK}`);
    expect(linha?.resultado).toBe("enviado com pendência");
    expect(linha?.detalhe).toContain("não movi o status");
  });

  /** O que a equipe já anexou à mão não é substituído, e não trava o status. */
  it("campo já preenchido: não sobe de novo e segue para ongoing", async () => {
    eventos.push({ id: "e0", provider: "ACOMPANHAMENTO", externalId: `inicial:${TASK}`, resultado: "enviado" });
    cobrancas[0].status = "paid";
    documento = { status: "signed", signatarios: [{ situacao: "assinou" }] };
    campoContrato = [{ id: "anexo-da-equipe" }];

    await acompanharContratos({ forcar: true }, AGORA);

    expect(noClickUp).not.toContain("upload:contrato");
    expect(noClickUp).toContain("status:ongoing");
  });

  it("só o pagamento confirmado: manda a de pagamento e tira só aquela etiqueta", async () => {
    eventos.push({ id: "e0", provider: "ACOMPANHAMENTO", externalId: `inicial:${TASK}`, resultado: "enviado" });
    cobrancas[0].status = "paid";

    await acompanharContratos({ forcar: true }, AGORA);

    expect(enviadas[0].texto).toContain("Identificamos o seu pagamento");
    expect(noClickUp).toContain("removeu:pagamento pendente");
    expect(noClickUp).not.toContain("removeu:falta assinatura");
  });
});

describe("quando NÃO fala", () => {
  it("integração desligada: nem abre o ClickUp", async () => {
    ligada = false;
    const r = await acompanharContratos({ forcar: true }, AGORA);
    expect(r.acao).toBe("desligada");
    expect(enviadas).toEqual([]);
  });

  it("⚠⚠ a equipe acabou de escrever: não corta o vendedor, e NÃO reserva", async () => {
    mensagens = [
      {
        id: 9,
        message_type: 1,
        sender: { type: "user", name: "Alan Novaes" },
        created_at: Math.floor(AGORA.getTime() / 1000) - 60,
      },
    ];

    const r = await acompanharContratos({ forcar: true }, AGORA);

    expect(enviadas).toEqual([]);
    expect(r.desfechos?.[0].motivo).toContain("a equipe escreveu");
    // Sem reserva: quando a conversa esfriar, a mensagem ainda sai.
    expect(eventos.some((e) => e.externalId.startsWith("inicial:"))).toBe(false);
  });

  it("⚠⚠ o cliente perguntou e ninguém respondeu: não entra na frente", async () => {
    mensagens = [
      {
        id: 9,
        message_type: 0,
        sender: { type: "contact" },
        created_at: Math.floor(AGORA.getTime() / 1000) - 120,
      },
    ];

    const r = await acompanharContratos({ forcar: true }, AGORA);

    expect(enviadas).toEqual([]);
    expect(r.desfechos?.[0].motivo).toContain("ainda não foi respondido");
  });

  it("task sem CELULAR não vira mensagem", async () => {
    tarefas = [{ ...tarefa(), custom_fields: [{ id: CAMPO_RESPONSAVEL, value: "Carla" }] }];
    const r = await acompanharContratos({ forcar: true }, AGORA);
    expect(enviadas).toEqual([]);
    expect(r.desfechos?.[0].motivo).toContain("sem CELULAR");
  });

  it("sem contrato nem documento gerados, não inventa links", async () => {
    chamadas = [];
    const r = await acompanharContratos({ forcar: true }, AGORA);
    expect(enviadas).toEqual([]);
    expect(r.desfechos?.[0].motivo).toContain("não achei o contrato");
  });

  it("⚠ sem a cobrança do contrato ainda criada, espera em vez de mandar meia mensagem", async () => {
    cobrancas = [];
    const r = await acompanharContratos({ forcar: true }, AGORA);
    expect(enviadas).toEqual([]);
    expect(r.desfechos?.[0].motivo).toContain("aguardando a cobrança");
  });

  it("⚠ cobrança de OUTRO produto do mesmo cliente não vira link de pagamento", async () => {
    vendas = { 66423: { contractId: 99999 } };
    const r = await acompanharContratos({ forcar: true }, AGORA);
    expect(enviadas).toEqual([]);
    expect(r.desfechos?.[0].motivo).toContain("aguardando a cobrança");
  });

  it("task que saiu do ciclo (sem etiqueta) não é tratada", async () => {
    tarefas = [tarefa([])];
    const r = await acompanharContratos({ forcar: true }, AGORA);
    expect(r.tarefas).toBe(0);
    expect(enviadas).toEqual([]);
  });
});

describe("conversa resolvida", () => {
  beforeEach(() => {
    conversas = [{ id: 14149, caixaId: 29, status: "resolved", ultimaAtividadeEm: 1000 }];
  });

  it("⚠ reabre e devolve a quem atendeu por último, e só então fala", async () => {
    mensagens = [
      {
        id: 4,
        message_type: 1,
        sender: { type: "user", name: "Alan Novaes" },
        created_at: Math.floor(AGORA.getTime() / 1000) - 7200,
      },
    ];

    await acompanharContratos({ forcar: true }, AGORA);

    expect(statusDaConversa).toBe("open");
    expect(noClickUp).toContain("atribuiu:100093068");
    expect(enviadas.length).toBe(2);
  });

  it("⚠ sem ninguém no histórico para devolver, NÃO fala", async () => {
    mensagens = [
      {
        id: 4,
        message_type: 0,
        sender: { type: "contact" },
        created_at: Math.floor(AGORA.getTime() / 1000) - 7200,
      },
    ];

    const r = await acompanharContratos({ forcar: true }, AGORA);

    expect(enviadas).toEqual([]);
    expect(r.desfechos?.[0].motivo).toContain("não achei quem atendeu");
  });
});
