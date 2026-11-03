import { describe, expect, it } from "vitest";
import {
  chaveDoEnvio,
  configDoFormulario,
  conversaDoCliente,
  hashDoTelefone,
  hashDoToken,
  lerConfigBoasVindas,
  lerMacro,
  nomeParaOTemplate,
  notaDeEnvio,
  notaDeFalha,
  prefixoDoEnvio,
  providenciaDoDono,
  telefoneDoContato,
  textoDoTemplate,
  tokenDoEnderecoConfere,
  type MotivoDeFalha,
} from "./regras";

// Só dados fictícios: nome, telefone e ids inventados para o teste.
const macro = (sobre: Record<string, unknown> = {}) => ({
  event: "macro.executed",
  id: 5001,
  inbox_id: 31,
  status: "resolved",
  meta: {
    sender: { id: 77, name: "Maria Teste", phone_number: "+558499990000", identifier: null },
    assignee: { id: 12, name: "Alan Teste" },
    assignee_type: "User",
  },
  ...sobre,
});

describe("config", () => {
  it("sem nada gravado, os padrões são os do fluxo antigo — menos o canal, que não vai para o código", () => {
    const c = lerConfigBoasVindas(undefined);
    expect(c).toMatchObject({
      canalId: "",
      template: "template_diego2",
      parametro: "texto",
      idioma: "pt_BR",
      caixaDoCliente: 29,
      minutosSemReenvio: 10,
      tetoPorHora: 60,
      tokenHash: null,
    });
  });

  it("⚠ config inválida cai nos padrões, mas NÃO perde o token do endereço", () => {
    const c = lerConfigBoasVindas({ minutosSemReenvio: 99999, tokenHash: "abc", tokenGeradoEm: "2026-11-03T10:00:00Z" });
    expect(c.minutosSemReenvio).toBe(10);
    expect(c.tokenHash).toBe("abc");
    expect(c.tokenGeradoEm).toBe("2026-11-03T10:00:00Z");
  });

  const atual = lerConfigBoasVindas({ tokenHash: "hash-que-ja-estava", tokenGeradoEm: "2026-11-01T00:00:00Z" });
  const form = (campos: Record<string, string>) => (campo: string) => campos[campo] ?? null;
  const preenchido = {
    canalId: "canal-1",
    template: "template_x",
    parametro: "nome",
    idioma: "pt_BR",
    caixaDoCliente: "29",
    minutosSemReenvio: "15",
    tetoPorHora: "30",
  };

  it("o formulário vira config e mantém o token do endereço que já estava gravado", () => {
    const r = configDoFormulario(form(preenchido), atual);
    expect("config" in r && r.config).toMatchObject({
      canalId: "canal-1",
      template: "template_x",
      minutosSemReenvio: 15,
      tetoPorHora: 30,
      tokenHash: "hash-que-ja-estava",
      tokenGeradoEm: "2026-11-01T00:00:00Z",
    });
  });

  it("número em branco é recusa (Number('') é 0) e o erro nomeia o campo", () => {
    const r = configDoFormulario(form({ ...preenchido, minutosSemReenvio: "" }), atual);
    expect(r).toEqual({ erro: "Minutos sem reenvio (inteiro, de 1 a 240): valor inválido ou em branco." });
  });

  it("recusa o que passa do limite", () => {
    expect("erro" in configDoFormulario(form({ ...preenchido, tetoPorHora: "9999" }), atual)).toBe(true);
    expect("erro" in configDoFormulario(form({ ...preenchido, caixaDoCliente: "0" }), atual)).toBe(true);
  });
});

describe("token do endereço", () => {
  it("confere pelo hash, e nada confere sem hash guardado", () => {
    const hash = hashDoToken("segredo");
    expect(tokenDoEnderecoConfere("segredo", hash)).toBe(true);
    expect(tokenDoEnderecoConfere("outro", hash)).toBe(false);
    expect(tokenDoEnderecoConfere("segredo", null)).toBe(false);
    expect(tokenDoEnderecoConfere("", hash)).toBe(false);
    expect(tokenDoEnderecoConfere("segredo", "não é hex")).toBe(false);
  });
});

describe("o corpo da macro", () => {
  it("lê conversa, caixa, contato, nome, telefone em dígitos e quem clicou", () => {
    const r = lerMacro(macro());
    expect(r).toEqual({
      ok: true,
      macro: {
        conversaId: 5001,
        caixaId: 31,
        contatoId: 77,
        nome: "Maria Teste",
        telefone: "558499990000",
        clique: { id: 12, nome: "Alan Teste" },
      },
    });
  });

  it("⚠ só o evento da macro vale: qualquer outra coisa mandada ao endereço é ignorada", () => {
    expect(lerMacro(macro({ event: "message_created" }))).toEqual({
      ok: false,
      motivo: "o evento não é de macro (message_created)",
    });
    expect(lerMacro({ id: 1 })).toMatchObject({ ok: false, motivo: expect.stringContaining("sem evento") });
    expect(lerMacro(null)).toMatchObject({ ok: false });
    expect(lerMacro("texto")).toMatchObject({ ok: false });
  });

  it("sem o número da conversa não há onde avisar", () => {
    expect(lerMacro(macro({ id: undefined }))).toEqual({
      ok: false,
      motivo: "o corpo veio sem o número da conversa",
    });
  });

  it("sem quem clicou, a macro vale e a atribuição fica de fora", () => {
    const r = lerMacro(macro({ meta: { sender: { id: 77, name: "Maria Teste", phone_number: "+558499990000" } } }));
    expect(r).toMatchObject({ ok: true, macro: { clique: null } });
  });

  describe("telefone", () => {
    it("prefere o campo de telefone e aceita o identificador da WAHA como segunda chance", () => {
      expect(telefoneDoContato({ phone_number: "+55 (84) 99999-0000" })).toBe("5584999990000");
      expect(telefoneDoContato({ phone_number: null, identifier: "5584999990000@s.whatsapp.net" })).toBe("5584999990000");
      expect(telefoneDoContato({ phone_number: "", identifier: "5584999990000@c.us" })).toBe("5584999990000");
    });

    it("⚠ @lid e grupo NÃO são telefone", () => {
      expect(telefoneDoContato({ identifier: "5584999990000@lid" })).toBeNull();
      expect(telefoneDoContato({ identifier: "5584999990000@g.us" })).toBeNull();
    });

    it("número curto demais ou longo demais não é telefone", () => {
      expect(telefoneDoContato({ phone_number: "12345" })).toBeNull();
      expect(telefoneDoContato({ phone_number: "1234567890123456" })).toBeNull();
      expect(telefoneDoContato({})).toBeNull();
    });
  });
});

describe("o nome no template", () => {
  it("o WhatsApp recusa quebra de linha, tabulação e espaços demais no parâmetro", () => {
    expect(nomeParaOTemplate("  Maria\nTeste\t da    Silva ")).toBe("Maria Teste da Silva");
  });

  it("sem nome, 'cliente' — parâmetro vazio também é recusado", () => {
    expect(nomeParaOTemplate("")).toBe("cliente");
    expect(nomeParaOTemplate(null)).toBe("cliente");
    expect(nomeParaOTemplate("  \n ")).toBe("cliente");
  });

  it("corta nome absurdamente longo", () => {
    expect(nomeParaOTemplate("a".repeat(300))).toHaveLength(100);
  });
});

describe("o texto do template", () => {
  it("troca os parâmetros e deixa como está o que não tem valor", () => {
    const corpo = "Olá, {{texto}}.\n\nConforme solicitado, iniciamos seu atendimento pelo WhatsApp.";
    expect(textoDoTemplate(corpo, { texto: "Maria Teste" })).toBe(
      "Olá, Maria Teste.\n\nConforme solicitado, iniciamos seu atendimento pelo WhatsApp.",
    );
    expect(textoDoTemplate("{{ outro }} e {{texto}}", { texto: "A" })).toBe("{{ outro }} e A");
  });
});

describe("um clique, um envio", () => {
  const agora = new Date("2026-11-03T14:02:51Z");

  it("o mesmo número, no mesmo intervalo, tem a MESMA chave — é a trava do banco", () => {
    expect(chaveDoEnvio("5584999990000", agora, 10)).toBe(
      chaveDoEnvio("5584999990000", new Date(agora.getTime() + 60_000), 10),
    );
  });

  it("outro intervalo, outra chave", () => {
    expect(chaveDoEnvio("5584999990000", agora, 10)).not.toBe(
      chaveDoEnvio("5584999990000", new Date(agora.getTime() + 11 * 60_000), 10),
    );
  });

  it("o número com e sem o nono dígito é o MESMO número", () => {
    expect(hashDoTelefone("558499990000")).toBe(hashDoTelefone("5584999990000"));
    expect(hashDoTelefone("5584999990000")).not.toBe(hashDoTelefone("5584999990001"));
  });

  it("a chave não carrega o telefone: a entrega é lida pela equipe toda", () => {
    const chave = chaveDoEnvio("5584999990000", agora, 10);
    expect(chave).not.toContain("999990000");
    expect(chave.startsWith(prefixoDoEnvio("5584999990000"))).toBe(true);
  });
});

describe("a conversa do cliente", () => {
  it("é a mais recente da caixa do WhatsApp oficial, não a de outra caixa", () => {
    const conversas = [
      { id: 100, caixaId: 29 },
      { id: 300, caixaId: 31 },
      { id: 200, caixaId: 29 },
    ];
    expect(conversaDoCliente(conversas, 29)).toBe(200);
  });

  it("sem conversa na caixa, nada — e quem chama decide o que fazer", () => {
    expect(conversaDoCliente([{ id: 300, caixaId: 31 }], 29)).toBeNull();
    expect(conversaDoCliente([], 29)).toBeNull();
  });
});

describe("quem fica com a conversa", () => {
  const base = { status: "open", assigneeId: null, assigneeTipo: null, assigneeNome: null };

  it("⚠ pessoa já é dona: a conversa continua com ela", () => {
    expect(
      providenciaDoDono({ ...base, assigneeId: 5, assigneeTipo: "User", assigneeNome: "Joana Teste" }, 12),
    ).toEqual({ acao: "manter", com: "Joana Teste" });
  });

  it("⚠ dono de tipo desconhecido também fica: na dúvida, não tira de ninguém", () => {
    expect(providenciaDoDono({ ...base, assigneeId: 5, assigneeTipo: null, assigneeNome: null }, 12)).toEqual({
      acao: "manter",
      com: "outra pessoa",
    });
  });

  it("o nosso robô não é dono de ninguém: a conversa vai para quem clicou", () => {
    expect(providenciaDoDono({ ...base, assigneeId: 4, assigneeTipo: "AgentBot" }, 12)).toEqual({
      acao: "assumir",
      reabrir: false,
      atribuir: true,
    });
  });

  it("sem dono: atribui; resolvida ou pendente, reabre antes", () => {
    expect(providenciaDoDono(base, 12)).toEqual({ acao: "assumir", reabrir: false, atribuir: true });
    expect(providenciaDoDono({ ...base, status: "resolved" }, 12)).toEqual({ acao: "assumir", reabrir: true, atribuir: true });
    expect(providenciaDoDono({ ...base, status: "pending" }, 12)).toEqual({ acao: "assumir", reabrir: true, atribuir: true });
  });

  it("sem saber quem clicou, reabre mas não atribui", () => {
    expect(providenciaDoDono({ ...base, status: "resolved" }, null)).toEqual({
      acao: "assumir",
      reabrir: true,
      atribuir: false,
    });
  });
});

describe("as notas", () => {
  it("a nota de envio começa EXATAMENTE como a do fluxo antigo, e diz quem disparou e o que ficou", () => {
    const nota = notaDeEnvio({
      template: "template_diego2",
      texto: "Olá, Maria Teste.\n\nConforme solicitado, iniciamos seu atendimento pelo WhatsApp.",
      quem: "Alan Teste",
      destino: "Conversa atribuída a Alan Teste.",
      problemas: ["algo deu errado"],
    });
    expect(nota.startsWith('Template enviado: "template_diego2"\n\nMensagem:\n\nOlá, Maria Teste.')).toBe(true);
    expect(nota).toContain('Disparado por Alan Teste pela macro "Disparar Template Boas Vindas".');
    expect(nota).toContain("Conversa atribuída a Alan Teste.");
    expect(nota).toContain("⚠ algo deu errado");
  });

  it("sem o texto do template, a nota diz que não conseguiu ler — não inventa", () => {
    const nota = notaDeEnvio({ template: "t", texto: null, quem: null, destino: null, problemas: [] });
    expect(nota).toContain("(não consegui ler o texto do template na NotificaMe)");
    expect(nota).toContain('Disparado pela macro "Disparar Template Boas Vindas".');
  });

  it("⚠ toda falha diz com todas as letras que o template NÃO saiu — ou que PODE ter saído", () => {
    const motivos: MotivoDeFalha[] = [
      { tipo: "desligado" },
      { tipo: "sem-credencial" },
      { tipo: "sem-telefone" },
      { tipo: "repetido", minutosAtras: 3, espera: 10 },
      { tipo: "teto", teto: 60 },
      { tipo: "recusado", detalhe: "NotificaMe respondeu 400" },
    ];
    for (const m of motivos) expect(notaDeFalha(m)).toMatch(/NÃO (enviado|reenviado)/);
    expect(notaDeFalha({ tipo: "incerto", detalhe: "socket hang up" })).toMatch(/PODE ter saído/);
    expect(notaDeFalha({ tipo: "repetido", minutosAtras: 3, espera: 10 })).toContain("há 3 min");
  });
});
