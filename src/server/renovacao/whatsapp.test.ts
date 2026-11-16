import { describe, expect, it } from "vitest";

import {
  ATRIBUIR_A_PADRAO,
  CAMPO_CELULAR,
  CHAVE_DO_RESUMO,
  chaveDaFalha,
  chaveDoEnsaio,
  chaveDoEnvio,
  CODIGOS_SILENCIOSOS,
  comentarioDeEnvio,
  comentarioDeFalha,
  comentarioDeIncerto,
  dadosDoFormulario,
  decidirAviso,
  dentroDoHorarioComercial,
  ehClienteOne,
  ehRecusaClara,
  finalDoTelefone,
  JANELA_EM_HORAS,
  nomeDoContato,
  notaDaConversa,
  recusaDoTexto,
  responsavelDaTarefa,
  telefoneDaTarefaOne,
  TEXTO_PADRAO_ONE,
  textoDaMensagem,
  type TarefaParaAvisar,
} from "./whatsapp";

// Segunda-feira, 10h em São Paulo.
const AGORA = new Date("2026-11-16T13:00:00Z");
const HA_2_DIAS = AGORA.getTime() - 48 * 3_600_000;

const tarefa = (extra: Partial<TarefaParaAvisar> = {}): TarefaParaAvisar => ({
  id: "t1",
  nome: "(1234) LOJA EXEMPLO",
  status: "notificação renovação",
  entrouEmMs: HA_2_DIAS,
  categoria: "ONE",
  telefone: "+5584998765432",
  ...extra,
});

describe("o texto da mensagem", () => {
  it("o padrão é o do fluxo do n8n, letra por letra", () => {
    // Os trechos que a equipe conhece — se um mudar, foi de propósito.
    expect(TEXTO_PADRAO_ONE).toContain("Prezado(a) {responsavel},");
    expect(TEXTO_PADRAO_ONE).toContain("Esperamos que esta mensagem o(a) encontre bem.");
    expect(TEXTO_PADRAO_ONE).toContain(
      "o reajuste do valor seguirá o Índice Geral de Preços – Mercado (IGP-M), conforme estabelecido no contrato vigente.",
    );
    expect(TEXTO_PADRAO_ONE).toContain("manter uma relação de parceria com nossos lojistas.");
    expect(TEXTO_PADRAO_ONE.endsWith("entre em contato conosco.")).toBe(true);
  });

  it("o nome do responsável entra no lugar do marcador", () => {
    const t = textoDaMensagem(null, "Maria Souza");
    expect(t.startsWith("Prezado(a) Maria Souza,\n\nEsperamos")).toBe(true);
    expect(t).not.toContain("{responsavel}");
  });

  it("⚠ sem nome, sai 'Prezado(a),' — nunca 'Prezado(a) ,' nem o marcador cru", () => {
    for (const vazio of [null, "", "   "]) {
      const t = textoDaMensagem(null, vazio);
      expect(t.startsWith("Prezado(a),\n")).toBe(true);
      expect(t).not.toContain("{responsavel}");
    }
  });

  it("nome com quebra de linha e espaço sobrando vira uma linha só, e é cortado em 80", () => {
    expect(textoDaMensagem(null, "  Maria \n  Souza  ")).toContain("Prezado(a) Maria Souza,");
    expect(textoDaMensagem(null, "x".repeat(200))).toContain(`Prezado(a) ${"x".repeat(80)},`);
  });

  it("texto editado na tela vale no lugar do padrão", () => {
    expect(textoDaMensagem("Olá {responsavel}, tudo bem? Falamos do reajuste.", "Ana")).toBe(
      "Olá Ana, tudo bem? Falamos do reajuste.",
    );
  });

  it("o texto recusa o que sairia torto para o cliente", () => {
    expect(recusaDoTexto("curto")).toMatch(/de 40 a 1500/);
    expect(recusaDoTexto("x".repeat(1501))).toMatch(/de 40 a 1500/);
    // `{nome}` escrito errado sairia LITERAL no WhatsApp do cliente.
    expect(recusaDoTexto("Olá {nome}, ".padEnd(60, "x"))).toContain("{nome}");
    expect(recusaDoTexto("Olá {responsavel}, ".padEnd(60, "x"))).toBeNull();
    expect(recusaDoTexto(TEXTO_PADRAO_ONE)).toBeNull();
  });
});

describe("decidirAviso", () => {
  it("manda para o cliente ONE que entrou em notificação há pouco", () => {
    expect(decidirAviso(tarefa(), AGORA)).toEqual({ enviar: true, entrouEmMs: HA_2_DIAS });
  });

  it("⚠ só a categoria ONE — as outras já recebem o e-mail e não têm WhatsApp hoje", () => {
    for (const categoria of ["Serviços de endereço", "Salas privativas", null]) {
      const d = decidirAviso(tarefa({ categoria }), AGORA);
      expect(d).toMatchObject({ enviar: false, codigo: "nao-one" });
    }
    expect(ehClienteOne(" one ")).toBe(true);
    expect(ehClienteOne("ONE")).toBe(true);
    expect(ehClienteOne("Phone")).toBe(false);
  });

  it("outro status não recebe, mesmo sendo ONE", () => {
    expect(decidirAviso(tarefa({ status: "renovação" }), AGORA)).toMatchObject({
      enviar: false,
      codigo: "outro-status",
    });
    expect(decidirAviso(tarefa({ status: "NOTIFICAÇÃO RENOVAÇÃO" }), AGORA).enviar).toBe(true);
  });

  it("⚠ a mensagem é do momento da passagem: quem está há mais de 4 dias no status não recebe", () => {
    const d = decidirAviso(tarefa({ entrouEmMs: AGORA.getTime() - (JANELA_EM_HORAS + 1) * 3_600_000 }), AGORA);
    expect(d).toMatchObject({ enviar: false, codigo: "fora-da-janela" });
    expect(decidirAviso(tarefa({ entrouEmMs: AGORA.getTime() - JANELA_EM_HORAS * 3_600_000 }), AGORA).enviar).toBe(true);
  });

  it("sem leitura de desde quando, não manda e pede olho humano (não é silêncio)", () => {
    const d = decidirAviso(tarefa({ entrouEmMs: null }), AGORA);
    expect(d).toMatchObject({ enviar: false, codigo: "sem-leitura" });
    expect(CODIGOS_SILENCIOSOS).not.toContain("sem-leitura");
  });

  it("sem CELULAR válido não manda e também não é silêncio", () => {
    const d = decidirAviso(tarefa({ telefone: null }), AGORA);
    expect(d).toMatchObject({ enviar: false, codigo: "sem-celular" });
    expect(CODIGOS_SILENCIOSOS).not.toContain("sem-celular");
  });

  it("os casos normais são silenciosos: outro status, outra categoria, fora da janela", () => {
    expect([...CODIGOS_SILENCIOSOS].sort()).toEqual(["fora-da-janela", "nao-one", "outro-status"]);
  });
});

describe("os dados da tarefa", () => {
  it("o telefone é o do campo CELULAR, em E.164", () => {
    expect(telefoneDaTarefaOne({ custom_fields: [{ id: CAMPO_CELULAR, value: "+55 84 99876 5432" }] })).toBe(
      "+5584998765432",
    );
    expect(telefoneDaTarefaOne({ custom_fields: [{ id: CAMPO_CELULAR, value: 84998765432 }] })).toBe(
      "+5584998765432",
    );
  });

  it("sem o campo, sem valor ou com número que não dá para usar: nulo, nunca um número adivinhado", () => {
    expect(telefoneDaTarefaOne({ custom_fields: [] })).toBeNull();
    expect(telefoneDaTarefaOne({ custom_fields: [{ id: "outro", value: "+5584998765432" }] })).toBeNull();
    expect(telefoneDaTarefaOne({ custom_fields: [{ id: CAMPO_CELULAR, value: "123" }] })).toBeNull();
    expect(telefoneDaTarefaOne({ custom_fields: [{ id: CAMPO_CELULAR, value: null }] })).toBeNull();
  });

  it("o nome vem do RESPONSÁVEL (campo do cliente), com ou sem acento e caixa", () => {
    expect(responsavelDaTarefa({ RESPONSÁVEL: " Maria " })).toBe("Maria");
    expect(responsavelDaTarefa({ responsavel: "Maria" })).toBe("Maria");
    expect(responsavelDaTarefa({ "E-mail do responsável": "m@x.test" })).toBeNull();
    expect(responsavelDaTarefa({ RESPONSÁVEL: "  " })).toBeNull();
  });

  it("o contato novo leva o responsável, ou a empresa sem o '(1234)' do início", () => {
    expect(nomeDoContato("(1234) LOJA EXEMPLO", "Maria")).toBe("Maria");
    expect(nomeDoContato("(1234) LOJA EXEMPLO", null)).toBe("LOJA EXEMPLO");
    expect(nomeDoContato("", null)).toBe("Cliente");
  });

  it("⚠ o rastro mostra só os quatro últimos dígitos do telefone", () => {
    expect(finalDoTelefone("+5584998765432")).toBe("…5432");
  });
});

describe("as chaves do rastro", () => {
  it("⚠ a reserva NÃO começa com o prefixo do resumo diário", () => {
    // `mensagens:<dia>` é lido por prefixo; uma reserva com o mesmo prefixo
    // apareceria na lista dos resumos (a colisão que `pagamento:` já teve).
    expect(chaveDoEnvio("t1", 1)).not.toMatch(new RegExp(`^${CHAVE_DO_RESUMO}:`));
    expect(chaveDoEnsaio("t1", 1)).not.toMatch(new RegExp(`^${CHAVE_DO_RESUMO}:`));
    expect(chaveDaFalha("t1", 1, "recusado", "+55")).not.toMatch(new RegExp(`^${CHAVE_DO_RESUMO}:`));
  });

  it("o ensaio não bloqueia o envio de verdade: são chaves diferentes", () => {
    expect(chaveDoEnsaio("t1", 1)).not.toBe(chaveDoEnvio("t1", 1));
    // E uma não é prefixo da outra: a contagem por hora filtra por `whatsapp:`.
    expect(chaveDoEnsaio("t1", 1).startsWith("whatsapp:")).toBe(false);
  });

  it("a chave da falha leva o número: corrigir o CELULAR libera a nova tentativa", () => {
    expect(chaveDaFalha("t1", 1, "recusado", "+5584111111111")).not.toBe(
      chaveDaFalha("t1", 1, "recusado", "+5584222222222"),
    );
    expect(chaveDaFalha("t1", 1, "recusado", "+5584111111111")).toBe(
      chaveDaFalha("t1", 1, "recusado", "+5584111111111"),
    );
  });

  it("⚠ mas o telefone não aparece na chave: é texto de uma tabela que a equipe lê", () => {
    expect(chaveDaFalha("t1", 1, "recusado", "+5584998765432")).not.toContain("998765432");
  });
});

describe("os textos para a equipe", () => {
  it("o comentário do envio diz quando, onde e o que ficou", () => {
    const c = comentarioDeEnvio({
      quando: "16/11/2026 às 10:00",
      linkDaConversa: "https://chatwoot.test/app/accounts/1/conversations/9",
      destino: "Conversa atribuída a Felipe Fragoso.",
      problemas: ["não consegui deixar a nota interna na conversa."],
    });
    expect(c).toContain("enviado ao cliente em 16/11/2026 às 10:00");
    expect(c).toContain("conversations/9");
    expect(c).toContain("atribuída a Felipe Fragoso");
    expect(c).toContain("⚠ não consegui deixar a nota interna");
  });

  it("o de incerto manda conferir e promete não reenviar", () => {
    const c = comentarioDeIncerto("falha de rede");
    expect(c).toContain("PODE ter chegado");
    expect(c).toContain("NÃO vai reenviar");
  });

  it("o de falha diz que será tentado de novo", () => {
    expect(comentarioDeFalha("a tarefa não tem CELULAR válido")).toContain("tentado de novo");
  });

  it("a nota interna aponta a tarefa", () => {
    expect(notaDaConversa("https://app.clickup.com/t/t1")).toContain("https://app.clickup.com/t/t1");
    expect(notaDaConversa(null)).not.toContain("Tarefa:");
  });
});

describe("horário comercial", () => {
  it("segunda a sexta, 8h às 18h em São Paulo", () => {
    expect(dentroDoHorarioComercial(new Date("2026-11-16T13:00:00Z"))).toBe(true); // seg 10h
    expect(dentroDoHorarioComercial(new Date("2026-11-16T10:59:00Z"))).toBe(false); // seg 7h59
    expect(dentroDoHorarioComercial(new Date("2026-11-20T21:00:00Z"))).toBe(false); // sex 18h
    expect(dentroDoHorarioComercial(new Date("2026-11-22T13:00:00Z"))).toBe(false); // dom 10h
  });
});

describe("recusa do Chatwoot", () => {
  it("4xx é recusa clara, menos 408 e 429 (tente depois); 5xx não é", () => {
    expect(ehRecusaClara(422)).toBe(true);
    expect(ehRecusaClara(404)).toBe(true);
    expect(ehRecusaClara(408)).toBe(false);
    expect(ehRecusaClara(429)).toBe(false);
    expect(ehRecusaClara(500)).toBe(false);
    expect(ehRecusaClara(200)).toBe(false);
  });
});

describe("dadosDoFormulario", () => {
  const atual = { whatsappAtribuirA: "Felipe", whatsappTexto: null };
  const form = (campos: Record<string, string>) => (c: string) => campos[c] ?? null;

  it("sem os campos no formulário, fica como estava", () => {
    expect(dadosDoFormulario(form({}), atual)).toEqual({ atribuirA: "Felipe", texto: null });
    expect(
      dadosDoFormulario(form({}), { whatsappAtribuirA: "Ana", whatsappTexto: "texto antigo ".padEnd(50, "x") }),
    ).toEqual({ atribuirA: "Ana", texto: "texto antigo ".padEnd(50, "x") });
  });

  it("texto igual ao padrão, ou em branco, volta a seguir o padrão (nulo)", () => {
    expect(
      dadosDoFormulario(form({ whatsappAtribuirA: "Felipe", whatsappTexto: TEXTO_PADRAO_ONE.replace(/\n/g, "\r\n") }), atual),
    ).toEqual({ atribuirA: "Felipe", texto: null });
    expect(dadosDoFormulario(form({ whatsappAtribuirA: "Felipe", whatsappTexto: "  " }), atual)).toEqual({
      atribuirA: "Felipe",
      texto: null,
    });
  });

  it("texto novo é gravado; marcador desconhecido é recusado", () => {
    const novo = "Olá {responsavel}, avisamos do reajuste do seu contrato.";
    expect(dadosDoFormulario(form({ whatsappAtribuirA: "Felipe", whatsappTexto: novo }), atual)).toEqual({
      atribuirA: "Felipe",
      texto: novo,
    });
    expect(
      "erro" in dadosDoFormulario(form({ whatsappAtribuirA: "Felipe", whatsappTexto: "Olá {nome}, tudo bem? ".padEnd(60, "x") }), atual),
    ).toBe(true);
  });

  it("quem recebe a conversa não pode ficar em branco nem passar de 80 caracteres", () => {
    expect("erro" in dadosDoFormulario(form({ whatsappAtribuirA: "  " }), atual)).toBe(true);
    expect("erro" in dadosDoFormulario(form({ whatsappAtribuirA: "x".repeat(81) }), atual)).toBe(true);
    expect(ATRIBUIR_A_PADRAO).toBe("Felipe");
  });
});
